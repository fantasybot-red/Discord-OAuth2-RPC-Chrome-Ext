import { createDiscordApi } from '../lib/discord-api.ts'
import type { SocketFactory } from '../lib/gateway.ts'
import { getDiagnosticLogger } from '../lib/diagnostics.ts'
import { isCommand, isDiagnosticCommand } from '../shared/messages.ts'
import type { DiagnosticResponse } from '../shared/messages.ts'
import { AssetCache } from './asset-cache.ts'
import { Controller } from './controller.ts'
import { isSenderAllowed } from './sender.ts'
import type { StorageLike } from './storage.ts'
import { Tracker } from './tracker.ts'

const storage: StorageLike = {
  get: (keys) => chrome.storage.local.get(keys),
  set: (items) => chrome.storage.local.set(items),
  remove: (keys) => chrome.storage.local.remove(keys),
}

const socketFactory: SocketFactory = (url, handlers) => {
  const ws = new WebSocket(url)
  ws.onopen = () => handlers.onOpen()
  ws.onmessage = (event) => handlers.onMessage(event.data)
  ws.onerror = () => handlers.onError()
  ws.onclose = (event) => handlers.onClose(event.code, event.reason)
  return {
    send: (data) => ws.send(data),
    close: (code, reason) => ws.close(code, reason),
  }
}

const logger = getDiagnosticLogger({
  local: {
    get: (keys) => chrome.storage.local.get(keys),
    set: (items) => chrome.storage.local.set(items),
  },
  session: {
    get: (keys) => chrome.storage.session.get(keys),
    set: (items) => chrome.storage.session.set(items),
  },
})

const controller = new Controller({
  diagnostic: (event, details) => logger.record(event, details),
  storage,
  assetCache: new AssetCache({
    get: (keys) => chrome.storage.session.get(keys),
    set: (items) => chrome.storage.session.set(items),
  }),
  api: createDiscordApi({ now: () => Date.now() }),
  clock: {
    now: () => Date.now(),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  },
  random: () => Math.random(),
  socketFactory,
  alarms: {
    create: (name, info) => chrome.alarms.create(name, info),
    clear: (name) => chrome.alarms.clear(name),
  },
  openTab: async (url) => {
    await chrome.tabs.create({ url })
  },
  redirectUri: chrome.runtime.getURL('callback.html'),
})

// ---- browser tracking -----------------------------------------------------

const clock = {
  now: () => Date.now(),
  setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
  clearTimeout: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

const tracker = new Tracker({
  api: {
    getWindows: () => chrome.windows.getAll({ populate: true, windowTypes: ['normal'] }),
    // No populate: only type/incognito/focused, never tab data.
    getWindow: (windowId) => chrome.windows.get(windowId).then((w) => w ?? null),
    sessionGet: async (key) => (await chrome.storage.session.get(key))[key],
    sessionSet: (key, value) => chrome.storage.session.set({ [key]: value }),
  },
  clock,
  emit: (context) => controller.updateBrowserContext(context),
})

function syncTracking(): void {
  tracker.setEnabled(controller.trackingEnabled)
  updateActionTitle()
}

function updateActionTitle(): void {
  let title = 'Discord presence: off (open side panel)'
  if (controller.trackingEnabled) {
    if (controller.presenceShown) {
      title = 'Discord presence: showing your active tab (open side panel)'
    } else {
      title = 'Discord presence: on, nothing shown (not connected, no activity, or Chrome is not focused)'
    }
  }
  try {
    void chrome.action.setTitle({ title })
  } catch {
    /* action API unavailable */
  }
}

// Clear any badge left by a previous version, even if initialization fails.
try {
  void chrome.action.setBadgeText({ text: '' })
} catch {
  /* action API unavailable */
}
updateActionTitle()
controller.onChange(syncTracking)

// Registered synchronously so Chrome can wake the worker for each event.
chrome.windows.onFocusChanged.addListener((windowId) => {
  void ready.then(() => {
    logger.record('browser_event', {
      eventKind: 'focus',
      source: 'chrome',
      phase: 'received',
      focused: windowId !== chrome.windows.WINDOW_ID_NONE,
    })
    tracker.onFocusChanged(windowId)
  })
})
chrome.windows.onRemoved.addListener(() => {
  void ready.then(() => {
    logger.record('browser_event', { eventKind: 'window_removed', source: 'chrome', phase: 'received' })
    tracker.onWindowRemoved()
  })
})
chrome.tabs.onCreated.addListener((tab) => {
  void ready.then(() => {
    logger.record('browser_event', { eventKind: 'tab_created', source: 'chrome', phase: 'received' })
    tracker.onTabCreated(tab)
  })
})
chrome.tabs.onActivated.addListener((activeInfo) => {
  void ready.then(() => {
    logger.record('browser_event', {
      eventKind: 'activation',
      source: 'chrome',
      phase: 'received',
      hasTab: typeof activeInfo?.tabId === 'number',
      hasWindow: typeof activeInfo?.windowId === 'number',
    })
    tracker.onTabActivated(activeInfo)
  })
})
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  void ready.then(() => {
    const kind =
      changeInfo.url !== undefined
        ? 'url'
        : changeInfo.title !== undefined
          ? 'title'
          : changeInfo.status !== undefined
            ? 'status'
            : changeInfo.favIconUrl !== undefined
              ? 'favicon'
              : null
    if (kind) logger.record('browser_event', { eventKind: kind, source: 'chrome', phase: 'received' })
    tracker.onTabUpdated(tabId, changeInfo)
  })
})
chrome.tabs.onRemoved.addListener((tabId) => {
  void ready.then(() => {
    logger.record('browser_event', { eventKind: 'tab_removed', source: 'chrome', phase: 'received' })
    tracker.onTabRemoved(tabId)
  })
})
chrome.tabs.onReplaced.addListener((addedTabId, removedTabId) => {
  void ready.then(() => {
    logger.record('browser_event', { eventKind: 'tab_replaced', source: 'chrome', phase: 'received' })
    tracker.onTabReplaced(addedTabId, removedTabId)
  })
})

// Chrome opens the side panel on toolbar clicks; no section, tracking or auth change.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {
  console.error('Could not enable opening the side panel from the toolbar.')
})

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    void chrome.tabs.create({ url: chrome.runtime.getURL('setup.html') }).catch(() => undefined)
  }
})

// Asynchronous init; every handler awaits it. Listeners below are registered
// synchronously at the top level so Chrome can wake the worker for them.
// Resolves to null on success, or a user-safe message if init failed.
const ready: Promise<string | null> = (async () => {
  try {
    // Fail closed: storage.local is readable by content scripts unless the
    // access level is restricted, and it holds OAuth tokens. If restricting
    // fails, nothing is read, connected or stored.
    await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' })
  } catch {
    return 'Could not restrict extension storage to trusted contexts, so the extension is disabled. Reload it or update Chrome (120+).'
  }
  try {
    // Session storage defaults to trusted contexts; set explicitly, best effort.
    await chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' })
  } catch {
    /* diagnostics contain no secrets */
  }
  try {
    await logger.init()
  } catch {
    /* diagnostics are optional */
  }
  try {
    await controller.init()
  } catch {
    return 'Could not load saved extension data. Reload the extension.'
  }
  // Tracking context is restored before anything is applied: the controller
  // sends nothing until the tracker has produced a context.
  try {
    await tracker.init()
  } catch {
    /* tracker falls back to a fresh baseline */
  }
  syncTracking()
  return null
})()

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  if (!isCommand(message)) return false
  if (!isSenderAllowed(sender, chrome.runtime.id, message.type)) {
    sendResponse({ ok: false, error: 'This sender is not allowed to control the extension.' })
    return false
  }
  if (isDiagnosticCommand(message)) {
    // Gated on `ready` so storage.local is restricted before the logger reads
    // it (fail closed: if init failed, diagnostics are unavailable too).
    void ready
      .then(async (initError): Promise<DiagnosticResponse> => {
        if (initError) return { ok: false, error: initError }
        const run =
          message.type === 'getDiagnostics'
            ? logger.get()
            : message.type === 'setDebugLogging'
              ? logger.setEnabled(message.enabled)
              : logger.clear()
        return { ok: true, diagnostics: await run }
      })
      .then(sendResponse)
      .catch(() => sendResponse({ ok: false, error: 'Could not read diagnostics.' }))
    return true
  }
  void ready
    .then((initError) => (initError ? { ok: false as const, error: initError } : controller.handle(message)))
    .then(sendResponse)
    .catch(() => sendResponse({ ok: false, error: 'Something went wrong. Try again.' }))
  return true
})

chrome.alarms.onAlarm.addListener((alarm) => {
  void ready
    .then((initError) => (initError ? undefined : controller.onAlarm(alarm.name)))
    .catch(() => undefined)
})

// Waking the worker is enough: init() resumes a persisted desired connection.
// A browser start also resets the session baseline for the browser timer.
chrome.runtime.onStartup.addListener(() => {
  void ready.then(() => tracker.onBrowserStartup()).catch(() => undefined)
})


import assert from 'node:assert/strict'
import { test } from 'node:test'
import manifest from '../manifest.config.ts'

type Listener = (...args: unknown[]) => unknown

function event() {
  const listeners: Listener[] = []
  return { listeners, addListener: (fn: Listener) => void listeners.push(fn) }
}

// Minimal chrome mock for the background worker's top-level wiring. It
// deliberately has no contextMenus, action.onClicked or sidePanel.open: touching
// any of them throws while the worker module is evaluated.
function createChrome() {
  const calls = {
    setPanelBehavior: [] as unknown[],
    tabsCreate: [] as unknown[],
    setBadgeText: [] as unknown[],
    setTitle: [] as unknown[],
  }
  const area = () => ({
    get: async () => ({}),
    set: async () => undefined,
    remove: async () => undefined,
    setAccessLevel: async () => undefined,
  })
  const chrome = {
    storage: { local: area(), session: area() },
    runtime: {
      id: 'test-extension-id',
      getURL: (path: string) => `chrome-extension://test-extension-id/${path}`,
      onMessage: event(),
      onInstalled: event(),
      onStartup: event(),
    },
    alarms: { create: async () => undefined, clear: async () => true, onAlarm: event() },
    tabs: {
      create: async (options: unknown) => void calls.tabsCreate.push(options),
      onCreated: event(),
      onActivated: event(),
      onUpdated: event(),
      onRemoved: event(),
      onReplaced: event(),
    },
    windows: {
      WINDOW_ID_NONE: -1,
      getAll: async () => [],
      get: async () => undefined,
      onFocusChanged: event(),
      onRemoved: event(),
    },
    action: {
      setBadgeText: async (details: unknown) => void calls.setBadgeText.push(details),
      setTitle: async (details: unknown) => void calls.setTitle.push(details),
    },
    sidePanel: {
      setPanelBehavior: async (behavior: unknown) => void calls.setPanelBehavior.push(behavior),
    },
  }
  return { chrome, calls }
}

async function loadWorker() {
  const { chrome, calls } = createChrome()
  ;(globalThis as { chrome?: unknown }).chrome = chrome
  const entry = new URL('../src/background/index.ts', import.meta.url).href
  await import(`${entry}?sidebar-action-${Math.random()}`)
  // Let worker init (storage defaults: tracking off, no credentials) settle.
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve))
  return { chrome, calls }
}

test('toolbar opens the side panel through Chrome behavior, not a click handler or context menu', async () => {
  const { calls } = await loadWorker()
  assert.deepEqual(calls.setPanelBehavior, [{ openPanelOnActionClick: true }])
  assert.deepEqual(calls.tabsCreate, [], 'loading the worker opens no tabs')
})

test('onInstalled opens the setup page only on first install', async () => {
  const { chrome, calls } = await loadWorker()
  const [onInstalled] = chrome.runtime.onInstalled.listeners
  assert.equal(chrome.runtime.onInstalled.listeners.length, 1)

  for (const reason of ['update', 'chrome_update', 'shared_module_update']) {
    onInstalled({ reason })
  }
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(calls.tabsCreate, [])

  onInstalled({ reason: 'install' })
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(calls.tabsCreate, [{ url: 'chrome-extension://test-extension-id/setup.html' }])
})

test('worker startup only clears the badge and sets a side-panel title', async () => {
  const { calls } = await loadWorker()
  assert.deepEqual(calls.setBadgeText, [{ text: '' }])
  assert.ok(calls.setTitle.length >= 1)
  for (const call of calls.setTitle) {
    assert.match((call as { title: string }).title, /^Discord presence: /)
    assert.doesNotMatch((call as { title: string }).title, /settings/)
  }
})

test('manifest no longer requests contextMenus and keeps the side panel', () => {
  assert.ok(!manifest.permissions?.includes('contextMenus'))
  assert.ok(manifest.permissions?.includes('sidePanel'))
  assert.equal(manifest.side_panel?.default_path, 'src/sidepanel/index.html')
  assert.equal(manifest.action?.default_title, 'Discord presence: open side panel')
  assert.equal('default_popup' in (manifest.action ?? {}), false)
})

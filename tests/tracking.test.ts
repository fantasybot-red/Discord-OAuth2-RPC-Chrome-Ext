import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Tracker, TRACKER_DEBOUNCE_MS, TRACKER_SESSION_KEY, WINDOW_ID_NONE } from '../src/background/tracker.ts'
import type { TabLike, WindowLike } from '../src/background/tracker.ts'
import { Controller, PRESENCE_MIN_INTERVAL_MS } from '../src/background/controller.ts'
import type { StorageLike } from '../src/background/storage.ts'
import { parseTracking, parseTrackingStrict } from '../src/background/storage.ts'
import type { DiscordApi } from '../src/lib/discord-api.ts'
import type { Clock, SocketHandlers } from '../src/lib/gateway.ts'
import { isCommand, MESSAGE_NAMESPACE } from '../src/shared/messages.ts'
import { DEFAULT_TRACKING } from '../src/shared/types.ts'
import type { BrowserContext } from '../src/shared/types.ts'

const NOW0 = 2_000_000
const ID = 'd'.repeat(32)
const APP = '123456789012345678'

class FakeClock implements Clock {
  t = NOW0
  private id = 0
  timers = new Map<number, { at: number; fn: () => void }>()
  now() {
    return this.t
  }
  setTimeout(fn: () => void, ms: number) {
    const id = ++this.id
    this.timers.set(id, { at: this.t + ms, fn })
    return id
  }
  clearTimeout(handle: unknown) {
    this.timers.delete(handle as number)
  }
  advance(ms: number) {
    this.t += ms
    for (const [id, timer] of [...this.timers].sort((a, b) => a[1].at - b[1].at)) {
      if (timer.at <= this.t && this.timers.has(id)) {
        this.timers.delete(id)
        timer.fn()
      }
    }
  }
}

const tick = async (n = 20) => {
  for (let i = 0; i < n; i++) await new Promise<void>((r) => setImmediate(r))
}

// ---- tracker fixtures -------------------------------------------------------

function tab(id: number, url: string, extra: Partial<TabLike> = {}): TabLike {
  return { id, url, title: `T${id}`, active: false, favIconUrl: '', ...extra }
}

interface TrackerRig {
  t: Tracker
  clock: FakeClock
  windows: WindowLike[]
  emitted: Array<BrowserContext | null>
  session: Map<string, unknown>
  /** Holds getWindows results until released (async race tests). */
  pendingQueries: Array<(w: WindowLike[]) => void>
  /** Overrides chrome.windows.get(id) results (windows absent from getAll, e.g. incognito/popup). */
  windowInfo: Map<number, WindowLike>
  hold: boolean
  queries: number
  last(): BrowserContext | null
}

function makeTracker(session?: Map<string, unknown>, clock?: FakeClock): TrackerRig {
  const rig = {
    clock: clock ?? new FakeClock(),
    windows: [] as WindowLike[],
    emitted: [] as Array<BrowserContext | null>,
    session: session ?? new Map<string, unknown>(),
    pendingQueries: [] as Array<(w: WindowLike[]) => void>,
    windowInfo: new Map<number, WindowLike>(),
    hold: false,
    queries: 0,
  } as TrackerRig
  rig.t = new Tracker({
    clock: rig.clock,
    emit: (c) => void rig.emitted.push(c),
    api: {
      getWindows: () => {
        rig.queries += 1
        const snapshot = structuredClone(rig.windows)
        if (!rig.hold) return Promise.resolve(snapshot)
        return new Promise<WindowLike[]>((resolve) => rig.pendingQueries.push(resolve)).then(() => snapshot)
      },
      // Window metadata only (no tabs), like chrome.windows.get(id) without populate.
      getWindow: async (id) => {
        const found = rig.windowInfo.get(id) ?? rig.windows.find((w) => w.id === id)
        if (!found) return null
        const { tabs: _tabs, ...info } = found
        return structuredClone(info)
      },
      sessionGet: async (key) => structuredClone(rig.session.get(key)),
      sessionSet: async (key, value) => void rig.session.set(key, structuredClone(value)),
    },
  })
  rig.last = () => rig.emitted.at(-1) ?? null
  return rig
}

const normalWindow = (id: number, tabs: TabLike[], extra: Partial<WindowLike> = {}): WindowLike => ({
  id,
  type: 'normal',
  focused: false,
  incognito: false,
  tabs: tabs.map((t) => ({ ...t, windowId: id })),
  ...extra,
})

async function settle(rig: TrackerRig) {
  rig.clock.advance(TRACKER_DEBOUNCE_MS + 1)
  await tick()
}

// ---- tracker tests ------------------------------------------------------------

test('tracker reads nothing while disabled and withdraws context when disabled', async () => {
  const rig = makeTracker()
  rig.windows = [normalWindow(1, [tab(1, 'https://a.test/', { active: true })], { focused: true })]
  rig.t.onTabCreated(tab(1, 'https://a.test/'))
  rig.t.onTabActivated()
  rig.t.onFocusChanged(1)
  await settle(rig)
  assert.equal(rig.queries, 0)
  assert.deepEqual(rig.emitted, [])
  rig.t.setEnabled(true)
  await settle(rig)
  assert.equal(rig.queries, 1)
  assert.equal(rig.last()?.trackable, true)
  rig.t.setEnabled(false)
  assert.equal(rig.last(), null)
  rig.t.onTabActivated()
  await settle(rig)
  assert.equal(rig.queries, 1, 'no queries after disabling')
})

test('focused normal window: metadata, counts, hostname, origin', async () => {
  const rig = makeTracker()
  rig.windows = [
    normalWindow(1, [tab(1, 'https://docs.example.com/a?token=1', { active: true, title: ' Doc ', favIconUrl: 'https://docs.example.com/f.ico' }), tab(2, 'https://b.test/')], { focused: true }),
    normalWindow(2, [tab(3, 'https://c.test/', { active: true })]),
  ]
  rig.t.setEnabled(true)
  await settle(rig)
  const c = rig.last()!
  assert.equal(c.focused, true)
  assert.equal(c.trackable, true)
  assert.equal(c.tabTitle, 'Doc')
  assert.equal(c.tabHostname, 'docs.example.com')
  assert.equal(c.tabOrigin, 'https://docs.example.com')
  assert.equal(c.tabFavicon, 'https://docs.example.com/f.ico')
  assert.equal(c.tabCount, 3)
  assert.equal(c.windowCount, 2)
  assert.equal(c.windowTabCount, 2)
  assert.equal(c.browserStartedAt, rig.clock.now(), 'no session baseline yet: first start = now')
})

test('incognito windows/tabs and internal/special pages are never trackable or counted', async () => {
  const rig = makeTracker()
  rig.windows = [
    normalWindow(1, [tab(1, 'https://secret.test/', { active: true })], { focused: true, incognito: true }),
    normalWindow(2, [tab(2, 'https://ok.test/', { active: true })]),
  ]
  rig.t.setEnabled(true)
  await settle(rig)
  let c = rig.last()!
  assert.equal(c.focused, true)
  assert.equal(c.trackable, false, 'focused incognito window')
  assert.equal(c.tabTitle, '')
  assert.equal(c.tabCount, 1, 'incognito tabs are not counted')
  assert.equal(c.windowCount, 1)

  for (const url of ['chrome://settings', 'chrome-extension://abc/page.html', 'devtools://devtools/x', 'about:blank', 'file:///c:/a.txt', 'view-source:https://a.test', 'data:text/html,hi', undefined]) {
    rig.windows = [normalWindow(1, [tab(1, url as string, { active: true, title: 'Private title' })], { focused: true })]
    rig.t.onTabUpdated(1, { url: 'x' })
    await settle(rig)
    c = rig.last()!
    assert.equal(c.focused, true, String(url))
    // Product policy (changed): non-web pages are title-only trackable; never URL/origin/host/icon.
    assert.equal(c.trackable, true, String(url))
    assert.equal(c.tabTitle, 'Private title')
    assert.equal(c.tabUrl, '')
    assert.equal(c.tabOrigin, '')
    assert.equal(c.tabHostname, '')
    assert.equal(c.tabFavicon, '')
  }
  // Non-normal (popup/devtools) windows are ignored entirely.
  rig.windows = [{ id: 5, type: 'popup', focused: true, tabs: [tab(9, 'https://p.test/', { active: true })] }, normalWindow(1, [tab(1, 'https://a.test/', { active: true })])]
  rig.t.onFocusChanged(5)
  await settle(rig)
  assert.equal(rig.last()!.trackable, false)
})

test('losing focus hides immediately and a late query cannot restore it', async () => {
  const rig = makeTracker()
  rig.windows = [normalWindow(1, [tab(1, 'https://a.test/', { active: true })], { focused: true })]
  rig.t.setEnabled(true)
  await settle(rig)
  assert.equal(rig.last()!.trackable, true)

  // A tab event starts a query that stays in flight...
  rig.hold = true
  rig.t.onTabUpdated(1, { title: 'x' })
  rig.clock.advance(TRACKER_DEBOUNCE_MS + 1)
  await tick()
  assert.equal(rig.pendingQueries.length, 1)
  // ...focus is lost: the unfocused state is published now, synchronously. The
  // tracker carries the last eligible tab (trackable) and the controller's
  // hideOnUnfocus (default true) decides it stays hidden.
  rig.t.onFocusChanged(WINDOW_ID_NONE)
  assert.equal(rig.last()!.focused, false)
  assert.equal(rig.last()!.trackable, true, 'last eligible tab is retained in memory')
  assert.equal(rig.last()!.tabTitle, 'T1')
  const before = rig.emitted.length
  // The stale query resolves with a still-"focused" window: must be discarded.
  rig.pendingQueries.forEach((r) => r([]))
  await tick()
  assert.equal(rig.emitted.length, before, 'stale result discarded')
  assert.equal(rig.last()!.focused, false)

  // Another tab event while unfocused must still not restore anything.
  rig.hold = false
  rig.t.onTabActivated()
  await settle(rig)
  assert.equal(rig.last()!.focused, false, 'getAll reports focused:true but WINDOW_ID_NONE wins')

  // Refocus restores the *current* active tab.
  rig.windows = [normalWindow(1, [tab(1, 'https://a.test/'), tab(2, 'https://new.test/', { active: true, title: 'New' })], { focused: true })]
  rig.t.onFocusChanged(1)
  await settle(rig)
  assert.equal(rig.last()!.focused, true)
  assert.equal(rig.last()!.tabTitle, 'New')
})

test('late query results from older tickets are dropped in favour of the newest', async () => {
  const rig = makeTracker()
  rig.windows = [normalWindow(1, [tab(1, 'https://old.test/', { active: true, title: 'Old' })], { focused: true })]
  rig.t.setEnabled(true)
  rig.hold = true
  await settle(rig) // query #1 pending
  rig.windows = [normalWindow(1, [tab(1, 'https://old.test/'), tab(2, 'https://new.test/', { active: true, title: 'New' })], { focused: true })]
  rig.t.onTabActivated()
  await settle(rig) // query #2 pending
  assert.equal(rig.pendingQueries.length, 2)
  // Resolve newest first, then the stale one.
  rig.pendingQueries[1]([])
  await tick()
  rig.pendingQueries[0]([])
  await tick()
  assert.equal(rig.emitted.filter(Boolean).length, 1)
  assert.equal(rig.last()!.tabTitle, 'New')
})

test('an event invalidates an in-flight read immediately (no publish during the debounce window)', async () => {
  const rig = makeTracker()
  rig.windows = [normalWindow(1, [tab(1, 'https://old.test/', { active: true, title: 'Old' })], { focused: true })]
  rig.t.setEnabled(true)
  await settle(rig)
  assert.equal(rig.last()!.tabTitle, 'Old')

  rig.hold = true
  rig.t.onTabUpdated(1, { title: 'x' })
  rig.clock.advance(TRACKER_DEBOUNCE_MS + 1)
  await tick()
  assert.equal(rig.pendingQueries.length, 1, 'query 1 in flight')
  const before = rig.emitted.length
  // Activation happens while query 1 is pending; the follow-up read is still debounced.
  rig.windows = [normalWindow(1, [tab(1, 'https://old.test/'), tab(2, 'https://new.test/', { active: true, title: 'New' })], { focused: true })]
  rig.t.onTabActivated()
  rig.pendingQueries[0]([])
  await tick()
  assert.equal(rig.emitted.length, before, 'stale query 1 result is dropped before read 2 runs')
  rig.hold = false
  await settle(rig)
  assert.equal(rig.last()!.tabTitle, 'New')
})

test('read failure fails closed instead of leaving the previous tab published', async () => {
  const rig = makeTracker()
  rig.windows = [normalWindow(1, [tab(1, 'https://a.test/', { active: true, title: 'Visible' })], { focused: true })]
  rig.t.setEnabled(true)
  await settle(rig)
  assert.equal(rig.last()!.tabTitle, 'Visible')
  const failing = new Tracker({
    clock: rig.clock,
    emit: (c) => void rig.emitted.push(c),
    api: {
      getWindows: async () => {
        throw new Error('windows API failed')
      },
      sessionGet: async () => undefined,
      sessionSet: async () => undefined,
    },
  })
  failing.setEnabled(true)
  await settle(rig)
  const c = rig.last()!
  assert.equal(c.trackable, false)
  assert.equal(c.tabTitle, '')
  assert.equal(c.tabUrl, '')
})

test('focus change withdraws the previous tab immediately, before the debounced read', async () => {
  const rig = makeTracker()
  rig.windows = [
    normalWindow(1, [tab(1, 'https://a.test/', { active: true, title: 'Normal' })], { focused: true }),
    normalWindow(2, [tab(2, 'https://secret.test/', { active: true })], { incognito: true }),
  ]
  rig.t.setEnabled(true)
  await settle(rig)
  assert.equal(rig.last()!.tabTitle, 'Normal')
  rig.windows = [
    normalWindow(1, [tab(1, 'https://a.test/', { active: true, title: 'Normal' })]),
    normalWindow(2, [tab(2, 'https://secret.test/', { active: true, title: 'Secret' })], { focused: true, incognito: true }),
  ]
  rig.t.onFocusChanged(2)
  assert.equal(rig.last()!.tabTitle, '', 'withdrawn synchronously')
  assert.equal(rig.last()!.trackable, false)
  await settle(rig)
  assert.equal(rig.last()!.trackable, false, 'incognito focus stays hidden')
  assert.equal(rig.last()!.tabTitle, '')
})

test('session writes are serialized: a slow old write cannot overwrite a newer browser-startup reset', async () => {
  const rig = makeTracker()
  const writes: Array<{ value: any; release: () => void }> = []
  const applied: any[] = []
  const slow = new Tracker({
    clock: rig.clock,
    emit: () => undefined,
    api: {
      getWindows: async () => structuredClone(rig.windows),
      sessionGet: async () => undefined,
      sessionSet: (_k, value) =>
        new Promise<void>((resolve) => {
          writes.push({ value: structuredClone(value), release: () => (applied.push(structuredClone(value)), resolve()) })
        }),
    },
  })
  rig.windows = [normalWindow(1, [tab(1, 'https://a.test/', { active: true })], { focused: true })]
  slow.setEnabled(true)
  rig.clock.advance(TRACKER_DEBOUNCE_MS + 1)
  await tick()
  assert.equal(writes.length, 1)
  const startup = slow.onBrowserStartup()
  await tick()
  assert.equal(writes.length, 1, 'second write waits for the first')
  writes[0].release()
  await tick()
  writes[1].release()
  await startup
  rig.clock.advance(TRACKER_DEBOUNCE_MS + 1)
  await tick()
  for (let i = 2; i < writes.length; i++) writes[i].release()
  await tick()
  const first = applied[0]
  const reset = applied[1]
  assert.ok(reset.browserStartedAt >= first.browserStartedAt)
  assert.deepEqual(reset.opened, {}, 'reset write lands after, not before, the old snapshot')
})

test('events are debounced into one query', async () => {
  const rig = makeTracker()
  rig.windows = [normalWindow(1, [tab(1, 'https://a.test/', { active: true })], { focused: true })]
  rig.t.setEnabled(true)
  await settle(rig)
  const q = rig.queries
  for (let i = 0; i < 10; i++) rig.t.onTabUpdated(1, { title: `t${i}` })
  rig.clock.advance(TRACKER_DEBOUNCE_MS - 10)
  await tick()
  assert.equal(rig.queries, q)
  rig.clock.advance(20)
  await tick()
  assert.equal(rig.queries, q + 1)
})

test('timers: navigation keeps tabOpenedAt; activation changes tabActiveAt only when the tab changes', async () => {
  const rig = makeTracker()
  rig.windows = [normalWindow(1, [tab(1, 'https://a.test/', { active: true })], { focused: true })]
  rig.t.setEnabled(true)
  await settle(rig)
  const first = rig.last()!
  assert.equal(first.tabOpenedAt, rig.clock.now(), 'existing tab: first observed (not lastAccessed)')
  const activeAt = first.tabActiveAt

  // Same tab navigates later: neither timestamp moves.
  rig.clock.advance(60_000)
  rig.windows = [normalWindow(1, [tab(1, 'https://a.test/next', { active: true })], { focused: true })]
  rig.t.onTabUpdated(1, { url: 'https://a.test/next' })
  await settle(rig)
  assert.equal(rig.last()!.tabOpenedAt, first.tabOpenedAt)
  assert.equal(rig.last()!.tabActiveAt, activeAt)

  // A tab created through onCreated gets the real creation time.
  rig.clock.advance(10_000)
  const created = rig.clock.now()
  rig.t.onTabCreated(tab(2, 'https://b.test/'))
  rig.clock.advance(5_000)
  rig.windows = [normalWindow(1, [tab(1, 'https://a.test/next'), tab(2, 'https://b.test/', { active: true })], { focused: true })]
  rig.t.onTabActivated()
  await settle(rig)
  assert.equal(rig.last()!.tabOpenedAt, created)
  assert.ok(rig.last()!.tabActiveAt > activeAt, 'new active tab restarts the active timer')
  assert.equal(rig.last()!.browserStartedAt, first.browserStartedAt, 'browser baseline is stable')

  // Re-activation event for the same tab does not reset the active timestamp.
  const activeAt2 = rig.last()!.tabActiveAt
  rig.clock.advance(30_000)
  rig.t.onTabActivated()
  await settle(rig)
  assert.equal(rig.last()!.tabActiveAt, activeAt2)
})

test('onTabReplaced keeps the logical tab timestamps; removed tabs are forgotten', async () => {
  const rig = makeTracker()
  rig.windows = [normalWindow(1, [tab(1, 'https://a.test/', { active: true })], { focused: true })]
  rig.t.setEnabled(true)
  await settle(rig)
  const opened = rig.last()!.tabOpenedAt
  const activeAt = rig.last()!.tabActiveAt
  rig.clock.advance(5000)
  rig.windows = [normalWindow(1, [tab(7, 'https://a.test/', { active: true })], { focused: true })]
  rig.t.onTabReplaced(7, 1)
  await settle(rig)
  assert.equal(rig.last()!.tabOpenedAt, opened)
  assert.equal(rig.last()!.tabActiveAt, activeAt)
  rig.t.onTabRemoved(7)
  assert.equal(JSON.stringify([...rig.session.values()]).includes('"7"'), true, 'session map saved earlier; removed entry is dropped on next save')
})

test('session storage holds only numeric ids/timestamps and restores across worker restart', async () => {
  const rig = makeTracker()
  rig.windows = [normalWindow(1, [tab(1, 'https://secret.example/path?q=1', { active: true, title: 'Very private title' })], { focused: true })]
  rig.t.setEnabled(true)
  await settle(rig)
  const saved = JSON.stringify(rig.session.get(TRACKER_SESSION_KEY))
  assert.ok(!saved.includes('secret.example'))
  assert.ok(!saved.includes('private'))
  assert.ok(!saved.includes('http'))
  const first = rig.last()!

  // Worker restart (same browser session): baseline and tab times survive.
  rig.clock.advance(120_000)
  const again = makeTracker(rig.session, rig.clock)
  again.windows = rig.windows
  again.t.setEnabled(true)
  await settle(again)
  assert.equal(again.last()!.browserStartedAt, first.browserStartedAt)
  assert.equal(again.last()!.tabOpenedAt, first.tabOpenedAt)
  assert.equal(again.last()!.tabActiveAt, first.tabActiveAt, 'same active tab id: timestamp preserved')

  // Browser restart: baseline is reset and per-tab times are forgotten.
  const later = rig.clock.now()
  await again.t.onBrowserStartup()
  again.clock.advance(TRACKER_DEBOUNCE_MS + 1)
  await tick()
  assert.equal(again.last()!.browserStartedAt, later)
  assert.ok(again.last()!.tabOpenedAt >= later)
})

test('session storage failures do not break tracking', async () => {
  const rig = makeTracker()
  rig.windows = [normalWindow(1, [tab(1, 'https://a.test/', { active: true })], { focused: true })]
  const broken = new Tracker({
    clock: rig.clock,
    emit: (c) => void rig.emitted.push(c),
    api: {
      getWindows: async () => structuredClone(rig.windows),
      sessionGet: async () => {
        throw new Error('no session')
      },
      sessionSet: async () => {
        throw new Error('no session')
      },
    },
  })
  broken.setEnabled(true)
  await settle(rig)
  assert.equal(rig.last()?.trackable, true)
})

// ---- controller integration ---------------------------------------------------

class MemStorage implements StorageLike {
  data: Record<string, unknown> = {}
  async get(keys: string[]) {
    const out: Record<string, unknown> = {}
    for (const k of keys) if (k in this.data) out[k] = structuredClone(this.data[k])
    return out
  }
  async set(items: Record<string, unknown>) {
    for (const [k, v] of Object.entries(items)) this.data[k] = structuredClone(v)
  }
  async remove(keys: string[]) {
    for (const k of keys) delete this.data[k]
  }
}

class FakeSocket {
  sent: Array<{ op: number; d: any }> = []
  h: SocketHandlers
  constructor(_url: string, h: SocketHandlers) {
    this.h = h
  }
  send(data: string) {
    this.sent.push(JSON.parse(data))
  }
  close() {}
  server(packet: unknown) {
    this.h.onMessage(JSON.stringify(packet))
  }
}

const CTX: BrowserContext = {
  focused: true,
  trackable: true,
  tabTitle: 'Hello',
  tabUrl: 'https://example.com/secret/path',
  tabOrigin: 'https://example.com',
  tabHostname: 'example.com',
  tabFavicon: '',
  tabCount: 4,
  windowCount: 2,
  windowTabCount: 3,
  browserStartedAt: NOW0 - 10_000,
  tabOpenedAt: NOW0 - 5_000,
  tabActiveAt: NOW0 - 1_000,
}

const ACTIVITY = { name: 'Browsing', type: 0 as const, details: 'on {tab_hostname}', state: '{tab_count} tabs', largeImage: '', largeText: '', smallImage: '', smallText: '' }

async function makeController(prefilled: Record<string, unknown> = {}) {
  const storage = new MemStorage()
  storage.data = {
    settings: { clientId: APP, clientSecret: '' },
    credentials: { accessToken: 'tok', refreshToken: 'ref', expiresAt: NOW0 + 3_600_000, scope: 'openid', clientId: APP },
    desired: true,
    activity: ACTIVITY,
    activityEnabled: true,
    ...prefilled,
  }
  const clock = new FakeClock()
  const sockets: FakeSocket[] = []
  const api: DiscordApi = {
    exchangeCode: async () => {
      throw new Error('unused')
    },
    refresh: async () => {
      throw new Error('unused')
    },
    getUser: async () => ({ id: '1', username: 'u', avatar: null }),
    resolveExternalAssets: async () => new Map(),
  }
  const c = new Controller({
    storage,
    api,
    clock,
    random: () => 0.5,
    socketFactory: (url, h) => {
      const s = new FakeSocket(url, h)
      sockets.push(s)
      return s
    },
    alarms: { create: () => undefined, clear: () => undefined },
    openTab: async () => undefined,
    redirectUri: `chrome-extension://${ID}/callback.html`,
  })
  await c.init()
  await tick()
  // Without credentials the controller opens no socket.
  const socket = sockets[0] as FakeSocket | undefined
  socket?.server({ op: 10, d: { heartbeat_interval: 41250 } })
  socket?.server({ op: 0, t: 'READY', s: 1, d: { session_id: 'sess', user: { id: '1', username: 'u', avatar: null } } })
  await tick()
  const presences = () => (socket?.sent ?? []).filter((p) => p.op === 3).map((p) => p.d.activities as any[])
  return { c, storage, clock, socket, sockets, presences }
}

const TRACK_ON = { ...DEFAULT_TRACKING, enabled: true }

test('tracking OFF never publishes even with a saved enabled activity', async () => {
  const rig = await makeController()
  rig.c.updateBrowserContext(CTX)
  await tick()
  rig.clock.advance(5000)
  await tick()
  assert.deepEqual(rig.presences(), [])
  assert.equal(rig.c.presenceShown, false)
})

test('toggle ON renders templates from the focused tab; OFF clears but keeps tokens and connection', async () => {
  const rig = await makeController()
  rig.c.updateBrowserContext(CTX)
  await rig.c.toggleTracking()
  await tick()
  const shown = rig.presences().at(-1)!
  assert.equal(shown.length, 1)
  assert.equal(shown[0].details, 'on example.com')
  assert.equal(shown[0].state, '4 tabs')
  assert.equal(shown[0].application_id, APP)
  assert.equal(rig.c.presenceShown, true)
  assert.equal(rig.c.snapshot().tracking.enabled, true)
  assert.equal(rig.storage.data.tracking && (rig.storage.data.tracking as any).enabled, true)

  const snap = await rig.c.toggleTracking()
  await tick()
  assert.deepEqual(rig.presences().at(-1), [], 'presence cleared when turned off')
  assert.equal(snap.tracking.enabled, false)
  assert.equal(snap.connection, 'connected', 'OAuth connection stays alive')
  assert.equal(snap.hasCredentials, true)
  assert.notEqual(rig.storage.data.credentials, null)
  assert.equal(rig.storage.data.desired, true)
  assert.equal(rig.c.presenceShown, false)
})

test('unfocused window or untrackable tab hides entirely; refocus restores the new tab', async () => {
  const rig = await makeController({ tracking: TRACK_ON })
  rig.c.updateBrowserContext(CTX)
  await tick()
  assert.equal(rig.presences().at(-1)![0].details, 'on example.com')

  // Focus lost: immediate clear, not rate limited, no "inactive" text published.
  rig.c.updateBrowserContext({ ...CTX, focused: false, trackable: false, tabTitle: '', tabHostname: '' })
  await tick()
  assert.deepEqual(rig.presences().at(-1), [])
  assert.ok(!JSON.stringify(rig.presences()).toLowerCase().includes('not active'))
  const sentWhileHidden = rig.presences().length

  // Events while hidden must not send anything.
  rig.c.updateBrowserContext({ ...CTX, focused: false, trackable: false })
  await tick()
  assert.equal(rig.presences().length, sentWhileHidden)

  // Refocus on a different tab (after the rate-limit window).
  rig.clock.advance(PRESENCE_MIN_INTERVAL_MS + 1)
  rig.c.updateBrowserContext({ ...CTX, tabHostname: 'other.test' })
  await tick()
  assert.equal(rig.presences().at(-1)![0].details, 'on other.test')

  // Focused internal page: hidden too.
  rig.c.updateBrowserContext({ ...CTX, trackable: false, tabHostname: '' })
  await tick()
  assert.deepEqual(rig.presences().at(-1), [])
  // Null context (tracker unavailable): hidden.
  rig.clock.advance(PRESENCE_MIN_INTERVAL_MS + 1)
  rig.c.updateBrowserContext(CTX)
  await tick()
  rig.c.updateBrowserContext(null)
  await tick()
  assert.deepEqual(rig.presences().at(-1), [])
})

test('rapid tab changes are coalesced: latest render wins, never stale, within the rate limit', async () => {
  const rig = await makeController({ tracking: TRACK_ON })
  rig.c.updateBrowserContext({ ...CTX, tabHostname: 'first.test' })
  await tick()
  const base = rig.presences().length
  assert.equal(base, 1)
  for (const host of ['a.test', 'b.test', 'c.test']) rig.c.updateBrowserContext({ ...CTX, tabHostname: host })
  await tick()
  assert.equal(rig.presences().length, base, 'rate limited: nothing sent yet')
  rig.clock.advance(PRESENCE_MIN_INTERVAL_MS + 1)
  await tick()
  assert.equal(rig.presences().length, base + 1)
  assert.equal(rig.presences().at(-1)![0].details, 'on c.test')

  // A pending update is cancelled by a hide: the deferred render must not fire.
  rig.clock.advance(PRESENCE_MIN_INTERVAL_MS + 1)
  rig.c.updateBrowserContext({ ...CTX, tabHostname: 'd.test' })
  await tick()
  rig.c.updateBrowserContext({ ...CTX, tabHostname: 'e.test' }) // deferred
  rig.c.updateBrowserContext({ ...CTX, focused: false, trackable: false })
  await tick()
  const afterHide = rig.presences().length
  rig.clock.advance(10_000)
  await tick()
  assert.equal(rig.presences().length, afterHide, 'no deferred send after hide')
  assert.deepEqual(rig.presences().at(-1), [])
})

test('identical payloads are not re-sent', async () => {
  const rig = await makeController({ tracking: TRACK_ON })
  rig.c.updateBrowserContext(CTX)
  await tick()
  const n = rig.presences().length
  rig.clock.advance(PRESENCE_MIN_INTERVAL_MS + 1)
  rig.c.updateBrowserContext({ ...CTX, tabTitle: 'changed but not used by template' })
  await tick()
  assert.equal(rig.presences().length, n)
})

test('worker restart restores preferences but sends nothing until a context arrives', async () => {
  const first = await makeController({ tracking: TRACK_ON })
  const restarted = await makeController(first.storage.data)
  assert.equal(restarted.c.snapshot().tracking.enabled, true)
  assert.equal(restarted.presences().length, 0, 'raw template is never sent without a tab context')
  assert.equal(restarted.c.snapshot().browser, null)
  restarted.c.updateBrowserContext(CTX)
  await tick()
  assert.equal(restarted.presences().at(-1)![0].details, 'on example.com')
})

test('browser context is memory only; URL is blanked in snapshots unless sharing is enabled', async () => {
  const rig = await makeController({ tracking: TRACK_ON })
  rig.c.updateBrowserContext(CTX)
  await tick()
  rig.clock.advance(1000)
  await tick()
  const snap = rig.c.snapshot()
  assert.equal(snap.browser?.tabUrl, '')
  assert.equal(snap.browser?.tabHostname, 'example.com')
  assert.ok(!JSON.stringify(snap).includes('/secret/path'))
  assert.ok(!JSON.stringify(rig.storage.data).includes('example.com'), 'no tab data in storage.local')
  assert.ok(!JSON.stringify(rig.storage.data).includes('Hello'))
  const shared = await rig.c.saveTrackingSettings({ ...TRACK_ON, allowUrlSharing: true })
  assert.equal(shared.browser?.tabUrl, 'https://example.com/secret/path')
  assert.ok(!JSON.stringify(rig.storage.data).includes('/secret/path'))
})

test('tracking commands: strict validation, OAuth settings untouched, unrelated saves keep tracking', async () => {
  const rig = await makeController({ tracking: TRACK_ON })
  const bad = await rig.c.handle({ ns: MESSAGE_NAMESPACE, type: 'saveTrackingSettings', tracking: { enabled: 'yes' } })
  assert.equal(bad.ok, false)
  const badShare = await rig.c.handle({ ns: MESSAGE_NAMESPACE, type: 'saveTrackingSettings', tracking: { ...TRACK_ON, allowUrlSharing: 'x' } })
  assert.equal(badShare.ok, false)
  const ok = await rig.c.handle({ ns: MESSAGE_NAMESPACE, type: 'saveTrackingSettings', tracking: { enabled: true, allowUrlSharing: true, hideOnUnfocus: false } })
  assert.equal(ok.ok, true)
  assert.deepEqual((ok as any).snapshot.tracking, { enabled: true, allowUrlSharing: true, hideOnUnfocus: false })
  // Legacy timer fields in a command are ignored, never stored or echoed.
  const legacy = await rig.c.handle({ ns: MESSAGE_NAMESPACE, type: 'saveTrackingSettings', tracking: { enabled: true, allowUrlSharing: true, hideOnUnfocus: false, showTimer: true, timerMode: 'nonsense' } })
  assert.equal(legacy.ok, true)
  assert.deepEqual(Object.keys((legacy as any).snapshot.tracking).sort(), ['allowUrlSharing', 'enabled', 'hideOnUnfocus'])
  assert.deepEqual(Object.keys(rig.storage.data.tracking as object).sort(), ['allowUrlSharing', 'enabled', 'hideOnUnfocus'])
  // Saving OAuth settings (same app id, new secret) must not reset tracking or credentials.
  const saved = await rig.c.saveSettings({ clientId: APP, clientSecret: 'x' })
  assert.equal(saved.tracking.allowUrlSharing, true)
  assert.equal(saved.hasCredentials, true)
  assert.equal(saved.settings.clientId, APP)
  // Disconnect/OAuth changes leave tracking preferences alone.
  const disc = await rig.c.disconnect()
  assert.equal(disc.tracking.enabled, true)
  assert.equal(disc.hasCredentials, false)
  assert.equal(isCommand({ ns: MESSAGE_NAMESPACE, type: 'toggleTracking' }), true)
  assert.equal(isCommand({ ns: MESSAGE_NAMESPACE, type: 'saveTrackingSettings' }), false)
})

test('toggle works without credentials and persists; first enable shows the saved activity', async () => {
  const rig = await makeController({ credentials: null, desired: false, activityEnabled: false })
  const snap = await rig.c.toggleTracking()
  assert.equal(snap.tracking.enabled, true)
  assert.equal(snap.activityEnabled, true, 'enabling tracking turns on the saved activity')
  assert.equal((rig.storage.data.tracking as any).enabled, true)
  assert.equal((await rig.c.toggleTracking()).tracking.enabled, false)
})

test('buttons: raw templates are saved; only valid expanded http(s) links are sent (lib/activity is the single validator)', async () => {
  const rig = await makeController({ tracking: TRACK_ON })
  const withButtons = { ...ACTIVITY, buttons: [{ label: 'Open {tab_hostname}', url: '{tab_url}' }, { label: 'Repo', url: 'https://example.org/r' }] }
  await rig.c.setActivity(withButtons)
  assert.equal((rig.storage.data.activity as any).buttons[0].url, '{tab_url}', 'raw template persisted')
  rig.c.updateBrowserContext(CTX)
  await tick()
  // URL sharing is off: the {tab_url} button expands empty and is dropped.
  let entry = rig.presences().at(-1)![0]
  assert.deepEqual(entry.buttons, ['Repo'])
  assert.deepEqual(entry.metadata, { button_urls: ['https://example.org/r'] })

  await rig.c.saveTrackingSettings({ ...TRACK_ON, allowUrlSharing: true })
  rig.clock.advance(PRESENCE_MIN_INTERVAL_MS + 1)
  await tick()
  entry = rig.presences().at(-1)![0]
  assert.deepEqual(entry.buttons, ['Open example.com', 'Repo'])
  assert.deepEqual(entry.metadata, { button_urls: ['https://example.com/secret/path', 'https://example.org/r'] })

  // Invalid raw buttons are rejected by the shared validator at save time.
  const bad = await rig.c.handle({ ns: MESSAGE_NAMESPACE, type: 'setActivity', activity: { ...ACTIVITY, buttons: [{ label: 'x', url: 'javascript:alert(1)' }] } })
  assert.equal(bad.ok, false)
  const tooMany = await rig.c.handle({ ns: MESSAGE_NAMESPACE, type: 'setActivity', activity: { ...ACTIVITY, buttons: [1, 2, 3].map((n) => ({ label: `b${n}`, url: 'https://a.test' })) } })
  assert.equal(tooMany.ok, false)
})

// The timer has a single source: the activity's start/end templates. There is no
// tracking toggle or mode; blank means no timer.

test('timer: start/end come only from the activity template (ISO, epoch, placeholders)', async () => {
  const START_ISO = '2024-05-06T07:08:09Z'
  const START_MS = Date.parse(START_ISO)
  const END_MS = START_MS + 3_600_000
  const rig = await makeController({ tracking: TRACK_ON })
  await rig.c.setActivity({ ...ACTIVITY, timestamps: { start: START_ISO, end: String(END_MS) } })
  assert.deepEqual((rig.storage.data.activity as any).timestamps, { start: START_ISO, end: String(END_MS) }, 'raw template persisted')
  rig.c.updateBrowserContext(CTX)
  await tick()
  assert.deepEqual(rig.presences().at(-1)![0].timestamps, { start: START_MS, end: END_MS })

  // Placeholder anchors resolve from the live browser context; the end is optional.
  for (const [placeholder, expected] of [
    ['{tab_opened_at}', CTX.tabOpenedAt],
    ['{browser_started_at}', CTX.browserStartedAt],
    ['{tab_active_at}', CTX.tabActiveAt],
  ] as const) {
    rig.clock.advance(PRESENCE_MIN_INTERVAL_MS + 1)
    await rig.c.setActivity({ ...ACTIVITY, timestamps: { start: placeholder, end: '' } })
    await tick()
    assert.deepEqual(rig.presences().at(-1)![0].timestamps, { start: expected }, placeholder)
  }
})

test('timer: blank or absent start/end means no timer and no error', async () => {
  const rig = await makeController({ tracking: TRACK_ON })
  // Absent.
  rig.c.updateBrowserContext(CTX)
  await tick()
  assert.equal('timestamps' in rig.presences().at(-1)![0], false)
  assert.equal(rig.c.snapshot().trackingError, null)
  // Blank pair.
  rig.clock.advance(PRESENCE_MIN_INTERVAL_MS + 1)
  await rig.c.setActivity({ ...ACTIVITY, timestamps: { start: '', end: '' } })
  await tick()
  assert.equal('timestamps' in rig.presences().at(-1)![0], false)
  assert.equal(rig.c.snapshot().trackingError, null)
  assert.equal(rig.c.presenceShown, true)
})

test('timer: an end without a start is rejected at save and, if persisted, shows an error instead of publishing', async () => {
  const rig = await makeController({ tracking: TRACK_ON })
  const attempt = await rig.c.handle({ ns: MESSAGE_NAMESPACE, type: 'setActivity', activity: { ...ACTIVITY, timestamps: { start: '', end: '2030-01-01T00:00:00Z' } } })
  assert.equal(attempt.ok, false)
  assert.match((attempt as any).error, /start/i)

  // A hand-edited / older persisted record: the runtime still fails closed.
  const bad = await makeController({ tracking: TRACK_ON, activity: { ...ACTIVITY, timestamps: { start: '', end: '2030-01-01T00:00:00Z' } } })
  bad.c.updateBrowserContext(CTX)
  await tick()
  assert.equal(bad.presences().length, 0)
  assert.equal(bad.c.presenceShown, false)
  assert.match(bad.c.snapshot().trackingError ?? '', /start/i)
  // Fixing the template recovers.
  bad.clock.advance(PRESENCE_MIN_INTERVAL_MS + 1)
  await bad.c.setActivity({ ...ACTIVITY, timestamps: { start: '{tab_opened_at}', end: '' } })
  await tick()
  assert.equal(bad.presences().at(-1)![0].timestamps.start, CTX.tabOpenedAt)
  assert.equal(bad.c.snapshot().trackingError, null)
})

test('timer: invalid templates are rejected at save; tracking save does not depend on them', async () => {
  const rig = await makeController({ tracking: TRACK_ON })
  const save = (timestamps: unknown) =>
    rig.c.handle({ ns: MESSAGE_NAMESPACE, type: 'setActivity', activity: { ...ACTIVITY, timestamps } }) as Promise<{ ok: boolean; error?: string }>
  for (const bad of [
    { start: 'yesterday', end: '' },
    { start: '2024-05-06T07:08:09', end: '' }, // no timezone
    { start: '2024-13-40T00:00:00Z', end: '' },
    { start: '{nope}', end: '' },
    { start: '-5', end: '' },
    { start: '2024-05-06T07:08:09Z', end: '2024-05-06T07:08:09Z' }, // end must be after start
    { start: '2024-05-06T07:08:09Z', end: '2024-05-05T00:00:00Z' },
    { start: 5, end: '' },
  ]) {
    assert.equal((await save(bad)).ok, false, JSON.stringify(bad))
  }
  assert.equal((await save({ start: '', end: '' })).ok, true, 'blank pair is allowed')
  assert.equal((await save({ start: '{tab_opened_at}', end: '2030-01-01T00:00:00+02:00' })).ok, true, 'dynamic start + literal end allowed')
  const prefs = await rig.c.handle({ ns: MESSAGE_NAMESPACE, type: 'saveTrackingSettings', tracking: TRACK_ON })
  assert.equal(prefs.ok, true)
})

test('timer: legacy showTimer/timerMode fields are ignored; saved raw timestamps are honoured', async () => {
  const START_MS = Date.parse('2024-05-06T07:08:09Z')
  // showTimer:false (and nonsense timerMode) used to suppress the timer; now only the template matters.
  const rig = await makeController({
    tracking: { enabled: true, showTimer: false, timerMode: 'browser', allowUrlSharing: false },
    activity: { ...ACTIVITY, timestamps: { start: '2024-05-06T07:08:09Z', end: '' } },
  })
  const t = rig.c.snapshot().tracking as Record<string, unknown>
  assert.equal('showTimer' in t, false)
  assert.equal('timerMode' in t, false)
  rig.c.updateBrowserContext(CTX)
  await tick()
  assert.deepEqual(rig.presences().at(-1)![0].timestamps, { start: START_MS }, 'legacy flag false does not hide the timer')

  // With legacy flag true/mode browser but a blank template there is still no timer (no implicit default).
  const blank = await makeController({ tracking: { enabled: true, showTimer: true, timerMode: 'browser', allowUrlSharing: false } })
  blank.c.updateBrowserContext(CTX)
  await tick()
  assert.equal('timestamps' in blank.presences().at(-1)![0], false)
})

test('old numeric custom fields are ignored, not migrated; hideOnUnfocus defaults to true', async () => {
  const rig = await makeController({ tracking: { enabled: true, showTimer: true, timerMode: 'custom', allowUrlSharing: false, customStart: 1700000000000, customEnd: 1700003600000 } })
  const t = rig.c.snapshot().tracking as Record<string, unknown>
  for (const legacy of ['customStart', 'customEnd', 'showTimer', 'timerMode']) assert.equal(legacy in t, false, legacy)
  assert.equal(t.hideOnUnfocus, true)
  assert.deepEqual(parseTracking({ customStart: 5, timerMode: 'custom', showTimer: true }), DEFAULT_TRACKING)
  assert.equal(parseTracking({ hideOnUnfocus: false }).hideOnUnfocus, false)
  assert.equal(parseTracking({ hideOnUnfocus: 'no' }).hideOnUnfocus, true, 'only an explicit false disables hiding')
  const saved = await rig.c.saveTrackingSettings({ enabled: true, allowUrlSharing: false })
  assert.equal(saved.tracking.hideOnUnfocus, true, 'omitted flag keeps the default')
  const bad = await rig.c.handle({ ns: MESSAGE_NAMESPACE, type: 'saveTrackingSettings', tracking: { ...TRACK_ON, hideOnUnfocus: 'yes' } })
  assert.equal(bad.ok, false)
})

// ---- hide on unfocus ----------------------------------------------------------

const UNFOCUSED = { ...CTX, focused: false, trackable: true }

test('hideOnUnfocus true (default) hides on blur even when the tracker retains the last tab', async () => {
  const rig = await makeController({ tracking: TRACK_ON })
  rig.c.updateBrowserContext(CTX)
  await tick()
  assert.equal(rig.presences().at(-1)![0].details, 'on example.com')
  rig.c.updateBrowserContext(UNFOCUSED)
  await tick()
  assert.deepEqual(rig.presences().at(-1), [])
  assert.equal(rig.c.presenceShown, false)
  // Refocus restores it.
  rig.clock.advance(PRESENCE_MIN_INTERVAL_MS + 1)
  rig.c.updateBrowserContext({ ...CTX, tabHostname: 'back.test' })
  await tick()
  assert.equal(rig.presences().at(-1)![0].details, 'on back.test')
})

test('hideOnUnfocus false keeps the last eligible tab on blur; private/internal and off still clear', async () => {
  const rig = await makeController({ tracking: { ...TRACK_ON, hideOnUnfocus: false } })
  rig.c.updateBrowserContext(CTX)
  await tick()
  const shown = rig.presences().length
  rig.c.updateBrowserContext(UNFOCUSED)
  await tick()
  assert.equal(rig.presences().length, shown, 'nothing changes on blur')
  assert.equal(rig.c.presenceShown, true)
  assert.equal(rig.presences().at(-1)![0].details, 'on example.com')

  // Never-eligible (or private/internal) unfocused context shows nothing.
  rig.c.updateBrowserContext({ ...UNFOCUSED, trackable: false, tabTitle: '', tabHostname: '' })
  await tick()
  assert.deepEqual(rig.presences().at(-1), [], 'untrackable always clears')

  // Refocus updates to the new tab.
  rig.clock.advance(PRESENCE_MIN_INTERVAL_MS + 1)
  rig.c.updateBrowserContext({ ...CTX, tabHostname: 'new.test' })
  await tick()
  assert.equal(rig.presences().at(-1)![0].details, 'on new.test')
  // Turning tracking off clears even in keep-visible mode.
  await rig.c.toggleTracking()
  await tick()
  assert.deepEqual(rig.presences().at(-1), [])
  assert.equal(rig.c.presenceShown, false)
})

test('toggling hideOnUnfocus applies immediately to the current unfocused state', async () => {
  const rig = await makeController({ tracking: { ...TRACK_ON, hideOnUnfocus: false } })
  rig.c.updateBrowserContext(CTX)
  await tick()
  rig.c.updateBrowserContext(UNFOCUSED)
  await tick()
  assert.equal(rig.c.presenceShown, true)
  await rig.c.saveTrackingSettings({ ...TRACK_ON, hideOnUnfocus: true })
  await tick()
  assert.equal(rig.c.presenceShown, false)
  assert.deepEqual(rig.presences().at(-1), [])
  rig.clock.advance(PRESENCE_MIN_INTERVAL_MS + 1)
  await rig.c.saveTrackingSettings({ ...TRACK_ON, hideOnUnfocus: false })
  await tick()
  assert.equal(rig.c.presenceShown, true)
})

// ---- tracker: retained last eligible context ------------------------------------

test('tracker: blur keeps the last eligible tab (unfocused, trackable) without picking arbitrary tabs', async () => {
  const rig = makeTracker()
  rig.windows = [
    normalWindow(1, [tab(1, 'https://a.test/', { active: true, title: 'Mine' })], { focused: true }),
    normalWindow(2, [tab(2, 'https://other.test/', { active: true, title: 'Other' })]),
  ]
  rig.t.setEnabled(true)
  await settle(rig)
  assert.equal(rig.last()!.tabTitle, 'Mine')
  rig.t.onFocusChanged(WINDOW_ID_NONE)
  let c = rig.last()!
  assert.equal(c.focused, false)
  assert.equal(c.trackable, true)
  assert.equal(c.tabTitle, 'Mine')

  // Later reads while unfocused (even if getAll reports another window focused) never switch tabs.
  rig.windows = [
    normalWindow(1, [tab(1, 'https://a.test/', { active: true, title: 'Mine' })]),
    normalWindow(2, [tab(2, 'https://other.test/', { active: true, title: 'Other' })], { focused: true }),
  ]
  rig.t.onTabActivated()
  await settle(rig)
  c = rig.last()!
  assert.equal(c.tabTitle, 'Mine')
  assert.equal(c.focused, false)

  // Refocus publishes the focused window's real tab.
  rig.t.onFocusChanged(2)
  await settle(rig)
  assert.equal(rig.last()!.tabTitle, 'Other')
  assert.equal(rig.last()!.focused, true)
})

test('tracker: never observed or private/internal last focus means nothing is retained', async () => {
  // Never observed an eligible tab: blur yields an empty context.
  const fresh = makeTracker()
  fresh.windows = [normalWindow(1, [tab(1, 'https://a.test/', { active: true })])]
  fresh.t.setEnabled(true)
  fresh.t.onFocusChanged(WINDOW_ID_NONE)
  assert.equal(fresh.last()!.trackable, false)
  assert.equal(fresh.last()!.tabTitle, '')
  await settle(fresh)
  assert.equal(fresh.last()!.trackable, false, 'getAll while unfocused does not pick a current tab')
  assert.equal(fresh.last()!.tabTitle, '')

  // Eligible -> focused internal page -> blur: the older eligible tab must NOT come back.
  // Changed product policy: the internal page itself is title-only trackable, so blur
  // retains ITS title (never the older 'Eligible' one) and no URL/host/icon.
  const rig = makeTracker()
  rig.windows = [normalWindow(1, [tab(1, 'https://a.test/', { active: true, title: 'Eligible' })], { focused: true })]
  rig.t.setEnabled(true)
  await settle(rig)
  assert.equal(rig.last()!.tabTitle, 'Eligible')
  rig.windows = [normalWindow(1, [tab(1, 'chrome://settings', { active: true, title: 'Settings' })], { focused: true })]
  rig.t.onTabUpdated(1, { url: 'x' })
  await settle(rig)
  assert.equal(rig.last()!.trackable, true)
  assert.equal(rig.last()!.tabTitle, 'Settings')
  rig.t.onFocusChanged(WINDOW_ID_NONE)
  assert.equal(rig.last()!.trackable, true)
  assert.equal(rig.last()!.tabTitle, 'Settings')
  assert.equal(rig.last()!.tabUrl, '')
  assert.equal(rig.last()!.tabHostname, '')

  // Eligible -> focused incognito window -> blur: same.
  const priv = makeTracker()
  priv.windows = [normalWindow(1, [tab(1, 'https://a.test/', { active: true, title: 'Eligible' })], { focused: true })]
  priv.t.setEnabled(true)
  await settle(priv)
  priv.windows = [
    normalWindow(1, [tab(1, 'https://a.test/', { active: true })]),
    normalWindow(2, [tab(2, 'https://secret.test/', { active: true })], { focused: true, incognito: true }),
  ]
  priv.t.onFocusChanged(2)
  await settle(priv)
  priv.t.onFocusChanged(WINDOW_ID_NONE)
  assert.equal(priv.last()!.trackable, false)
  assert.equal(priv.last()!.tabTitle, '')
})

test('tracker: disabling clears the retained tab; closing the retained tab stops showing it', async () => {
  const rig = makeTracker()
  rig.windows = [normalWindow(1, [tab(1, 'https://a.test/', { active: true, title: 'Mine' })], { focused: true })]
  rig.t.setEnabled(true)
  await settle(rig)
  rig.t.onFocusChanged(WINDOW_ID_NONE)
  assert.equal(rig.last()!.tabTitle, 'Mine')
  rig.t.setEnabled(false)
  assert.equal(rig.last(), null)
  rig.t.setEnabled(true)
  rig.t.onFocusChanged(WINDOW_ID_NONE)
  assert.equal(rig.last()!.trackable, false, 're-enabling starts without a retained tab')

  const closing = makeTracker()
  closing.windows = [normalWindow(1, [tab(1, 'https://a.test/', { active: true, title: 'Gone' })], { focused: true })]
  closing.t.setEnabled(true)
  await settle(closing)
  closing.t.onFocusChanged(WINDOW_ID_NONE)
  assert.equal(closing.last()!.tabTitle, 'Gone')
  closing.t.onTabRemoved(1)
  assert.equal(closing.last()!.trackable, false)
  assert.equal(closing.last()!.tabTitle, '')
})

// ---- regression: "hide on unfocus OFF still disappears when switching app/minimizing" ----

/** getAll (normal windows only) while Chrome is in a transient state: nothing reports focus. */
const allUnfocused = (title: string) => [normalWindow(1, [tab(1, 'https://a.test/', { active: true, title })])]

test('regression: a transient non-NONE focus event with no focused window must not lose the retained tab', async () => {
  const rig = makeTracker()
  rig.windows = [normalWindow(1, [tab(1, 'https://a.test/', { active: true, title: 'Mine' })], { focused: true })]
  rig.t.setEnabled(true)
  await settle(rig)
  assert.equal(rig.last()!.tabTitle, 'Mine')

  // Switch to another app: focus is lost.
  rig.t.onFocusChanged(WINDOW_ID_NONE)
  assert.equal(rig.last()!.tabTitle, 'Mine')
  assert.equal(rig.last()!.trackable, true)

  // Chrome then reports a normal window id again, but getAll shows nothing focused
  // (minimized / mid-switch). Window 1 is confirmed to be a normal window.
  rig.windows = allUnfocused('Mine')
  rig.t.onFocusChanged(1)
  assert.equal(rig.last()!.trackable, false, 'withdrawn until the focus target is verified (privacy)')
  await settle(rig)
  assert.equal(rig.last()!.focused, false)
  assert.equal(rig.last()!.trackable, true, 'verified normal window, nothing focused: retained tab is back')
  assert.equal(rig.last()!.tabTitle, 'Mine')

  // The *later* real blur must still retain it (this is what used to be lost forever).
  rig.t.onFocusChanged(WINDOW_ID_NONE)
  assert.equal(rig.last()!.trackable, true)
  assert.equal(rig.last()!.tabTitle, 'Mine')
  assert.equal(rig.last()!.focused, false)
})

test('regression: minimizing / app switch (NONE only) keeps the retained tab across later reads', async () => {
  const rig = makeTracker()
  rig.windows = [normalWindow(1, [tab(1, 'https://a.test/', { active: true, title: 'Mine' })], { focused: true })]
  rig.t.setEnabled(true)
  await settle(rig)
  rig.t.onFocusChanged(WINDOW_ID_NONE)
  rig.windows = allUnfocused('Mine')
  for (let i = 0; i < 3; i++) {
    rig.t.onTabUpdated(1, { title: 'x' })
    await settle(rig)
    assert.equal(rig.last()!.trackable, true)
    assert.equal(rig.last()!.tabTitle, 'Mine')
    assert.equal(rig.last()!.focused, false)
  }
})

test('regression: a genuinely focused private/internal/popup window clears and the old tab cannot come back', async () => {
  for (const kind of ['incognito', 'popup', 'unreadable'] as const) {
    const rig = makeTracker()
    rig.windows = [normalWindow(1, [tab(1, 'https://a.test/', { active: true, title: 'Eligible' })], { focused: true })]
    rig.t.setEnabled(true)
    await settle(rig)
    rig.t.onFocusChanged(WINDOW_ID_NONE)
    assert.equal(rig.last()!.tabTitle, 'Eligible', kind)

    // Focus moves to a window that getAll(normal) does not list.
    rig.windows = allUnfocused('Eligible')
    if (kind === 'incognito') rig.windowInfo.set(9, { id: 9, type: 'normal', incognito: true, focused: true })
    if (kind === 'popup') rig.windowInfo.set(9, { id: 9, type: 'popup', incognito: false, focused: true })
    // 'unreadable': windows.get(9) resolves null.
    rig.t.onFocusChanged(9)
    await settle(rig)
    assert.equal(rig.last()!.trackable, false, `${kind}: hidden`)
    assert.equal(rig.last()!.tabTitle, '', kind)

    // ...and the earlier eligible tab must not be resurrected by a later blur.
    rig.t.onFocusChanged(WINDOW_ID_NONE)
    assert.equal(rig.last()!.trackable, false, `${kind}: not resurrected on blur`)
    assert.equal(rig.last()!.tabTitle, '', kind)
    rig.windows = allUnfocused('Eligible')
    rig.t.onTabActivated()
    await settle(rig)
    assert.equal(rig.last()!.trackable, false, `${kind}: not resurrected by later reads`)
  }
})

test('regression: a real normal-window refocus after the blur updates to that window\'s tab', async () => {
  const rig = makeTracker()
  rig.windows = [
    normalWindow(1, [tab(1, 'https://a.test/', { active: true, title: 'Mine' })], { focused: true }),
    normalWindow(2, [tab(2, 'https://b.test/', { active: true, title: 'Second' })]),
  ]
  rig.t.setEnabled(true)
  await settle(rig)
  rig.t.onFocusChanged(WINDOW_ID_NONE)
  assert.equal(rig.last()!.tabTitle, 'Mine')
  rig.windows = [
    normalWindow(1, [tab(1, 'https://a.test/', { active: true, title: 'Mine' })]),
    normalWindow(2, [tab(2, 'https://b.test/', { active: true, title: 'Second' })], { focused: true }),
  ]
  rig.t.onFocusChanged(2)
  await settle(rig)
  assert.equal(rig.last()!.focused, true)
  assert.equal(rig.last()!.tabTitle, 'Second')
  // And now the retained tab is the *new* one.
  rig.t.onFocusChanged(WINDOW_ID_NONE)
  assert.equal(rig.last()!.tabTitle, 'Second')
  assert.equal(rig.last()!.trackable, true)
})

test('regression (controller): hideOnUnfocus OFF keeps presence through blur -> transient focus -> blur', async () => {
  const rig = await makeController({ tracking: { ...TRACK_ON, hideOnUnfocus: false } })
  const tr = makeTracker()
  tr.windows = [normalWindow(1, [tab(1, 'https://example.com/', { active: true, title: 'Mine' })], { focused: true })]
  tr.t.setEnabled(true)
  await settle(tr)
  rig.c.updateBrowserContext({ ...tr.last()! })
  await tick()
  assert.equal(rig.c.presenceShown, true)
  tr.t.onFocusChanged(WINDOW_ID_NONE)
  rig.c.updateBrowserContext({ ...tr.last()! })
  await tick()
  assert.equal(rig.c.presenceShown, true, 'blur keeps it')
  tr.windows = allUnfocused('Mine')
  tr.t.onFocusChanged(1)
  await settle(tr)
  rig.clock.advance(PRESENCE_MIN_INTERVAL_MS + 1)
  rig.c.updateBrowserContext({ ...tr.last()! })
  await tick()
  rig.clock.advance(PRESENCE_MIN_INTERVAL_MS + 1)
  tr.t.onFocusChanged(WINDOW_ID_NONE)
  rig.c.updateBrowserContext({ ...tr.last()! })
  await tick()
  assert.equal(rig.c.presenceShown, true, 'still shown after the second blur')
})

test('tracker retained tab is memory only: nothing about it reaches session storage', async () => {
  const rig = makeTracker()
  rig.windows = [normalWindow(1, [tab(1, 'https://private-site.example/x?y=1', { active: true, title: 'Secret Title' })], { focused: true })]
  rig.t.setEnabled(true)
  await settle(rig)
  rig.t.onFocusChanged(WINDOW_ID_NONE)
  const saved = JSON.stringify([...rig.session.values()])
  assert.ok(!saved.includes('private-site'))
  assert.ok(!saved.includes('Secret'))
})

test('storage parsing: tracking defaults, lenient load, strict command parse', () => {
  assert.deepEqual(parseTracking(undefined), DEFAULT_TRACKING)
  assert.deepEqual(parseTracking({ enabled: 1, allowUrlSharing: 'x', timerMode: 'bogus' }), DEFAULT_TRACKING)
  assert.deepEqual(parseTracking({ enabled: true, allowUrlSharing: true, hideOnUnfocus: false }), { enabled: true, allowUrlSharing: true, hideOnUnfocus: false })
  assert.equal(parseTrackingStrict({ enabled: true }), null)
  assert.equal(parseTrackingStrict(null), null)
  assert.deepEqual(parseTrackingStrict({ enabled: true, allowUrlSharing: false, showTimer: true, timerMode: 'x' }), { enabled: true, allowUrlSharing: false, hideOnUnfocus: true })
})

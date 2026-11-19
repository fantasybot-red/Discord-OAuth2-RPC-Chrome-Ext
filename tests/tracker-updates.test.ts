import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Tracker, TRACKER_DEBOUNCE_MS, TRACKER_MAX_WAIT_MS, WINDOW_ID_NONE } from '../src/background/tracker.ts'
import type { TabLike, WindowLike } from '../src/background/tracker.ts'
import type { Clock } from '../src/lib/gateway.ts'
import type { BrowserContext } from '../src/shared/types.ts'

class FakeClock implements Clock {
  t = 5_000_000
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

const tab = (id: number, url: string, extra: Partial<TabLike> = {}): TabLike => ({ id, url, title: `T${id}`, active: false, favIconUrl: '', ...extra })
const win = (id: number, tabs: TabLike[], extra: Partial<WindowLike> = {}): WindowLike => ({
  id,
  type: 'normal',
  focused: false,
  incognito: false,
  tabs: tabs.map((t) => ({ ...t, windowId: id })),
  ...extra,
})

function rig() {
  const clock = new FakeClock()
  const r = {
    clock,
    windows: [] as WindowLike[],
    emitted: [] as Array<BrowserContext | null>,
    session: new Map<string, unknown>(),
    queries: 0,
    /** When true, getWindows stays in flight until a pending resolver is called. */
    hold: false,
    pending: [] as Array<() => void>,
    t: undefined as unknown as Tracker,
    last: () => r.emitted.at(-1) as BrowserContext,
    /** Advance past the debounce and let the read finish. */
    async settle(ms = TRACKER_DEBOUNCE_MS + 1) {
      clock.advance(ms)
      await tick()
    },
  }
  r.t = new Tracker({
    clock,
    emit: (c) => void r.emitted.push(c),
    api: {
      getWindows: async () => {
        r.queries += 1
        const snapshot = structuredClone(r.windows)
        if (!r.hold) return snapshot
        await new Promise<void>((resolve) => r.pending.push(resolve))
        return snapshot
      },
      getWindow: async (id) => {
        const w = r.windows.find((x) => x.id === id)
        if (!w) return null
        const { tabs: _tabs, ...info } = w
        return structuredClone(info)
      },
      sessionGet: async (k) => structuredClone(r.session.get(k)),
      sessionSet: async (k, v) => void r.session.set(k, structuredClone(v)),
    },
  })
  return r
}

/** Start tracking a single focused window whose active tab is `a`. */
async function started() {
  const r = rig()
  r.windows = [win(1, [tab(1, 'https://a.test/one', { active: true, title: 'One' }), tab(2, 'https://b.test/two', { title: 'Two' })], { focused: true })]
  r.t.setEnabled(true)
  await r.settle()
  assert.equal(r.last().tabTitle, 'One')
  return r
}

// ---- already-supported behaviour (event -> fresh read -> publish) -------------------

test('active tab URL + title change is published after the debounce, not before', async () => {
  const r = await started()
  const before = r.emitted.length
  r.windows = [win(1, [tab(1, 'https://a.test/next', { active: true, title: 'Next' }), tab(2, 'https://b.test/two')], { focused: true })]
  r.t.onTabUpdated(1, { url: 'https://a.test/next', title: 'Next' })
  assert.equal(r.emitted.length, before, 'debounced, nothing synchronous')
  r.clock.advance(TRACKER_DEBOUNCE_MS - 1)
  await tick()
  assert.equal(r.emitted.length, before)
  await r.settle(2)
  assert.equal(r.last().tabUrl, 'https://a.test/next')
  assert.equal(r.last().tabTitle, 'Next')
  assert.equal(r.last().tabHostname, 'a.test')
})

test('SPA navigation (title only, then url only) updates; counts, tabOpenedAt, tabActiveAt are unaffected', async () => {
  const r = await started()
  const first = r.last()
  r.clock.advance(30_000)
  r.windows = [win(1, [tab(1, 'https://a.test/one', { active: true, title: 'Spa title' }), tab(2, 'https://b.test/two')], { focused: true })]
  r.t.onTabUpdated(1, { title: 'Spa title' })
  await r.settle()
  assert.equal(r.last().tabTitle, 'Spa title')
  r.windows = [win(1, [tab(1, 'https://a.test/route/2', { active: true, title: 'Spa title' }), tab(2, 'https://b.test/two')], { focused: true })]
  r.t.onTabUpdated(1, { url: 'https://a.test/route/2' })
  await r.settle()
  const c = r.last()
  assert.equal(c.tabUrl, 'https://a.test/route/2')
  assert.equal(c.tabCount, first.tabCount)
  assert.equal(c.windowCount, first.windowCount)
  assert.equal(c.windowTabCount, first.windowTabCount)
  assert.equal(c.tabOpenedAt, first.tabOpenedAt)
  assert.equal(c.tabActiveAt, first.tabActiveAt)
})

test('a background tab update never replaces the active tab context', async () => {
  const r = await started()
  r.windows = [win(1, [tab(1, 'https://a.test/one', { active: true, title: 'One' }), tab(2, 'https://b.test/changed', { title: 'Background changed' })], { focused: true })]
  r.t.onTabUpdated(2, { url: 'https://b.test/changed', title: 'Background changed' })
  await r.settle()
  assert.equal(r.last().tabTitle, 'One')
  assert.equal(r.last().tabUrl, 'https://a.test/one')
})

test('rapid events: latest state wins and costs a single read', async () => {
  const r = await started()
  const q = r.queries
  for (let i = 1; i <= 5; i++) {
    r.windows = [win(1, [tab(1, `https://a.test/${i}`, { active: true, title: `Title ${i}` })], { focused: true })]
    r.t.onTabUpdated(1, { title: `Title ${i}` })
    r.clock.advance(50)
  }
  await r.settle()
  assert.equal(r.queries, q + 1)
  assert.equal(r.last().tabTitle, 'Title 5')
})

test('a blank/loading title never leaks the previous page title or the URL as a title', async () => {
  const r = await started()
  r.windows = [win(1, [tab(1, 'https://a.test/loading', { active: true, title: '' })], { focused: true })]
  r.t.onTabUpdated(1, { status: 'loading' })
  await r.settle()
  assert.equal(r.last().tabTitle, '')
  assert.equal(r.last().trackable, true)
})

test('navigating the active tab to an internal page drops the web URL/host at once (title-only), and back restores', async () => {
  const r = await started()
  r.windows = [win(1, [tab(1, 'chrome://settings', { active: true, title: 'Settings' })], { focused: true })]
  r.t.onTabUpdated(1, { url: 'chrome://settings' })
  await r.settle()
  assert.equal(r.last().trackable, true, 'changed policy: title-only')
  assert.equal(r.last().tabTitle, 'Settings')
  assert.equal(r.last().tabUrl, '')
  assert.equal(r.last().tabHostname, '')
  r.windows = [win(1, [tab(1, 'https://a.test/back', { active: true, title: 'Back' })], { focused: true })]
  r.t.onTabUpdated(1, { url: 'https://a.test/back' })
  await r.settle()
  assert.equal(r.last().tabTitle, 'Back')
})

test('switching the active tab (same window) publishes the new tab and restarts only tabActiveAt', async () => {
  const r = await started()
  const first = r.last()
  r.clock.advance(20_000)
  r.windows = [win(1, [tab(1, 'https://a.test/one'), tab(2, 'https://b.test/two', { active: true, title: 'Two' })], { focused: true })]
  r.t.onTabActivated({ tabId: 2, windowId: 1 })
  await r.settle()
  assert.equal(r.last().tabTitle, 'Two')
  assert.equal(r.last().tabHostname, 'b.test')
  assert.ok(r.last().tabActiveAt > first.tabActiveAt)
  assert.equal(r.last().tabOpenedAt, r.last().tabOpenedAt)
  assert.equal(r.last().tabCount, 2)
})

// ---- the real defects: a latched "no focus" state and starved debounce --------------

test('REGRESSION noFocus latch: NONE, then the user switches tab with no focus event -> recovers on a confirmed-focused window', async () => {
  const r = await started()
  // Chrome reports "no window focused" (side panel / app switch / WM quirk)...
  r.t.onFocusChanged(WINDOW_ID_NONE)
  assert.equal(r.last().focused, false)
  // ...then the user clicks another tab. Chrome fires onActivated but NO onFocusChanged.
  r.windows = [win(1, [tab(1, 'https://a.test/one'), tab(2, 'https://b.test/two', { active: true, title: 'Two' })], { focused: true })]
  r.t.onTabActivated({ tabId: 2, windowId: 1 })
  await r.settle()
  assert.equal(r.last().focused, true, 'confirmed focused window: no longer latched unfocused')
  assert.equal(r.last().tabTitle, 'Two')
})

test('REGRESSION noFocus latch: an activation WITHOUT a window id (legacy call) cannot release it; a user tab switch with one does', async () => {
  const r = await started()
  r.t.onFocusChanged(WINDOW_ID_NONE)
  r.windows = [win(1, [tab(1, 'https://a.test/one'), tab(2, 'https://b.test/two', { active: true, title: 'Two' })], { focused: true })]
  r.t.onTabActivated()
  await r.settle()
  assert.equal(r.last().focused, false, 'no evidence which window: stays latched (stale focused:true is not trusted)')
  // A plain URL/title update is not user-switch evidence either.
  r.t.onTabUpdated(2, { title: 'Two' })
  await r.settle()
  assert.equal(r.last().focused, false)
  r.t.onTabActivated({ tabId: 2, windowId: 1 })
  await r.settle()
  assert.equal(r.last().focused, true)
  assert.equal(r.last().tabTitle, 'Two')
  // Once released, URL/title updates of the active tab flow normally.
  r.windows = [win(1, [tab(1, 'https://a.test/one'), tab(2, 'https://b.test/new', { active: true, title: 'Fresh' })], { focused: true })]
  r.t.onTabUpdated(2, { url: 'https://b.test/new', title: 'Fresh' })
  await r.settle()
  assert.equal(r.last().tabTitle, 'Fresh')
  assert.equal(r.last().tabUrl, 'https://b.test/new')
})

test('privacy: while truly unfocused (no window reports focus) tab events never un-hide or switch tabs', async () => {
  const r = await started()
  r.t.onFocusChanged(WINDOW_ID_NONE)
  r.windows = [win(1, [tab(1, 'https://a.test/one'), tab(2, 'https://b.test/two', { active: true, title: 'Two' })])]
  r.t.onTabActivated({ tabId: 2, windowId: 1 })
  await r.settle()
  assert.equal(r.last().focused, false)
  assert.equal(r.last().tabTitle, 'One', 'retained tab, not the newly active one')
  r.t.onTabUpdated(2, { title: 'Two!' })
  await r.settle()
  assert.equal(r.last().focused, false)
})

test('privacy: a stale focused:true read cannot override a NONE that arrived after the event', async () => {
  const r = await started()
  r.t.onFocusChanged(WINDOW_ID_NONE)
  r.windows = [win(1, [tab(1, 'https://a.test/one'), tab(2, 'https://b.test/two', { active: true, title: 'Two' })], { focused: true })]
  r.t.onTabActivated({ tabId: 2, windowId: 1 })
  r.t.onFocusChanged(WINDOW_ID_NONE) // newer truth, before the debounced read
  await r.settle()
  assert.equal(r.last().focused, false)
  assert.equal(r.last().tabTitle, 'One')
})

test('privacy: NONE arriving while the activation read is IN FLIGHT discards its focused:true result', async () => {
  const r = await started()
  r.t.onFocusChanged(WINDOW_ID_NONE)
  r.windows = [win(1, [tab(1, 'https://a.test/one'), tab(2, 'https://b.test/two', { active: true, title: 'Two' })], { focused: true })]
  r.t.onTabActivated({ tabId: 2, windowId: 1 })
  r.hold = true
  r.clock.advance(TRACKER_DEBOUNCE_MS + 1)
  await tick()
  assert.equal(r.pending.length, 1, 'the activation read is in flight and would report focused:true')
  const before = r.emitted.length
  r.t.onFocusChanged(WINDOW_ID_NONE) // Chrome lost focus after the click
  r.pending.forEach((release) => release())
  await tick()
  const published = r.emitted.slice(before)
  assert.ok(published.every((c) => c && c.focused === false), 'no focused:true context after the later NONE')
  assert.equal(r.last().focused, false)
  assert.equal(r.last().tabTitle, 'One')
  // The hint was consumed/cleared: an unrelated later read with a stale focused flag stays unfocused.
  r.hold = false
  r.t.onTabUpdated(2, { title: 'Two' })
  await r.settle()
  assert.equal(r.last().focused, false)
})

test('privacy: an activation hint for a different or private window does not unlatch', async () => {
  const r = await started()
  r.t.onFocusChanged(WINDOW_ID_NONE)
  r.windows = [
    win(1, [tab(1, 'https://a.test/one', { active: true })]),
    win(2, [tab(3, 'https://secret.test/', { active: true, title: 'Secret' })], { focused: true, incognito: true }),
  ]
  r.t.onTabActivated({ tabId: 3, windowId: 2 })
  await r.settle()
  assert.equal(r.last().tabTitle, 'One')
  assert.equal(r.last().focused, false)
  assert.ok(!JSON.stringify(r.emitted).includes('Secret'))
})

test('REGRESSION starvation: continuous events (loading status) cannot postpone the read forever', async () => {
  const r = await started()
  r.windows = [win(1, [tab(1, 'https://a.test/streamed', { active: true, title: 'Streamed' })], { focused: true })]
  const q = r.queries
  // An event every 100ms (< debounce) for far longer than the max wait.
  for (let i = 0; i < 30; i++) {
    r.t.onTabUpdated(1, { status: 'loading' })
    r.clock.advance(100)
    await tick(2)
  }
  assert.ok(r.queries > q, 'a read happened despite the endless event stream')
  assert.equal(r.last().tabTitle, 'Streamed')
  assert.ok(TRACKER_MAX_WAIT_MS >= TRACKER_DEBOUNCE_MS)
})

// ---- changed product policy: non-web pages are TITLE-ONLY trackable ------------------
// Before: chrome://, chrome-extension://, about:, file: ... were trackable:false with a
// blank title, so Discord showed nothing on the New Tab page. Now the Chrome-provided
// title (and counts/timers) are published; URL, origin, hostname and favicon stay ''.

const NO_URL_FIELDS = { tabUrl: '', tabOrigin: '', tabHostname: '', tabFavicon: '' }

test('POLICY: new tab pages (chrome://newtab and a custom extension new tab) publish their title, never a URL/domain/icon', async () => {
  for (const url of ['chrome://newtab/', 'chrome://newtab', 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/newtab.html']) {
    const r = await started()
    r.windows = [win(1, [tab(1, url, { active: true, title: 'New Tab', favIconUrl: 'https://icons.test/x.ico' }), tab(2, 'https://b.test/two')], { focused: true })]
    r.t.onTabActivated({ tabId: 1, windowId: 1 })
    await r.settle()
    const c = r.last()
    assert.equal(c.trackable, true, url)
    assert.equal(c.focused, true)
    assert.equal(c.tabTitle, 'New Tab', url)
    assert.deepEqual({ tabUrl: c.tabUrl, tabOrigin: c.tabOrigin, tabHostname: c.tabHostname, tabFavicon: c.tabFavicon }, NO_URL_FIELDS, url)
    assert.equal(c.tabCount, 2)
    assert.equal(c.windowCount, 1)
    assert.equal(c.windowTabCount, 2)
    assert.ok(c.tabOpenedAt > 0 && c.tabActiveAt > 0 && c.browserStartedAt > 0)
    assert.ok(!JSON.stringify(r.emitted).includes('abcdefghijklmnop'), 'extension id never emitted')
  }
})

test('POLICY: about:blank / unreadable url with no title falls back to a safe label, still no URL', async () => {
  const r = await started()
  for (const url of ['about:blank', undefined]) {
    r.windows = [win(1, [tab(1, url as string, { active: true, title: '' })], { focused: true })]
    r.t.onTabUpdated(1, { url: 'x' })
    await r.settle()
    const c = r.last()
    assert.equal(c.trackable, true, String(url))
    assert.equal(c.tabTitle, 'Untitled tab')
    assert.deepEqual({ tabUrl: c.tabUrl, tabOrigin: c.tabOrigin, tabHostname: c.tabHostname, tabFavicon: c.tabFavicon }, NO_URL_FIELDS)
  }
})

test('POLICY: an OAuth callback page shows only its Chrome title; code/state/extension id never emitted or stored', async () => {
  const r = await started()
  const callback = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/callback.html?code=SECRETCODE&state=SECRETSTATE#access_token=SECRETTOKEN'
  r.windows = [win(1, [tab(1, callback, { active: true, title: 'Discord connected', favIconUrl: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/i.png' })], { focused: true })]
  r.t.onTabUpdated(1, { url: callback })
  await r.settle()
  assert.equal(r.last().trackable, true)
  assert.equal(r.last().tabTitle, 'Discord connected')
  const everything = JSON.stringify([r.emitted, [...r.session.values()]])
  for (const secret of ['SECRETCODE', 'SECRETSTATE', 'SECRETTOKEN', 'abcdefghijklmnop', 'callback.html', 'chrome-extension']) {
    assert.ok(!everything.includes(secret), `${secret} must not appear in emitted contexts or session storage`)
  }
})

test('POLICY: the title is bounded and trimmed (never derived from the URL)', async () => {
  const r = await started()
  r.windows = [win(1, [tab(1, 'chrome://settings/secret?x=1', { active: true, title: `  ${'x'.repeat(500)}  ` })], { focused: true })]
  r.t.onTabUpdated(1, { title: 'y' })
  await r.settle()
  assert.equal(r.last().tabTitle, 'x'.repeat(256))
  r.windows = [win(1, [tab(1, 'chrome://settings/secret?x=1', { active: true, title: '' })], { focused: true })]
  r.t.onTabUpdated(1, { title: '' })
  await r.settle()
  assert.ok(!r.last().tabTitle.includes('settings') && !r.last().tabTitle.includes('secret'))
})

test('POLICY: web -> internal -> web keeps web metadata exactly; counts and timers survive', async () => {
  const r = await started()
  const web = r.last()
  r.clock.advance(10_000)
  r.windows = [win(1, [tab(1, 'chrome://newtab/', { active: true, title: 'New Tab' }), tab(2, 'https://b.test/two')], { focused: true })]
  r.t.onTabUpdated(1, { url: 'chrome://newtab/' })
  await r.settle()
  assert.equal(r.last().tabTitle, 'New Tab')
  assert.equal(r.last().tabHostname, '')
  assert.equal(r.last().tabOpenedAt, web.tabOpenedAt)
  assert.equal(r.last().tabActiveAt, web.tabActiveAt)
  r.windows = [win(1, [tab(1, 'https://a.test/again?q=1', { active: true, title: 'Again', favIconUrl: 'https://a.test/f.ico' }), tab(2, 'https://b.test/two')], { focused: true })]
  r.t.onTabUpdated(1, { url: 'https://a.test/again?q=1' })
  await r.settle()
  const c = r.last()
  assert.equal(c.tabUrl, 'https://a.test/again?q=1')
  assert.equal(c.tabOrigin, 'https://a.test')
  assert.equal(c.tabHostname, 'a.test')
  assert.equal(c.tabFavicon, 'https://a.test/f.ico')
  assert.equal(c.tabTitle, 'Again')
})

test('POLICY: internal -> incognito hides; incognito/popup/missing-tab stay trackable:false and leak no title', async () => {
  const r = await started()
  r.windows = [win(1, [tab(1, 'chrome://newtab/', { active: true, title: 'New Tab' })], { focused: true })]
  r.t.onTabUpdated(1, { url: 'chrome://newtab/' })
  await r.settle()
  assert.equal(r.last().tabTitle, 'New Tab')

  // Focus moves to an incognito window: withdrawn at once and stays hidden.
  r.windows = [
    win(1, [tab(1, 'chrome://newtab/', { active: true, title: 'New Tab' })]),
    win(2, [tab(5, 'chrome://newtab/', { active: true, title: 'Private new tab' })], { focused: true, incognito: true }),
  ]
  r.t.onFocusChanged(2)
  assert.equal(r.last().trackable, false)
  await r.settle()
  assert.equal(r.last().trackable, false)
  assert.equal(r.last().tabTitle, '')
  r.t.onFocusChanged(WINDOW_ID_NONE)
  assert.equal(r.last().trackable, false, 'older internal title not resurrected')
  assert.equal(r.last().tabTitle, '')
  assert.ok(!JSON.stringify(r.emitted).includes('Private new tab'))

  // Focused popup/devtools-type window: hidden.
  const p = await started()
  p.windows = [{ id: 7, type: 'popup', focused: true, tabs: [tab(9, 'chrome://newtab/', { active: true, title: 'Popup' })] }, win(1, [tab(1, 'https://a.test/', { active: true })])]
  p.t.onFocusChanged(7)
  await p.settle()
  assert.equal(p.last().trackable, false)
  assert.equal(p.last().tabTitle, '')

  // Focused window without a usable active tab (missing id): hidden.
  const m = await started()
  m.windows = [win(1, [{ url: 'chrome://newtab/', title: 'No id', active: true }], { focused: true })]
  m.t.onTabUpdated(1, { title: 'x' })
  await m.settle()
  assert.equal(m.last().trackable, false)
  assert.equal(m.last().tabTitle, '')
})

test('POLICY: blur keeps the internal page title only as retained memory state (controller decides hideOnUnfocus); no URL', async () => {
  const r = await started()
  r.windows = [win(1, [tab(1, 'chrome://newtab/', { active: true, title: 'New Tab' })], { focused: true })]
  r.t.onTabUpdated(1, { url: 'chrome://newtab/' })
  await r.settle()
  r.t.onFocusChanged(WINDOW_ID_NONE)
  const c = r.last()
  assert.equal(c.focused, false)
  assert.equal(c.trackable, true)
  assert.equal(c.tabTitle, 'New Tab')
  assert.deepEqual({ tabUrl: c.tabUrl, tabOrigin: c.tabOrigin, tabHostname: c.tabHostname, tabFavicon: c.tabFavicon }, NO_URL_FIELDS)
  assert.ok(!JSON.stringify([...r.session.values()]).includes('New Tab'), 'title never persisted')
})

test('disabled tracker ignores every event kind; nothing persisted but numeric ids', async () => {
  const r = rig()
  r.windows = [win(1, [tab(1, 'https://secret.test/p?q=1', { active: true, title: 'Very private' })], { focused: true })]
  r.t.onTabActivated({ tabId: 1, windowId: 1 })
  r.t.onTabUpdated(1, { title: 'x' })
  await r.settle()
  assert.equal(r.queries, 0)
  r.t.setEnabled(true)
  await r.settle()
  const saved = JSON.stringify([...r.session.values()])
  assert.ok(!saved.includes('secret'))
  assert.ok(!saved.includes('private'))
})

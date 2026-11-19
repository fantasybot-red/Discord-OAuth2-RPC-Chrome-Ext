/**
 * Browser activity tracker.
 *
 * Collects the active tab of the focused *normal, non-incognito* window and
 * turns it into a BrowserContext for the controller. All Chrome access is
 * injected (`TrackerApi`) so it can be tested with fakes.
 *
 * Privacy / correctness rules:
 *  - Nothing is read while tracking is disabled (`setEnabled(false)`).
 *  - Only `chrome.windows.getAll({populate, windowTypes:['normal']})`; no
 *    arbitrary tab queries. Incognito windows/tabs are never inspected.
 *  - Only http(s) tabs are trackable; chrome:, chrome-extension:, devtools:,
 *    about:, file: ... yield `trackable: false` with blank metadata.
 *  - Losing focus (WINDOW_ID_NONE) hides immediately and invalidates every
 *    in-flight query via a monotonic ticket, so a late result cannot restore it.
 *  - chrome.storage.session holds only numeric ids/timestamps (no URLs, titles
 *    or history); it is cleared by Chrome on browser restart.
 *  - `tabOpenedAt` is the real creation time only for tabs seen via onCreated;
 *    tabs that already existed when the worker/extension started are "first
 *    seen = now" (Chrome exposes no creation time; lastAccessed is NOT used).
 */
import type { BrowserContext } from '../shared/types.ts'
import type { Clock } from '../lib/gateway.ts'

export const WINDOW_ID_NONE = -1
export const TRACKER_DEBOUNCE_MS = 250
/** Continuous events (loading status, animated titles) cannot postpone a read past this. */
export const TRACKER_MAX_WAIT_MS = 1000
export const TRACKER_SESSION_KEY = 'tracker'

export interface TabLike {
  id?: number
  windowId?: number
  active?: boolean
  incognito?: boolean
  url?: string
  title?: string
  favIconUrl?: string
}

export interface WindowLike {
  id?: number
  focused?: boolean
  incognito?: boolean
  type?: string
  tabs?: TabLike[]
}

export interface TrackerApi {
  /** chrome.windows.getAll({ populate: true, windowTypes: ['normal'] }) */
  getWindows(): Promise<WindowLike[]>
  /**
   * chrome.windows.get(id) WITHOUT populate: only type/incognito/focused, no tab
   * data. Used to tell "a normal window is transiently unfocused" apart from
   * "a popup/devtools/private window has focus". Resolve null when it can't be
   * read. If omitted, an unconfirmable focus target is treated as ineligible.
   */
  getWindow?(windowId: number): Promise<WindowLike | null>
  sessionGet(key: string): Promise<unknown>
  sessionSet(key: string, value: unknown): Promise<void>
}

export interface TrackerDeps {
  api: TrackerApi
  clock: Clock
  emit(context: BrowserContext | null): void
}

interface SessionState {
  browserStartedAt: number
  /** tab id -> epoch ms first seen/created. Numeric only. */
  opened: Record<string, number>
  activeTabId: number | null
  activeAt: number
}

const MAX_TITLE = 256
const MAX_URL = 2048

function isWebUrl(url: string | undefined): url is string {
  if (!url) return false
  try {
    const protocol = new URL(url).protocol
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}

function emptyContext(focused: boolean, base: Partial<BrowserContext> = {}): BrowserContext {
  return {
    focused,
    trackable: false,
    tabTitle: '',
    tabUrl: '',
    tabOrigin: '',
    tabHostname: '',
    tabFavicon: '',
    tabCount: 0,
    windowCount: 0,
    windowTabCount: 0,
    browserStartedAt: 0,
    tabOpenedAt: 0,
    tabActiveAt: 0,
    ...base,
  }
}

export class Tracker {
  private readonly d: TrackerDeps
  private enabled = false
  private ticket = 0
  private timer: unknown = null
  /** After WINDOW_ID_NONE, getAll results are forced to unfocused until a real focus event. */
  private noFocus = false
  private state: SessionState = { browserStartedAt: 0, opened: {}, activeTabId: null, activeAt: 0 }
  private loaded: Promise<void> | null = null
  private lastKey: string | null = null
  private saveChain: Promise<void> = Promise.resolve()
  private pendingFocus: number | null = null
  /**
   * Memory only. The last *focused* observation, if (and only if) it was an
   * eligible tab. Any private/internal/unreadable observation clears it, so a
   * later focus loss can never resurrect an older eligible tab. Whether it is
   * actually shown while unfocused is the controller's `hideOnUnfocus` decision.
   */
  private retained: BrowserContext | null = null
  private retainedTabId: number | null = null
  /**
   * Window id named by the latest chrome.tabs.onActivated since the last read
   * (numeric, memory only). A user tab switch is evidence Chrome is focused; it
   * may release the "no focus" latch, but only if that exact window is then
   * confirmed focused + normal + non-private by the read.
   */
  private activationWindowId: number | null = null
  /** Clock time of the oldest event still waiting for its read (caps debounce starvation). */
  private pendingSince: number | null = null

  constructor(deps: TrackerDeps) {
    this.d = deps
  }

  // ---- control -------------------------------------------------------------

  /** Loads the session baseline (idempotent). */
  init(): Promise<void> {
    if (!this.loaded) this.loaded = this.load()
    return this.loaded
  }

  /** Chrome browser start: new baseline, forget all per-tab timestamps. */
  async onBrowserStartup(): Promise<void> {
    await this.init()
    this.state = { browserStartedAt: this.d.clock.now(), opened: {}, activeTabId: null, activeAt: 0 }
    await this.save()
    this.schedule(0)
  }

  /** Tracking toggle: nothing is read while off, and the context is withdrawn. */
  setEnabled(enabled: boolean): void {
    if (enabled === this.enabled) return
    this.enabled = enabled
    this.cancel()
    this.ticket += 1
    this.clearRetained()
    this.pendingFocus = null
    if (enabled) {
      this.noFocus = false
      this.schedule(0)
    } else {
      this.lastKey = null
      this.d.emit(null)
    }
  }

  // ---- Chrome events (all cheap; real work is debounced) ---------------------

  onFocusChanged(windowId: number): void {
    if (!this.enabled) return
    if (windowId === WINDOW_ID_NONE) {
      // Chrome lost focus: invalidate pending queries so they cannot restore a
      // newer view, and publish the unfocused state now. It carries the last
      // eligible tab only if the last focused observation was eligible.
      this.noFocus = true
      this.activationWindowId = null
      this.pendingFocus = null
      this.cancel()
      this.ticket += 1
      this.publish(this.unfocusedContext())
      return
    }
    this.noFocus = false
    this.activationWindowId = null
    // The focused window changed: withdraw the previous tab's metadata at once
    // (an incognito/special window must never inherit it). The retained
    // candidate is kept (not trusted) until the read confirms what is focused;
    // a confirmed private/internal window clears it. The debounced read
    // publishes the new window's tab.
    this.pendingFocus = windowId
    this.publish(emptyContext(true, { browserStartedAt: this.state.browserStartedAt }))
    this.schedule()
  }

  onTabCreated(tab: TabLike): void {
    if (!this.enabled) return
    if (typeof tab.id === 'number' && !tab.incognito) this.state.opened[String(tab.id)] = this.d.clock.now()
    this.schedule()
  }

  /**
   * Pass chrome's `{ windowId }` so a tab switch can recover from a latched
   * "no focus" state (Chrome sometimes sends no onFocusChanged for it). Without
   * the argument the latch is never released by this event.
   */
  onTabActivated(info?: { tabId?: number; windowId?: number }): void {
    if (!this.enabled) return
    this.activationWindowId = this.noFocus && typeof info?.windowId === 'number' ? info.windowId : null
    this.schedule()
  }

  onTabUpdated(_tabId: number, changeInfo: { url?: string; title?: string; favIconUrl?: string; status?: string }): void {
    if (!this.enabled) return
    if (changeInfo.url === undefined && changeInfo.title === undefined && changeInfo.favIconUrl === undefined && changeInfo.status === undefined) return
    this.schedule()
  }

  onTabRemoved(tabId: number): void {
    delete this.state.opened[String(tabId)]
    if (this.state.activeTabId === tabId) this.state.activeTabId = null
    if (this.enabled && this.noFocus && this.retainedTabId === tabId) {
      // The retained (unfocused) tab no longer exists: stop showing it.
      this.clearRetained()
      this.publish(this.unfocusedContext())
    }
    if (this.enabled) this.schedule()
  }

  onTabReplaced(addedTabId: number, removedTabId: number): void {
    const opened = this.state.opened[String(removedTabId)]
    delete this.state.opened[String(removedTabId)]
    if (opened !== undefined) this.state.opened[String(addedTabId)] = opened
    // Same logical tab: keep the active timestamp.
    if (this.state.activeTabId === removedTabId) this.state.activeTabId = addedTabId
    if (this.retainedTabId === removedTabId) this.retainedTabId = addedTabId
    if (this.enabled) this.schedule()
  }

  onWindowRemoved(): void {
    if (this.enabled) this.schedule()
  }

  /** Forces an immediate re-collection (tests / startup). */
  refreshNow(): Promise<void> {
    this.cancel()
    return this.refresh()
  }

  // ---- internals -----------------------------------------------------------

  private schedule(delay = TRACKER_DEBOUNCE_MS): void {
    if (!this.enabled) return
    if (this.timer !== null) {
      this.d.clock.clearTimeout(this.timer)
      this.timer = null
    }
    // Any event makes an in-flight read outdated *now*, so it cannot publish
    // during the debounce window; only the next scheduled read may.
    this.ticket += 1
    // Debounce, but never let a steady stream of events (page loading, animated
    // titles) push the read back forever: wait at most TRACKER_MAX_WAIT_MS.
    const now = this.d.clock.now()
    if (this.pendingSince === null) this.pendingSince = now
    const remaining = Math.max(0, this.pendingSince + TRACKER_MAX_WAIT_MS - now)
    this.timer = this.d.clock.setTimeout(() => {
      this.timer = null
      this.pendingSince = null
      void this.refresh()
    }, Math.min(delay, remaining))
  }

  private cancel(): void {
    this.pendingSince = null
    if (this.timer !== null) {
      this.d.clock.clearTimeout(this.timer)
      this.timer = null
    }
  }

  private async refresh(): Promise<void> {
    if (!this.enabled) return
    const ticket = ++this.ticket
    let windows: WindowLike[]
    try {
      await this.init()
      windows = await this.d.api.getWindows()
    } catch {
      // Fail closed: never leave the previous tab's title published when the
      // browser state cannot be read.
      if (ticket === this.ticket && this.enabled) {
        this.clearRetained()
        this.publish(emptyContext(!this.noFocus, { browserStartedAt: this.state.browserStartedAt }))
      }
      return
    }
    // Disabled, unfocused or superseded while the query was in flight.
    if (ticket !== this.ticket || !this.enabled) return

    // Release the "no focus" latch only for a user tab switch whose window is
    // confirmed focused, normal and non-private by this (still current) read.
    // Any NONE/focus event after the activation already cleared the hint and
    // superseded this ticket, so a stale read cannot get here.
    const hint = this.activationWindowId
    this.activationWindowId = null
    if (this.noFocus && hint !== null && windows.some((w) => w.id === hint && w.focused === true && w.type === 'normal' && !w.incognito)) {
      this.noFocus = false
    }

    // A focus event named a window, but no normal window reports focus. That is
    // either a transient/minimized normal window (keep the retained tab) or a
    // popup/devtools/private window that really has focus (must clear). Ask
    // Chrome about that one window, without tab data, to tell them apart.
    let ineligibleFocus = false
    const hasFocused = windows.some((w) => w.focused === true && w.type === 'normal' && !w.incognito)
    if (!this.noFocus && !hasFocused && this.pendingFocus !== null) {
      ineligibleFocus = !(await this.focusTargetIsNormal(this.pendingFocus))
      if (ticket !== this.ticket || !this.enabled) return
    }
    this.publish(this.build(windows, ineligibleFocus))
    await this.save()
  }

  /** True only when the window is confirmed to be a normal, non-private window. */
  private async focusTargetIsNormal(windowId: number): Promise<boolean> {
    const getWindow = this.d.api.getWindow
    if (!getWindow) return false
    try {
      const info = await getWindow.call(this.d.api, windowId)
      return !!info && info.type === 'normal' && !info.incognito
    } catch {
      return false
    }
  }

  private build(windows: WindowLike[], ineligibleFocus = false): BrowserContext {
    const now = this.d.clock.now()
    const normal = windows.filter((w) => w.type === 'normal' && !w.incognito)
    const base = { browserStartedAt: this.state.browserStartedAt }

    // Track creation timestamps for every normal tab (first seen = now).
    const live = new Set<string>()
    let tabCount = 0
    for (const w of normal) {
      for (const t of w.tabs ?? []) {
        if (typeof t.id !== 'number' || t.incognito) continue
        tabCount += 1
        const key = String(t.id)
        live.add(key)
        if (this.state.opened[key] === undefined) this.state.opened[key] = now
      }
    }
    for (const key of Object.keys(this.state.opened)) if (!live.has(key)) delete this.state.opened[key]

    const focusedWindow = this.noFocus ? undefined : windows.find((w) => w.focused === true)
    // No focused window: never pick an arbitrary current tab. Only the last
    // focused observation (if it was eligible) is carried over, with fresh counts.
    const counts = { ...base, tabCount, windowCount: normal.length }
    if (!focusedWindow) {
      if (ineligibleFocus) {
        // A popup/devtools/private (or unreadable) window has focus: hide and
        // forget the older eligible tab so it can never come back.
        this.clearRetained()
        return emptyContext(true, counts)
      }
      return this.unfocusedContext({ tabCount, windowCount: normal.length })
    }
    this.pendingFocus = null
    // A focused incognito / popup / devtools window is never inspected, and it
    // erases any retained tab so a later focus loss cannot resurrect it.
    if (focusedWindow.type !== 'normal' || focusedWindow.incognito) {
      this.clearRetained()
      return emptyContext(true, counts)
    }
    const windowTabs = (focusedWindow.tabs ?? []).filter((t) => typeof t.id === 'number' && !t.incognito)
    const active = windowTabs.find((t) => t.active === true)
    const withWindow = { ...counts, windowTabCount: windowTabs.length }
    if (!active || typeof active.id !== 'number') {
      this.clearRetained()
      return emptyContext(true, withWindow)
    }

    // Active timestamp only changes when the actual active tab changes.
    if (this.state.activeTabId !== active.id) {
      this.state.activeTabId = active.id
      this.state.activeAt = now
    }
    const tabOpenedAt = this.state.opened[String(active.id)] ?? now
    if (isWebUrl(active.url)) {
      const url = new URL(active.url)
      const context: BrowserContext = {
        focused: true,
        trackable: true,
        tabTitle: (active.title ?? '').trim().slice(0, MAX_TITLE),
        tabUrl: active.url.slice(0, MAX_URL),
        tabOrigin: url.origin,
        tabHostname: url.hostname,
        tabFavicon: isWebUrl(active.favIconUrl) ? active.favIconUrl.slice(0, MAX_URL) : '',
        ...withWindow,
        tabOpenedAt,
        tabActiveAt: this.state.activeAt,
      }
      // Memory only; never written to session/local storage.
      this.retained = context
      this.retainedTabId = active.id
      return context
    }
    const context: BrowserContext = {
      focused: true,
      trackable: true,
      tabTitle: (active.title ?? '').trim().slice(0, MAX_TITLE) || 'Untitled tab',
      tabUrl: '',
      tabOrigin: '',
      tabHostname: '',
      tabFavicon: '',
      ...withWindow,
      tabOpenedAt,
      tabActiveAt: this.state.activeAt,
    }
    // Memory only; never written to session/local storage.
    this.retained = context
    this.retainedTabId = active.id
    return context
  }

  private clearRetained(): void {
    this.retained = null
    this.retainedTabId = null
  }

  /**
   * Context while Chrome has no focused window. Blank unless the last focused
   * observation was an eligible tab, in which case that tab's metadata is kept
   * as `focused: false, trackable: true` (the controller decides whether to
   * show it via hideOnUnfocus). Counts may be refreshed.
   */
  private unfocusedContext(counts: { tabCount?: number; windowCount?: number } = {}): BrowserContext {
    const base = { browserStartedAt: this.state.browserStartedAt }
    const r = this.retained
    if (!r) return emptyContext(false, { ...base, ...counts })
    this.retained = { ...r, focused: false, ...counts }
    return { ...this.retained, browserStartedAt: this.state.browserStartedAt }
  }

  private publish(context: BrowserContext): void {
    const key = JSON.stringify(context)
    if (key === this.lastKey) return
    this.lastKey = key
    this.d.emit(context)
  }

  private async load(): Promise<void> {
    const now = this.d.clock.now()
    let raw: unknown
    try {
      raw = await this.d.api.sessionGet(TRACKER_SESSION_KEY)
    } catch {
      raw = undefined
    }
    const r = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : null
    const opened: Record<string, number> = {}
    if (r && typeof r.opened === 'object' && r.opened !== null) {
      for (const [id, ts] of Object.entries(r.opened as Record<string, unknown>)) {
        if (/^\d+$/.test(id) && typeof ts === 'number' && Number.isFinite(ts)) opened[id] = ts
      }
    }
    // Without a session baseline (fresh browser session or extension reload)
    // "now" is the best available estimate.
    this.state = {
      browserStartedAt: r && typeof r.browserStartedAt === 'number' && r.browserStartedAt > 0 ? r.browserStartedAt : now,
      opened,
      activeTabId: r && typeof r.activeTabId === 'number' ? r.activeTabId : null,
      activeAt: r && typeof r.activeAt === 'number' ? r.activeAt : 0,
    }
  }

  /**
   * Writes an immutable snapshot through a serial chain, so an older write can
   * never land after (and overwrite) a newer one, e.g. a browser-startup reset.
   */
  private save(): Promise<void> {
    const snapshot: SessionState = { ...this.state, opened: { ...this.state.opened } }
    const write = this.saveChain.then(() => this.d.api.sessionSet(TRACKER_SESSION_KEY, snapshot))
    this.saveChain = write.then(
      () => undefined,
      () => undefined, // session storage unavailable: timestamps restart on the next worker start
    )
    return this.saveChain
  }
}


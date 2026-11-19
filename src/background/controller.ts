/**
 * Background controller: OAuth, token lifecycle, gateway connection and
 * presence. All environment access (storage, network, sockets, timers, tabs,
 * alarms) is injected so the logic is testable under node:test.
 *
 * Concurrency model: there is no global mutex around network calls. Instead
 * every long-running operation captures `epoch` + an AbortSignal. Anything that
 * invalidates in-flight work (disconnect, new authorization, settings change,
 * fatal error) calls `invalidate()` synchronously, which bumps the epoch,
 * aborts the signal and closes the socket. After every `await`, operations
 * compare their epoch before mutating state, and state mutation + persistence
 * ordering is synchronous (cache first, then an ordered write chain). A stale
 * request therefore can never restore credentials after a disconnect, and
 * disconnect never waits for the network.
 */
import { buildClearPresence, buildPresence, externalUrls, normalizeActivity } from '../lib/activity.ts'
import {
  ALARM_RECOVER,
  ALARM_REFRESH,
  AUTH_STATE_TTL_MS,
  GATEWAY_URL,
  RECONNECT_BASE_MS,
  RECONNECT_MAX_MS,
  RECOVER_PERIOD_MINUTES,
  TOKEN_REFRESH_MARGIN_MS,
} from '../lib/constants.ts'
import { classifyAssetKinds, classifyErrorKind } from '../lib/diagnostics.ts'
import { bearer, isSnowflake } from '../lib/discord-api.ts'
import type { DiscordApi, TokenSet } from '../lib/discord-api.ts'
import { FatalError, SupersededError, UserError } from '../lib/errors.ts'
import { GatewayConnection, backoffDelay } from '../lib/gateway.ts'
import type { Clock, CloseInfo, ReadyInfo, SocketFactory } from '../lib/gateway.ts'
import {
  buildAuthorizeUrl,
  checkPending,
  createCodeChallenge,
  createCodeVerifier,
  createState,
  parseCallback,
} from '../lib/pkce.ts'
import type { PendingAuth } from '../lib/pkce.ts'
import { activityTimestamps, renderActivityTemplate } from '../lib/templates.ts'
import { AssetCache } from './asset-cache.ts'
import { validateTracking } from './storage.ts'
import { isCommand, isDiagnosticCommand } from '../shared/messages.ts'
import type { CommandResponse, SnapshotCommand } from '../shared/messages.ts'
import type {
  Activity,
  BrowserContext,
  ConnectionState,
  Settings,
  Snapshot,
  TrackingSettings,
} from '../shared/types.ts'
import { loadStored } from './storage.ts'
import type { Credentials, StorageLike, Stored } from './storage.ts'

export interface AlarmsLike {
  create(name: string, info: { when?: number; delayInMinutes?: number; periodInMinutes?: number }): void | Promise<void>
  clear(name: string): void | Promise<unknown>
}

export interface ControllerDeps {
  storage: StorageLike
  assetCache?: AssetCache
  api: DiscordApi
  clock: Clock
  random: () => number
  socketFactory: SocketFactory
  alarms: AlarmsLike
  openTab(url: string): Promise<void>
  /** `chrome.runtime.getURL('callback.html')` */
  redirectUri: string
  /** Optional sanitized debug hook (allowlisted events only). */
  diagnostic?: (event: string, details?: Record<string, unknown>) => void
}

const STABLE_SESSION_MS = 60_000
const MAX_SECRET_LENGTH = 256
/** Discord limits presence updates; tab-driven updates are coalesced to this. */
export const PRESENCE_MIN_INTERVAL_MS = 1_500
const NO_ACTIVITY_ERROR = 'Add an activity in the side panel to show it on Discord.'

export class Controller {
  private readonly d: ControllerDeps
  private s!: Stored
  private loaded = false

  private epoch = 0
  private abort = new AbortController()
  private gw: GatewayConnection | null = null
  private connecting = false
  private retryTimer: unknown = null
  private attempt = 0
  private refreshing: Promise<string> | null = null
  private triedRefreshAfter4004 = false
  private refreshFailures = 0
  private writeChain: Promise<void> = Promise.resolve()
  private presenceSeq = 0
  private readonly assetCache: AssetCache
  /** Live tab context: memory only, never persisted. */
  private browser: BrowserContext | null = null
  private trackingError: string | null = null
  private lastSendAt = 0
  private lastSentKey: string | null = null
  private shown = false
  private presenceCreatedAt = 0
  private uiTimer: unknown = null
  private applyTimer: unknown = null
  private readonly listeners = new Set<() => void>()
  private lastContextKey: string | null = null
  private lastHidden: string | null = null

  constructor(deps: ControllerDeps) {
    this.d = deps
    this.assetCache = deps.assetCache ?? new AssetCache(undefined, () => deps.clock.now())
  }

  private log(event: string, details?: Record<string, unknown>): void {
    try {
      this.d.diagnostic?.(event, details)
    } catch {
      /* diagnostics must never affect behaviour */
    }
  }

  // ---- lifecycle ----------------------------------------------------------

  /** Loads persisted state and resumes the desired connection. */
  async init(): Promise<void> {
    this.s = await loadStored(this.d.storage)
    this.loaded = true
    this.log('init')
    const s = this.s
    const patch: Partial<Stored> = {}

    if (s.pending && this.d.clock.now() > s.pending.expiresAt) {
      patch.pending = null
      s.pending = null
    }
    if (s.desired && s.credentials) {
      patch.status = { connection: 'connecting', error: null }
    } else {
      if (s.desired) patch.desired = false
      if (s.pending) {
        patch.status = { connection: 'authorizing', error: null }
      } else if (s.status.connection !== 'error') {
        patch.status = { connection: 'disconnected', error: null }
      }
    }
    if (Object.keys(patch).length > 0) await this.commitSafe(patch)
    this.notify()
    if (this.s.desired && this.s.credentials) {
      this.ensureAlarms()
      this.scheduleRefreshAlarm(this.s.credentials)
      void this.connect()
    }
  }

  async onAlarm(name: string): Promise<void> {
    if (!this.loaded) return
    if (name !== ALARM_RECOVER && name !== ALARM_REFRESH) return
    if (!this.s.desired || !this.s.credentials) return
    // Both alarms first make sure the token is fresh, even while a session is
    // connected, then make sure a connection exists.
    await this.maintainToken()
    if (name === ALARM_RECOVER && this.s.desired && this.s.credentials) {
      if (!this.gw && !this.connecting && this.retryTimer === null) void this.connect()
    }
  }

  /**
   * Refreshes the token if due. Transient failures re-arm the refresh alarm
   * (bounded delay) instead of waiting for a reconnect; fatal ones stop.
   */
  private async maintainToken(): Promise<void> {
    const creds = this.s.credentials
    if (!creds || !this.tokenNeedsRefresh(creds)) return
    const epoch = this.epoch
    try {
      await this.refreshCredentials(epoch, this.abort.signal)
    } catch (error) {
      if (epoch !== this.epoch || error instanceof SupersededError) return
      if (error instanceof FatalError || error instanceof UserError) {
        await this.fatalStop(error.message, error instanceof FatalError && error.clearCredentials)
        return
      }
      this.refreshFailures += 1
      const retryMs = Math.min(60_000, 30_000 * this.refreshFailures)
      void this.d.alarms.create(ALARM_REFRESH, { when: this.d.clock.now() + retryMs })
    }
  }

  /** Entry point for validated runtime messages. */
  async handle(command: unknown): Promise<CommandResponse> {
    try {
      if (!isCommand(command) || isDiagnosticCommand(command)) throw new UserError('Unknown command.')
      return { ok: true, snapshot: await this.run(command) }
    } catch (error) {
      if (error instanceof SupersededError) return { ok: false, error: 'The operation was cancelled.' }
      if (error instanceof UserError || error instanceof FatalError) return { ok: false, error: error.message }
      return { ok: false, error: 'Something went wrong. Try again.' }
    }
  }

  private run(command: SnapshotCommand): Promise<Snapshot> {
    switch (command.type) {
      case 'getSnapshot':
        return Promise.resolve(this.snapshot())
      case 'saveSettings':
        return this.saveSettings(command.settings)
      case 'startAuth':
        return this.startAuth()
      case 'disconnect':
        return this.disconnect()
      case 'setActivity':
        return this.setActivity(command.activity)
      case 'clearActivity':
        return this.clearActivity()
      case 'completeAuth':
        return this.completeAuth(command.callbackUrl)
      case 'saveTrackingSettings':
        return this.saveTrackingSettings(command.tracking)
      case 'toggleTracking':
        return this.toggleTracking()
    }
  }

  /** Subscribes to state changes (badge updates). Returns an unsubscribe. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => void this.listeners.delete(listener)
  }

  private notify(): void {
    for (const listener of this.listeners) {
      try {
        listener()
      } catch {
        /* listeners must not break state transitions */
      }
    }
  }

  /** Whether a presence is currently published (for the toolbar badge). */
  get presenceShown(): boolean {
    return this.shown
  }

  get trackingEnabled(): boolean {
    return this.loaded && this.s.tracking.enabled
  }

  get isLoaded(): boolean {
    return this.loaded
  }

  /** No usable application ID saved yet (toolbar click should open settings). */
  get needsSetup(): boolean {
    return this.loaded && !isSnowflake(this.s.settings.clientId)
  }

  // ---- snapshot -----------------------------------------------------------

  snapshot(): Snapshot {
    this.expirePending()
    const s = this.s
    const browser = this.browser
      ? { ...this.browser, tabUrl: s.tracking.allowUrlSharing ? this.browser.tabUrl : '' }
      : null
    return {
      tracking: { ...s.tracking },
      browser,
      trackingError: this.trackingError ?? (s.tracking.enabled && !s.activity.name ? NO_ACTIVITY_ERROR : null),
      settings: { ...s.settings },
      activity: { ...s.activity },
      connection: s.status.connection,
      error: s.status.error,
      user: s.user ? { ...s.user } : null,
      hasCredentials: s.credentials !== null,
      activityEnabled: s.activityEnabled,
      redirectUri: this.d.redirectUri,
    }
  }

  /** Test/diagnostic access; never exposed to UI. */
  peek(): Readonly<Stored> {
    return this.s
  }

  // ---- commands -----------------------------------------------------------

  async saveSettings(input: Settings): Promise<Snapshot> {
    const clientId = typeof input?.clientId === 'string' ? input.clientId.trim() : ''
    const clientSecret = typeof input?.clientSecret === 'string' ? input.clientSecret.trim() : ''
    if (clientId && !isSnowflake(clientId)) throw new UserError('Application ID must be 17-20 digits.')
    if (clientSecret.length > MAX_SECRET_LENGTH) throw new UserError('Client secret is too long.')

    const prev = this.s.settings
    if (prev.clientId === clientId && prev.clientSecret === clientSecret) return this.snapshot()

    const patch: Partial<Stored> = { settings: { clientId, clientSecret } }
    if (prev.clientId !== clientId) {
      // Credentials belong to one application: a new ID is a full reset.
      this.invalidate()
      this.stopAlarms()
      Object.assign(patch, this.resetPatch())
    } else if (this.s.pending) {
      patch.pending = null
      patch.status = { connection: 'disconnected', error: null }
    }
    await this.commit(patch)
    return this.snapshot()
  }

  async startAuth(): Promise<Snapshot> {
    const clientId = this.s.settings.clientId
    if (!isSnowflake(clientId)) throw new UserError('Enter a valid application ID before authorizing.')

    // A new authorization replaces any pending/expired one and stops any live
    // session so stale work cannot complete into the new flow.
    this.invalidate()
    this.stopAlarms()
    const epoch = this.epoch

    const verifier = createCodeVerifier()
    const challenge = await createCodeChallenge(verifier)
    if (epoch !== this.epoch) throw new SupersededError()

    const now = this.d.clock.now()
    const pending: PendingAuth = {
      state: createState(),
      verifier,
      clientId,
      redirectUri: this.d.redirectUri,
      createdAt: now,
      expiresAt: now + AUTH_STATE_TTL_MS,
    }
    const url = buildAuthorizeUrl({
      clientId,
      redirectUri: this.d.redirectUri,
      state: pending.state,
      codeChallenge: challenge,
    })
    await this.commit({
      ...this.resetPatch(),
      pending,
      status: { connection: 'authorizing', error: null },
    })
    // A disconnect / settings change / newer startAuth during the write wins:
    // do not open a tab for an authorization that was already invalidated.
    if (epoch !== this.epoch) throw new UserError('Authorization was cancelled.')
    this.log('auth_started')
    try {
      await this.d.openTab(url)
    } catch {
      this.log('auth_failed', { reason: 'tab' })
      if (epoch === this.epoch) {
        await this.commitSafe({ pending: null, status: { connection: 'error', error: 'Could not open the Discord authorization tab.' } })
      }
      throw new UserError('Could not open the Discord authorization tab.')
    }
    return this.snapshot()
  }

  async completeAuth(callbackUrl: string): Promise<Snapshot> {
    const result = parseCallback(callbackUrl, this.d.redirectUri)
    const pending = this.s.pending

    // An unrelated error callback must never consume the current attempt, even
    // if that attempt has expired or its settings have changed.
    if (result.kind === 'error' && pending && result.state !== pending.state) {
      throw new UserError('Ignored an authorization error that does not belong to this session.')
    }

    const check = checkPending(pending, result.state, this.s.settings.clientId, this.d.clock.now())
    if (!check.ok || !pending || pending.redirectUri !== this.d.redirectUri) {
      const reason = check.ok ? 'state-mismatch' : check.reason
      this.log('auth_failed', { reason: reason === 'expired' ? 'expired' : reason === 'none' ? 'none' : 'mismatch' })
      if (reason === 'expired' || reason === 'client-changed') {
        await this.commitSafe({
          pending: null,
          status: { connection: 'disconnected', error: reason === 'expired' ? 'Authorization expired. Start again.' : null },
        })
      }
      throw new UserError(
        reason === 'expired'
          ? 'Authorization expired. Start again.'
          : reason === 'none'
            ? 'No authorization is in progress. Start it from the extension.'
            : 'This callback does not match the current authorization.',
      )
    }

    if (result.kind === 'error') {
      const message = `Discord authorization failed: ${result.error}${result.description ? ` (${result.description})` : ''}`
      this.log('auth_failed', { reason: 'denied' })
      await this.commitSafe({ pending: null, status: { connection: 'error', error: 'Discord authorization failed.' } })
      throw new UserError(message)
    }

    // Consume exactly once, before any network work.
    const epoch = this.epoch
    const signal = this.abort.signal
    await this.commit({ pending: null, status: { connection: 'connecting', error: null } })
    if (epoch !== this.epoch) throw new UserError('Authorization was cancelled.')

    let tokens: TokenSet
    try {
      tokens = await this.d.api.exchangeCode({
        clientId: pending.clientId,
        clientSecret: this.s.settings.clientSecret || undefined,
        code: result.code,
        verifier: pending.verifier,
        redirectUri: pending.redirectUri,
        signal,
      })
    } catch (error) {
      if (epoch !== this.epoch || error instanceof SupersededError) throw new UserError('Authorization was cancelled.')
      this.log('auth_failed', { reason: 'exchange' })
      const message = error instanceof UserError || error instanceof FatalError ? error.message : 'Could not complete sign-in. Try again.'
      await this.commitSafe({ status: { connection: 'error', error: message } })
      throw new UserError(message)
    }
    if (epoch !== this.epoch) throw new UserError('Authorization was cancelled.')

    let user = null
    try {
      user = await this.d.api.getUser(tokens.accessToken, signal)
    } catch (error) {
      if (epoch !== this.epoch || error instanceof SupersededError) throw new UserError('Authorization was cancelled.')
      // Profile is optional here; READY will provide it.
    }
    if (epoch !== this.epoch) throw new UserError('Authorization was cancelled.')

    const credentials: Credentials = {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt,
      scope: tokens.scope,
      clientId: pending.clientId,
    }
    await this.commit({
      credentials,
      user,
      desired: true,
      status: { connection: 'connecting', error: null },
    })
    // Disconnect raced the write: its later commit already cleared everything;
    // do not recreate alarms or connect.
    if (epoch !== this.epoch) throw new UserError('Authorization was cancelled.')
    this.attempt = 0
    this.log('auth_completed')
    this.ensureAlarms()
    this.scheduleRefreshAlarm(credentials)
    void this.connect()
    return this.snapshot()
  }

  async disconnect(): Promise<Snapshot> {
    // Synchronous invalidation: in-flight exchange/refresh/connect are aborted
    // and can no longer write, so nothing here waits on the network.
    this.invalidate()
    this.stopAlarms()
    await this.commit({ ...this.resetPatch(), status: { connection: 'disconnected', error: null } })
    return this.snapshot()
  }

  /** Saves the raw template; it is rendered only when presence is sent. */
  async setActivity(input: Activity): Promise<Snapshot> {
    const activity = normalizeActivity(input)
    await this.commit({ activity, activityEnabled: true })
    void this.applyPresence()
    return this.snapshot()
  }

  async clearActivity(): Promise<Snapshot> {
    await this.commit({ activityEnabled: false })
    void this.applyPresence()
    return this.snapshot()
  }

  /** Updates tracking preferences only; OAuth settings and tokens are untouched. */
  async saveTrackingSettings(input: unknown): Promise<Snapshot> {
    const result = validateTracking(input)
    if (!result.ok) throw new UserError(result.error)
    return this.applyTracking(result.tracking)
  }

  /** Toolbar-icon toggle: presence ON/OFF without touching the OAuth connection. */
  async toggleTracking(): Promise<Snapshot> {
    return this.applyTracking({ ...this.s.tracking, enabled: !this.s.tracking.enabled })
  }

  private async applyTracking(tracking: TrackingSettings): Promise<Snapshot> {
    const patch: Partial<Stored> = { tracking }
    if (tracking.enabled !== this.s.tracking.enabled) this.log('tracking_toggled', { enabled: tracking.enabled })
    // Turning tracking on shows the saved activity without a second step.
    if (tracking.enabled && !this.s.tracking.enabled && this.s.activity.name) patch.activityEnabled = true
    try {
      await this.commit(patch)
    } finally {
      // In-memory state changed even if persisting failed; keep tracker/badge in sync.
      this.notify()
    }
    void this.applyPresence()
    return this.snapshot()
  }

  /**
   * Receives the latest browser context from the tracker (memory only). A
   * `null`, unfocused or untrackable context hides the presence immediately.
   */
  updateBrowserContext(context: BrowserContext | null): void {
    this.browser = context ? { ...context } : null
    const key = context ? [context.focused, context.trackable, context.tabCount, context.windowCount].join() : 'none'
    if (key !== this.lastContextKey) {
      this.lastContextKey = key
      this.log(
        'context_updated',
        context
          ? { focused: context.focused, trackable: context.trackable, tabCount: context.tabCount, windowCount: context.windowCount }
          : undefined,
      )
    }
    this.touchUi()
    void this.applyPresence()
  }

  // ---- connection ---------------------------------------------------------

  private async connect(): Promise<void> {
    if (!this.s.desired || !this.s.credentials) return
    if (this.gw || this.connecting) return
    const epoch = this.epoch
    const signal = this.abort.signal
    this.connecting = true
    try {
      if (this.s.status.connection !== 'connecting') {
        await this.commitSafe({ status: { connection: 'connecting', error: this.s.status.error } })
        if (epoch !== this.epoch) return
      }
      const token = await this.freshAccessToken(epoch, signal)
      if (epoch !== this.epoch) return
      this.openGateway(token, epoch)
    } catch (error) {
      await this.onConnectError(error, epoch)
    } finally {
      if (epoch === this.epoch) this.connecting = false
    }
  }

  private async onConnectError(error: unknown, epoch: number): Promise<void> {
    if (epoch !== this.epoch || error instanceof SupersededError) return
    if (error instanceof FatalError) return this.fatalStop(error.message, error.clearCredentials)
    if (error instanceof UserError) return this.fatalStop(error.message, false)
    await this.scheduleRetry('Could not reach Discord. Retrying...')
  }

  private openGateway(accessToken: string, epoch: number): void {
    const gw: GatewayConnection = new GatewayConnection({
      url: GATEWAY_URL,
      token: bearer(accessToken),
      factory: this.d.socketFactory,
      clock: this.d.clock,
      random: this.d.random,
      onReady: (info) => this.onGatewayReady(gw, epoch, info),
      onClose: (info) => void this.onGatewayClose(gw, epoch, info),
    })
    this.gw = gw
    this.log('gateway_connecting')
    gw.start()
  }

  private onGatewayReady(gw: GatewayConnection, epoch: number, info: ReadyInfo): void {
    if (gw !== this.gw || epoch !== this.epoch) return
    this.triedRefreshAfter4004 = false
    this.log('gateway_ready')
    // A new session starts with nothing shown; context is applied after READY.
    this.shown = false
    this.lastSentKey = null
    this.lastSendAt = 0
    const patch: Partial<Stored> = { status: { connection: 'connected', error: null } }
    if (info.user) patch.user = info.user
    void this.commitSafe(patch).then(() => {
      if (gw === this.gw && epoch === this.epoch) return this.applyPresence()
    })
  }

  private async onGatewayClose(gw: GatewayConnection, epoch: number, info: CloseInfo): Promise<void> {
    if (gw !== this.gw || epoch !== this.epoch) return
    this.gw = null
    this.log('gateway_closed', { code: info.code, fatal: info.fatal, authFailed: info.authFailed })
    if (info.readyMs >= STABLE_SESSION_MS) this.attempt = 0
    this.shown = false
    this.lastSentKey = null
    this.notify()
    const creds = this.s.credentials

    if (info.authFailed) {
      if (creds?.refreshToken && !this.triedRefreshAfter4004) {
        // The token may have been revoked/expired server-side: rotate once.
        this.triedRefreshAfter4004 = true
        await this.commitSafe({ credentials: { ...creds, expiresAt: 0 } })
        if (epoch !== this.epoch) return
        await this.scheduleRetry('Refreshing the Discord session...', 0)
        return
      }
      return this.fatalStop('Discord rejected the access token. Authorize again.', true)
    }
    if (info.fatal) {
      return this.fatalStop(
        `Discord closed the connection (code ${info.code}). Check the application settings (Public Client, Social SDK) and authorize again.`,
        false,
      )
    }
    await this.scheduleRetry(info.local ? 'Connection lost. Reconnecting...' : `Disconnected from Discord (code ${info.code}). Reconnecting...`)
  }

  private async scheduleRetry(message: string, forcedDelay?: number): Promise<void> {
    if (this.retryTimer !== null || !this.s.desired) return
    const epoch = this.epoch
    this.attempt += 1
    const delay = forcedDelay ?? backoffDelay(this.attempt, this.d.random, RECONNECT_BASE_MS, RECONNECT_MAX_MS)
    this.retryTimer = this.d.clock.setTimeout(() => {
      this.retryTimer = null
      if (epoch === this.epoch) void this.connect()
    }, delay)
    this.log('retry_scheduled', { attempt: this.attempt, delayMs: delay })
    await this.commitSafe({ status: { connection: 'connecting', error: message } })
  }

  /** Stop retrying; keep or discard credentials; surface a helpful error. */
  private async fatalStop(message: string, clearCredentials: boolean): Promise<void> {
    this.invalidate()
    this.stopAlarms()
    const patch: Partial<Stored> = {
      desired: false,
      pending: null,
      status: { connection: 'error', error: message },
    }
    if (clearCredentials) {
      patch.credentials = null
      patch.user = null
    }
    await this.commitSafe(patch)
  }

  // ---- tokens -------------------------------------------------------------

  private tokenNeedsRefresh(creds: Credentials): boolean {
    return this.d.clock.now() >= creds.expiresAt - TOKEN_REFRESH_MARGIN_MS
  }

  private async freshAccessToken(epoch: number, signal: AbortSignal): Promise<string> {
    const creds = this.s.credentials
    if (!creds) throw new FatalError('Not authorized.', false)
    if (!this.tokenNeedsRefresh(creds)) return creds.accessToken
    if (!creds.refreshToken && this.d.clock.now() < creds.expiresAt) return creds.accessToken
    return this.refreshCredentials(epoch, signal)
  }

  /** Single-flight refresh; rotates the refresh token. */
  private refreshCredentials(epoch: number, signal: AbortSignal): Promise<string> {
    if (this.refreshing) return this.refreshing
    const creds = this.s.credentials
    if (!creds) return Promise.reject(new FatalError('Not authorized.', false))
    if (!creds.refreshToken) {
      return Promise.reject(new FatalError('Your Discord session expired. Authorize again.', true))
    }
    const refreshToken = creds.refreshToken
    this.log('refresh_started')
    const promise = (async () => {
      const tokens = await this.d.api.refresh({
        clientId: creds.clientId,
        clientSecret: this.s.settings.clientSecret || undefined,
        refreshToken,
        accessToken: creds.accessToken,
        signal,
      })
      // Stale result (disconnect / new auth happened meanwhile): discard.
      if (epoch !== this.epoch || !this.s.credentials) throw new SupersededError()
      const next: Credentials = {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken ?? refreshToken,
        expiresAt: tokens.expiresAt,
        scope: tokens.scope || creds.scope,
        clientId: creds.clientId,
      }
      await this.commit({ credentials: next })
      if (epoch !== this.epoch) throw new SupersededError()
      this.refreshFailures = 0
      this.scheduleRefreshAlarm(next)
      this.log('refresh_succeeded')
      return next.accessToken
    })()
    this.refreshing = promise
    const release = () => {
      if (this.refreshing === promise) this.refreshing = null
    }
    promise.then(release, (error: unknown) => {
      release()
      if (!(error instanceof SupersededError)) this.log('refresh_failed', { errorKind: classifyErrorKind(error) })
    })
    return promise
  }

  // ---- presence -----------------------------------------------------------

  private async applyPresence(): Promise<void> {
    // Every call takes a ticket; anything older (late async work, queued
    // timers) sees a newer ticket and is discarded instead of restoring state.
    const seq = ++this.presenceSeq
    this.clearApplyTimer()
    const gw = this.gw
    const sessionId = gw?.sessionId
    if (!gw || !gw.isReady || !sessionId) {
      this.notify()
      return
    }
    const epoch = this.epoch
    const signal = this.abort.signal
    const stale = () => seq !== this.presenceSeq || gw !== this.gw || epoch !== this.epoch || !gw.isReady

    const context = this.browser
    if (!this.wantsPresence(context)) {
      const reason = this.hiddenReason(context)
      if (reason !== this.lastHidden) {
        this.lastHidden = reason
        this.log('presence_hidden', { reason })
      }
      // Hiding is never rate limited or delayed.
      if (this.shown) {
        gw.sendPresence(buildClearPresence())
        this.lastSendAt = this.d.clock.now()
      }
      this.shown = false
      this.lastSentKey = null
      this.notify()
      return
    }

    const wait = this.lastSendAt + PRESENCE_MIN_INTERVAL_MS - this.d.clock.now()
    if (wait > 0) {
      this.applyTimer = this.d.clock.setTimeout(() => {
        this.applyTimer = null
        if (gw === this.gw && epoch === this.epoch) void this.applyPresence()
      }, wait)
      return
    }

    const clientId = this.s.credentials?.clientId ?? this.s.settings.clientId
    let resolvingAssets = false
    try {
      const now = this.d.clock.now()
      const rendered = renderActivityTemplate(this.s.activity, context as BrowserContext, this.s.tracking, now)
      // Re-validates the *expanded* text (length limits, images, buttons).
      const activity = normalizeActivity(rendered)
      // The timer comes only from the activity's raw start/end templates (blank
      // = no timer). The helper throws a UserError (shown as trackingError) for
      // an invalid combination such as an end without a start.
      const timestamps = activityTimestamps(context as BrowserContext, this.s.activity)

      const urls = externalUrls(activity)
      const values = await Promise.all(urls.map((url) => this.assetCache.get(clientId, url)))
      if (stale()) return
      const resolvedAssets = new Map<string, string>()
      urls.forEach((url, index) => { if (values[index]) resolvedAssets.set(url, values[index]!) })
      const missing = urls.filter((url) => !resolvedAssets.has(url))
      if (missing.length > 0) {
        resolvingAssets = true
        this.log('assets_resolving', { provider: 'discord', count: missing.length })
        const accessToken = await this.freshAccessToken(epoch, signal)
        if (stale()) return
        const resolved = await this.d.api.resolveExternalAssets({ clientId, accessToken, urls: missing, signal })
        if (epoch !== this.epoch) return
        for (const [url, value] of resolved) {
          resolvedAssets.set(url, value)
          if (missing.includes(url)) void this.assetCache.set(clientId, url, value, () => epoch === this.epoch)
        }
        this.log('assets_resolved', { count: resolved.size, assetKind: classifyAssetKinds([...resolved.values()]) })
        resolvingAssets = false
      }
      if (stale()) return
      // Re-check: the context may have changed while assets resolved.
      if (!this.wantsPresence(this.browser)) return void this.applyPresence()

      const payload = buildPresence({
        activity,
        clientId,
        sessionId,
        resolved: resolvedAssets,
        createdAt: this.presenceCreatedAt || (this.presenceCreatedAt = now),
        ...(timestamps?.start !== undefined ? { startTimestamp: timestamps.start } : {}),
        ...(timestamps?.end !== undefined ? { endTimestamp: timestamps.end } : {}),
      })
      const key = JSON.stringify(payload)
      if (this.shown && key === this.lastSentKey) return
      if (!gw.sendPresence(payload)) {
        // Not delivered (socket closing/failed): do not pretend it is shown. The
        // gateway close handler owns reconnecting, so nothing else is committed.
        this.log('presence_failed', { errorKind: 'other' })
        this.notify()
        return
      }
      this.lastHidden = null
      this.log('presence_sent', {
        imagesCount: (activity.largeImage ? 1 : 0) + (activity.smallImage ? 1 : 0),
        buttonsCount: activity.buttons?.length ?? 0,
      })
      this.shown = true
      this.lastSentKey = key
      this.lastSendAt = this.d.clock.now()
      this.notify()
      if (this.trackingError || (this.s.status.error && this.s.status.connection === 'connected')) {
        this.trackingError = null
        await this.commitSafe({ status: { connection: 'connected', error: null } })
      }
    } catch (error) {
      if (stale() || error instanceof SupersededError) return
      this.log(resolvingAssets ? 'assets_failed' : 'presence_failed', { errorKind: classifyErrorKind(error) })
      const message = error instanceof UserError || error instanceof FatalError ? error.message : 'Could not update the activity.'
      // The expanded activity is unusable: show nothing rather than stale text.
      if (this.shown) gw.sendPresence(buildClearPresence())
      this.shown = false
      this.lastSentKey = null
      this.trackingError = message
      await this.commitSafe({ status: { connection: 'connected', error: message } })
    }
  }

  /**
   * Publish only while tracking is ON and the context is a trackable (normal,
   * non-private, http(s)) tab. With hideOnUnfocus (default) it must also be
   * focused; with it off, the tracker's retained last-eligible context
   * (`focused: false, trackable: true`) keeps showing. A focused private or
   * internal tab is `trackable: false` and always hides.
   */
  private wantsPresence(context: BrowserContext | null): boolean {
    const s = this.s
    return (
      s.tracking.enabled &&
      s.activityEnabled &&
      s.activity.name.length > 0 &&
      context !== null &&
      context.trackable &&
      (context.focused || !s.tracking.hideOnUnfocus)
    )
  }

  private hiddenReason(context: BrowserContext | null): string {
    const s = this.s
    if (!s.tracking.enabled) return 'tracking_off'
    if (!s.activityEnabled || !s.activity.name) return 'activity_off'
    if (context === null) return 'no_context'
    if (!context.trackable) return 'untrackable'
    return 'unfocused'
  }

  private clearApplyTimer(): void {
    if (this.applyTimer !== null) {
      this.d.clock.clearTimeout(this.applyTimer)
      this.applyTimer = null
    }
  }

  /**
   * Browser context only lives in memory, so nudge extension pages through a
   * tiny storage revision key (no tab data) so subscribe() re-reads the snapshot.
   */
  private touchUi(): void {
    if (!this.loaded || this.uiTimer !== null) return
    this.uiTimer = this.d.clock.setTimeout(() => {
      this.uiTimer = null
      void this.commitSafe({ rev: this.d.clock.now() })
    }, 300)
  }

  // ---- internals ----------------------------------------------------------

  /** Invalidates every in-flight operation. Synchronous. */
  private invalidate(): void {
    this.epoch += 1
    this.abort.abort()
    this.abort = new AbortController()
    const gw = this.gw
    this.gw = null
    this.connecting = false
    this.refreshing = null
    this.attempt = 0
    this.refreshFailures = 0
    this.triedRefreshAfter4004 = false
    this.presenceSeq += 1
    this.clearApplyTimer()
    this.shown = false
    this.lastSentKey = null
    this.lastSendAt = 0
    if (this.retryTimer !== null) {
      this.d.clock.clearTimeout(this.retryTimer)
      this.retryTimer = null
    }
    gw?.close()
  }

  private resetPatch(): Partial<Stored> {
    return { credentials: null, user: null, pending: null, desired: false }
  }

  private expirePending(): void {
    const pending = this.s.pending
    if (pending && this.d.clock.now() > pending.expiresAt) {
      void this.commitSafe({
        pending: null,
        status: { connection: 'disconnected', error: 'Authorization expired. Start again.' },
      })
    }
  }

  /**
   * Updates the in-memory state synchronously, then persists in order. The
   * returned promise rejects with a UserError when this write fails; the chain
   * itself stays usable so later writes can recover.
   */
  private commit(patch: Partial<Stored> & { rev?: number }): Promise<void> {
    const { rev, ...state } = patch
    Object.assign(this.s, state)
    const items: Record<string, unknown> = { ...patch }
    void rev
    const write = this.writeChain.then(() => this.d.storage.set(items))
    this.writeChain = write.then(
      () => undefined,
      () => undefined,
    )
    return write.catch(() => {
      throw new UserError('Could not save changes to extension storage. Try again.')
    })
  }

  /** Like commit() for event paths that cannot report to a caller. Never rejects. */
  private async commitSafe(patch: Partial<Stored> & { rev?: number }): Promise<boolean> {
    try {
      await this.commit(patch)
      return true
    } catch {
      return false
    }
  }

  private ensureAlarms(): void {
    void this.d.alarms.create(ALARM_RECOVER, {
      delayInMinutes: RECOVER_PERIOD_MINUTES,
      periodInMinutes: RECOVER_PERIOD_MINUTES,
    })
  }

  private scheduleRefreshAlarm(creds: Credentials): void {
    if (!creds.refreshToken) return
    const when = Math.max(this.d.clock.now() + 5_000, creds.expiresAt - TOKEN_REFRESH_MARGIN_MS)
    void this.d.alarms.create(ALARM_REFRESH, { when })
  }

  private stopAlarms(): void {
    void this.d.alarms.clear(ALARM_RECOVER)
    void this.d.alarms.clear(ALARM_REFRESH)
  }
}

export type { ConnectionState }

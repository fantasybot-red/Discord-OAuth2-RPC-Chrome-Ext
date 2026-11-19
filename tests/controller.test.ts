import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Controller } from '../src/background/controller.ts'
import { AssetCache } from '../src/background/asset-cache.ts'
import type { ControllerDeps } from '../src/background/controller.ts'
import type { StorageLike } from '../src/background/storage.ts'
import type { DiscordApi, TokenSet } from '../src/lib/discord-api.ts'
import { SupersededError, TransientError } from '../src/lib/errors.ts'
import type { Clock, SocketHandlers } from '../src/lib/gateway.ts'
import { buildAuthorizeUrl } from '../src/lib/pkce.ts'
import { ALARM_RECOVER, ALARM_REFRESH } from '../src/lib/constants.ts'
import { DEFAULT_TRACKING } from '../src/shared/types.ts'

const ID = 'e'.repeat(32)
const REDIRECT = `chrome-extension://${ID}/callback.html`
const APP = '123456789012345678'
const NOW0 = 1_000_000

class MemStorage implements StorageLike {
  data: Record<string, unknown> = {}
  failSets = false
  /** When set, set() waits for release() before applying (write boundary). */
  gate: { promise: Promise<void>; release: () => void } | null = null
  async get(keys: string[]) {
    const out: Record<string, unknown> = {}
    for (const k of keys) if (k in this.data) out[k] = structuredClone(this.data[k])
    return out
  }
  /** If set, only writes containing this key are held by the gate. */
  gateKey: string | null = null
  async set(items: Record<string, unknown>) {
    if (this.gate && (this.gateKey === null || this.gateKey in items)) await this.gate.promise
    if (this.failSets) throw new Error('quota')
    for (const [k, v] of Object.entries(items)) this.data[k] = structuredClone(v)
  }
  async remove(keys: string[]) {
    for (const k of keys) delete this.data[k]
  }
  holdWrites() {
    let release!: () => void
    const promise = new Promise<void>((r) => (release = r))
    this.gate = { promise, release }
    return () => {
      this.gate = null
      release()
    }
  }
}

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
    for (const [id, timer] of [...this.timers]) {
      if (timer.at <= this.t) {
        this.timers.delete(id)
        timer.fn()
      }
    }
  }
}

class FakeSocket {
  sent: Array<{ op: number; d: any }> = []
  closed: { code: number } | null = null
  url: string
  h: SocketHandlers
  constructor(url: string, h: SocketHandlers) {
    this.url = url
    this.h = h
  }
  send(data: string) {
    this.sent.push(JSON.parse(data))
  }
  close(code: number) {
    this.closed = { code }
  }
  server(packet: unknown) {
    this.h.onMessage(JSON.stringify(packet))
  }
  hello() {
    this.server({ op: 10, d: { heartbeat_interval: 41250 } })
  }
  ready(user = { id: '42', username: 'me', avatar: null }) {
    this.server({ op: 0, t: 'READY', s: 1, d: { session_id: 'sess1', user } })
  }
  serverClose(code: number) {
    this.h.onClose(code, 'bye')
  }
}

interface Rig {
  c: Controller
  storage: MemStorage
  clock: FakeClock
  sockets: FakeSocket[]
  tabs: string[]
  alarms: Map<string, unknown>
  api: {
    exchange: Array<any>
    refresh: Array<any>
    exchangeImpl: (input: any) => Promise<TokenSet>
    refreshImpl: (input: any) => Promise<TokenSet>
    externalImpl: (input: any) => Promise<Map<string, string>>
  }
}

const tokens = (n: number, ttl = 3600): TokenSet => ({
  accessToken: `access${n}`,
  refreshToken: `refresh${n}`,
  expiresAt: NOW0 + ttl * 1000,
  scope: 'openid sdk.social_layer_presence',
})

function makeRig(existing?: MemStorage, clock?: FakeClock, session?: MemStorage): Rig {
  const storage = existing ?? new MemStorage()
  const clk = clock ?? new FakeClock()
  const sockets: FakeSocket[] = []
  const tabs: string[] = []
  const alarms = new Map<string, unknown>()
  const apiState: Rig['api'] = {
    exchange: [],
    refresh: [],
    exchangeImpl: async () => tokens(1),
    refreshImpl: async () => tokens(2),
    externalImpl: async () => new Map(),
  }
  const api: DiscordApi = {
    exchangeCode: (input) => {
      apiState.exchange.push(input)
      return apiState.exchangeImpl(input)
    },
    refresh: (input) => {
      apiState.refresh.push(input)
      return apiState.refreshImpl(input)
    },
    getUser: async () => ({ id: '42', username: 'me', avatar: null }),
    resolveExternalAssets: (input) => apiState.externalImpl(input),
  }
  const deps: ControllerDeps = {
    storage,
    assetCache: new AssetCache(session, () => clk.now()),
    api,
    clock: clk,
    random: () => 0.5,
    socketFactory: (url, handlers) => {
      const s = new FakeSocket(url, handlers)
      sockets.push(s)
      return s
    },
    alarms: {
      create: (name, info) => void alarms.set(name, info),
      clear: (name) => void alarms.delete(name),
    },
    openTab: async (url) => void tabs.push(url),
    redirectUri: REDIRECT,
  }
  return { c: new Controller(deps), storage, clock: clk, sockets, tabs, alarms, api: apiState }
}

export const CTX = {
  focused: true,
  trackable: true,
  tabTitle: 'Tab Title',
  tabUrl: 'https://example.com/path',
  tabOrigin: 'https://example.com',
  tabHostname: 'example.com',
  tabFavicon: '',
  tabCount: 3,
  windowCount: 1,
  windowTabCount: 3,
  browserStartedAt: NOW0 - 5000,
  tabOpenedAt: NOW0 - 3000,
  tabActiveAt: NOW0 - 1000,
}

/** Opt in to tracking with a focused, trackable tab (presence needs both). */
async function enableTracking(rig: Rig, ctx: Partial<typeof CTX> = {}) {
  await rig.c.saveTrackingSettings({ ...DEFAULT_TRACKING, enabled: true })
  rig.c.updateBrowserContext({ ...CTX, ...ctx })
  await tick()
}

const tick = async (n = 20) => {
  for (let i = 0; i < n; i++) await new Promise<void>((r) => setImmediate(r))
}

function callbackFor(tabUrl: string, overrides: Record<string, string> = {}) {
  const u = new URL(tabUrl)
  return `${REDIRECT}?code=${overrides.code ?? 'authcode'}&state=${overrides.state ?? u.searchParams.get('state')}`
}

/** Full happy path: settings -> startAuth -> callback -> gateway READY. */
async function signIn(rig: Rig, secret = ''): Promise<FakeSocket> {
  await rig.c.init()
  await rig.c.saveSettings({ clientId: APP, clientSecret: secret })
  await rig.c.startAuth()
  await rig.c.completeAuth(callbackFor(rig.tabs.at(-1)!))
  await tick()
  const socket = rig.sockets.at(-1)!
  socket.hello()
  socket.ready()
  await tick()
  return socket
}

test('full flow: authorize URL, exchange with PKCE, identify with Bearer, presence', async () => {
  const rig = makeRig()
  const socket = await signIn(rig)
  const authUrl = new URL(rig.tabs[0])
  assert.equal(authUrl.searchParams.get('redirect_uri'), REDIRECT)
  assert.equal(authUrl.searchParams.get('scope'), 'openid sdk.social_layer_presence')
  assert.equal(rig.api.exchange[0].redirectUri, REDIRECT)
  assert.equal(rig.api.exchange[0].clientSecret, undefined, 'public client: no secret sent')
  assert.ok(rig.api.exchange[0].verifier.length >= 43)

  assert.equal(socket.url, 'wss://gateway.gaming-sdk.com/?v=9&encoding=json')
  const identify = socket.sent.find((p) => p.op === 2)!
  assert.equal(identify.d.token, 'Bearer access1')
  assert.equal(identify.d.capabilities, 0)
  assert.equal(identify.d.properties.browser, 'Discord Embedded')

  const snap = rig.c.snapshot()
  assert.equal(snap.connection, 'connected')
  assert.equal(snap.hasCredentials, true)
  assert.deepEqual(snap.user, { id: '42', username: 'me', avatar: null })
  assert.equal(snap.redirectUri, REDIRECT)
  assert.equal(JSON.stringify(snap).includes('access1'), false, 'no tokens in snapshot')
  assert.ok(rig.alarms.has(ALARM_RECOVER))
  assert.ok(rig.alarms.has(ALARM_REFRESH))

  await enableTracking(rig)
  await rig.c.setActivity({ name: 'Game', type: 0, details: 'd', state: 's', largeImage: 'key', largeText: '', smallImage: '', smallText: '' })
  await tick()
  rig.clock.advance(2000)
  await tick()
  const presence = socket.sent.filter((p) => p.op === 3).at(-1)!
  assert.equal(presence.d.activities[0].application_id, APP)
  assert.equal(presence.d.activities[0].session_id, 'sess1')
  assert.equal(presence.d.activities[0].assets.large_image, 'key')
  await rig.c.clearActivity()
  await tick()
  assert.deepEqual(socket.sent.filter((p) => p.op === 3).at(-1)!.d.activities, [], 'clearing is immediate, never rate limited')
})

test('state is consumed once; replay, wrong state and foreign callback are rejected', async () => {
  const rig = makeRig()
  await rig.c.init()
  await rig.c.saveSettings({ clientId: APP, clientSecret: '' })
  await rig.c.startAuth()
  const url = rig.tabs[0]
  const bad = await rig.c.handle({ ns: 'discord-rpc/v1', type: 'completeAuth', callbackUrl: callbackFor(url, { state: 'wrong' }) })
  assert.equal(bad.ok, false)
  assert.equal(rig.api.exchange.length, 0)
  const foreign = await rig.c.handle({ ns: 'discord-rpc/v1', type: 'completeAuth', callbackUrl: `chrome-extension://${'f'.repeat(32)}/callback.html?code=a&state=x` })
  assert.equal(foreign.ok, false)
  const ok = await rig.c.handle({ ns: 'discord-rpc/v1', type: 'completeAuth', callbackUrl: callbackFor(url) })
  assert.equal(ok.ok, true)
  const replay = await rig.c.handle({ ns: 'discord-rpc/v1', type: 'completeAuth', callbackUrl: callbackFor(url) })
  assert.equal(replay.ok, false)
  assert.equal(rig.api.exchange.length, 1)
  assert.equal(rig.storage.data.pending, null)
})

test('validated cancellation consumes pending once without exchanging or exposing provider text in status', async () => {
  const rig = makeRig()
  await rig.c.init()
  await rig.c.saveSettings({ clientId: APP, clientSecret: '' })
  await rig.c.startAuth()
  const state = new URL(rig.tabs[0]).searchParams.get('state')!
  const callback = `${REDIRECT}?${new URLSearchParams({ error: 'access_denied', error_description: 'private provider detail', state })}`
  await assert.rejects(rig.c.completeAuth(callback), /Discord authorization failed: access_denied \(private provider detail\)/)
  assert.equal(rig.storage.data.pending, null)
  assert.equal(rig.c.snapshot().connection, 'error')
  assert.equal(JSON.stringify(rig.c.snapshot()).includes('private provider detail'), false)
  await assert.rejects(rig.c.completeAuth(callback), /No authorization is in progress/)
  assert.equal(rig.api.exchange.length, 0)
})

test('expired cancellation is rejected; unrelated and missing states preserve pending', async () => {
  const rig = makeRig()
  await rig.c.init()
  await rig.c.saveSettings({ clientId: APP, clientSecret: '' })
  await rig.c.startAuth()
  const state = new URL(rig.tabs[0]).searchParams.get('state')!
  const pending = structuredClone(rig.storage.data.pending)
  rig.clock.advance(11 * 60 * 1000)
  await assert.rejects(rig.c.completeAuth(`${REDIRECT}?error=access_denied&state=wrong`), /does not belong/)
  await assert.rejects(rig.c.completeAuth(`${REDIRECT}?error=access_denied`), /does not belong/)
  assert.deepEqual(rig.storage.data.pending, pending)
  await assert.rejects(rig.c.completeAuth(`${REDIRECT}?error=access_denied&state=${state}`), /Authorization expired/)
  assert.equal(rig.storage.data.pending, null)
  assert.equal(rig.api.exchange.length, 0)
})

test('expired pending is rejected and startAuth can restart', async () => {
  const rig = makeRig()
  await rig.c.init()
  await rig.c.saveSettings({ clientId: APP, clientSecret: '' })
  await rig.c.startAuth()
  const first = rig.tabs[0]
  rig.clock.advance(11 * 60 * 1000)
  const res = await rig.c.handle({ ns: 'discord-rpc/v1', type: 'completeAuth', callbackUrl: callbackFor(first) })
  assert.equal(res.ok, false)
  assert.equal(rig.api.exchange.length, 0)
  const again = await rig.c.handle({ ns: 'discord-rpc/v1', type: 'startAuth' })
  assert.equal(again.ok, true)
  assert.equal(rig.tabs.length, 2)
  assert.notEqual(new URL(rig.tabs[1]).searchParams.get('state'), new URL(first).searchParams.get('state'))
  assert.equal(rig.c.snapshot().connection, 'authorizing')
})

test('optional client secret is sent to exchange and refresh when provided', async () => {
  const rig = makeRig()
  await signIn(rig, 'shh-secret')
  assert.equal(rig.api.exchange[0].clientSecret, 'shh-secret')
  rig.clock.advance(3600 * 1000)
  await rig.c.onAlarm(ALARM_REFRESH)
  assert.equal(rig.api.refresh[0].clientSecret, 'shh-secret')
})

test('persisted restart reconnects from storage without UI, tokens only in storage', async () => {
  const first = makeRig()
  await signIn(first)
  const second = makeRig(first.storage, first.clock)
  await second.c.init()
  await tick()
  assert.equal(second.sockets.length, 1, 'restarted worker reconnects')
  second.sockets[0].hello()
  second.sockets[0].ready()
  await tick()
  assert.equal(second.c.snapshot().connection, 'connected')
  assert.equal(second.sockets[0].sent.find((p) => p.op === 2)!.d.token, 'Bearer access1')
  assert.ok(second.alarms.has(ALARM_RECOVER))

  // Expired pending on disk is dropped at startup.
  const third = makeRig()
  third.storage.data.pending = { state: 's', verifier: 'v', clientId: APP, redirectUri: REDIRECT, createdAt: 0, expiresAt: 1 }
  await third.c.init()
  assert.equal(third.storage.data.pending, null)

  // Not desired: no connection.
  const idle = makeRig()
  await idle.c.init()
  assert.equal(idle.sockets.length, 0)
})

test('expired token is refreshed (and rotated) before reconnecting after restart', async () => {
  const first = makeRig()
  await signIn(first)
  first.clock.advance(3600 * 1000)
  const second = makeRig(first.storage, first.clock)
  second.api.refreshImpl = async () => ({ ...tokens(2), expiresAt: second.clock.t + 3600_000 })
  await second.c.init()
  await tick()
  assert.equal(second.api.refresh.length, 1)
  assert.equal(second.api.refresh[0].refreshToken, 'refresh1')
  second.sockets[0].hello()
  assert.equal(second.sockets[0].sent.find((p) => p.op === 2)!.d.token, 'Bearer access2')
  assert.equal((second.storage.data.credentials as any).refreshToken, 'refresh2')
})

test('disconnect during in-flight exchange is immediate and stale result never restores credentials', async () => {
  const rig = makeRig()
  await rig.c.init()
  await rig.c.saveSettings({ clientId: APP, clientSecret: '' })
  await rig.c.startAuth()
  let signal!: AbortSignal
  let resolveExchange!: (t: TokenSet) => void
  rig.api.exchangeImpl = (input) => {
    signal = input.signal
    return new Promise<TokenSet>((resolve) => (resolveExchange = resolve))
  }
  const completing = rig.c.handle({ ns: 'discord-rpc/v1', type: 'completeAuth', callbackUrl: callbackFor(rig.tabs[0]) })
  await tick()
  const snap = await rig.c.disconnect() // does not wait for the network
  assert.equal(snap.connection, 'disconnected')
  assert.equal(signal.aborted, true, 'in-flight request aborted')
  resolveExchange(tokens(1)) // late success
  const result = await completing
  assert.equal(result.ok, false)
  await tick()
  assert.equal(rig.storage.data.credentials, null)
  assert.equal(rig.storage.data.desired, false)
  assert.equal(rig.sockets.length, 0)
  assert.equal(rig.alarms.size, 0)
})

test('disconnect racing the credential write cancels alarms/connect (write boundary)', async () => {
  const rig = makeRig()
  await rig.c.init()
  await rig.c.saveSettings({ clientId: APP, clientSecret: '' })
  await rig.c.startAuth()
  rig.storage.gateKey = 'credentials' // hold only the credentials write
  const release = rig.storage.holdWrites()
  const completing = rig.c.handle({ ns: 'discord-rpc/v1', type: 'completeAuth', callbackUrl: callbackFor(rig.tabs[0]) })
  await tick(10) // exchange + profile done; blocked inside the credentials commit
  assert.equal(rig.api.exchange.length, 1)
  const disconnecting = rig.c.disconnect()
  release()
  rig.storage.gateKey = null
  await disconnecting
  const result = await completing
  await tick()
  assert.equal(result.ok, false)
  assert.equal(rig.sockets.length, 0, 'no reconnect after disconnect')
  assert.equal(rig.alarms.size, 0, 'no alarms resurrected')
  assert.equal(rig.storage.data.credentials, null)
  assert.equal(rig.storage.data.desired, false)
  assert.equal(rig.c.snapshot().hasCredentials, false)
})

test('startAuth cancelled during its write does not open a tab', async () => {
  const rig = makeRig()
  await rig.c.init()
  await rig.c.saveSettings({ clientId: APP, clientSecret: '' })
  const release = rig.storage.holdWrites()
  const starting = rig.c.handle({ ns: 'discord-rpc/v1', type: 'startAuth' })
  await tick(5)
  const disconnecting = rig.c.disconnect()
  release()
  await disconnecting
  const res = await starting
  assert.equal(res.ok, false)
  assert.equal(rig.tabs.length, 0)
  assert.equal(rig.storage.data.pending, null)
})

test('disconnect during a refresh in flight discards the refreshed token', async () => {
  const rig = makeRig()
  await signIn(rig)
  rig.clock.advance(3600 * 1000)
  let resolveRefresh!: (t: TokenSet) => void
  let signal!: AbortSignal
  rig.api.refreshImpl = (input) => {
    signal = input.signal
    return new Promise<TokenSet>((r) => (resolveRefresh = r))
  }
  const alarm = rig.c.onAlarm(ALARM_REFRESH)
  await tick()
  await rig.c.disconnect()
  assert.equal(signal.aborted, true)
  resolveRefresh(tokens(9))
  await alarm
  await tick()
  assert.equal(rig.storage.data.credentials, null)
  assert.equal(rig.alarms.size, 0)
  assert.equal(rig.sockets.at(-1)!.closed?.code, 1000)
})

test('transient scheduled refresh while connected re-arms and later succeeds', async () => {
  const rig = makeRig()
  await signIn(rig)
  rig.clock.advance(3600 * 1000 - 60_000) // inside the refresh margin
  let attempts = 0
  rig.api.refreshImpl = async () => {
    attempts += 1
    if (attempts === 1) throw new TransientError('down')
    return { ...tokens(2), expiresAt: rig.clock.t + 3600_000 }
  }
  rig.alarms.delete(ALARM_REFRESH)
  await rig.c.onAlarm(ALARM_REFRESH)
  assert.equal(attempts, 1)
  assert.equal(rig.c.snapshot().connection, 'connected', 'session stays up on transient failure')
  const rearmed = rig.alarms.get(ALARM_REFRESH) as { when: number }
  assert.ok(rearmed && rearmed.when - rig.clock.t <= 60_000 && rearmed.when > rig.clock.t, 'refresh alarm re-armed with bounded delay')

  // Recovery alarm also retries while the gateway is connected.
  await rig.c.onAlarm(ALARM_RECOVER)
  assert.equal(attempts, 2)
  assert.equal((rig.storage.data.credentials as any).accessToken, 'access2')
  assert.equal((rig.storage.data.credentials as any).refreshToken, 'refresh2')
  assert.equal(rig.sockets.length, 1, 'no extra socket opened')
  assert.equal(rig.c.snapshot().connection, 'connected')
})

test('fatal refresh failure clears credentials and stops with a helpful error', async () => {
  const rig = makeRig()
  await signIn(rig)
  rig.clock.advance(3600 * 1000)
  const { FatalError } = await import('../src/lib/errors.ts')
  rig.api.refreshImpl = async () => {
    throw new FatalError('Your Discord session expired. Authorize again.', true)
  }
  await rig.c.onAlarm(ALARM_REFRESH)
  const snap = rig.c.snapshot()
  assert.equal(snap.connection, 'error')
  assert.match(snap.error!, /Authorize again/)
  assert.equal(snap.hasCredentials, false)
  assert.equal(rig.storage.data.desired, false)
  assert.equal(rig.alarms.size, 0)
})

test('gateway close: 4004 retries once via refresh then stops; fatal codes stop; others back off', async () => {
  const rig = makeRig()
  const socket = await signIn(rig)
  socket.serverClose(4004)
  await tick()
  assert.equal(rig.api.refresh.length, 0, 'forced delay 0 timer not yet fired')
  rig.clock.advance(1)
  await tick()
  assert.equal(rig.api.refresh.length, 1, 'rotated once')
  const s2 = rig.sockets.at(-1)!
  assert.equal(rig.sockets.length, 2)
  s2.hello()
  s2.serverClose(4004)
  await tick()
  rig.clock.advance(1)
  await tick()
  assert.equal(rig.c.snapshot().connection, 'error')
  assert.match(rig.c.snapshot().error!, /Authorize again/)
  assert.equal(rig.c.snapshot().hasCredentials, false)

  const rig2 = makeRig()
  const s = await signIn(rig2)
  s.serverClose(4014)
  await tick()
  assert.equal(rig2.c.snapshot().connection, 'error')
  assert.match(rig2.c.snapshot().error!, /Social SDK/)
  assert.equal(rig2.storage.data.desired, false)
  assert.equal(rig2.c.snapshot().hasCredentials, true, 'config error keeps tokens')

  const rig3 = makeRig()
  const s3 = await signIn(rig3)
  s3.serverClose(1006)
  await tick()
  assert.equal(rig3.c.snapshot().connection, 'connecting')
  assert.equal(rig3.sockets.length, 1)
  rig3.clock.advance(2000)
  await tick()
  assert.equal(rig3.sockets.length, 2, 'bounded backoff reconnects with fresh identify')
  rig3.sockets[1].hello()
  assert.equal(rig3.sockets[1].sent.some((p) => p.op === 2), true)
  assert.equal(rig3.sockets[1].sent.some((p) => p.op === 6), false, 'never RESUME')
})

test('storage write failures are reported, chain stays usable, disconnect cannot fake success', async () => {
  const rig = makeRig()
  await rig.c.init()
  rig.storage.failSets = true
  const failed = await rig.c.handle({ ns: 'discord-rpc/v1', type: 'saveSettings', settings: { clientId: APP, clientSecret: '' } })
  assert.equal(failed.ok, false)
  assert.match((failed as { error: string }).error, /save/i)
  rig.storage.failSets = false
  const recovered = await rig.c.handle({ ns: 'discord-rpc/v1', type: 'saveSettings', settings: { clientId: APP, clientSecret: '' } })
  // In-memory value matched, so this is a no-op success or a real save; either way the chain works.
  assert.equal(recovered.ok, true)
  await rig.c.startAuth()
  await rig.c.completeAuth(callbackFor(rig.tabs[0]))
  await tick()
  rig.storage.failSets = true
  const disconnect = await rig.c.handle({ ns: 'discord-rpc/v1', type: 'disconnect' })
  assert.equal(disconnect.ok, false, 'disconnect reports that local tokens may not be cleared')
  assert.equal(rig.c.snapshot().hasCredentials, false, 'in-memory state is already cleared and connection closed')
  rig.storage.failSets = false
  const retry = await rig.c.handle({ ns: 'discord-rpc/v1', type: 'disconnect' })
  assert.equal(retry.ok, true)
  assert.equal(rig.storage.data.credentials, null)
})

test('settings change clears pending auth and credentials; no secrets/tokens in errors', async () => {
  const rig = makeRig()
  await rig.c.init()
  await rig.c.saveSettings({ clientId: APP, clientSecret: 'topsecret' })
  await rig.c.startAuth()
  const stateUrl = rig.tabs[0]
  await rig.c.saveSettings({ clientId: '223456789012345678', clientSecret: 'topsecret' })
  assert.equal(rig.storage.data.pending, null)
  const res = await rig.c.handle({ ns: 'discord-rpc/v1', type: 'completeAuth', callbackUrl: callbackFor(stateUrl) })
  assert.equal(res.ok, false)
  assert.equal(JSON.stringify(res).includes('topsecret'), false)
  const invalid = await rig.c.handle({ ns: 'discord-rpc/v1', type: 'saveSettings', settings: { clientId: 'abc', clientSecret: '' } })
  assert.equal(invalid.ok, false)
  const unknown = await rig.c.handle({ type: 'nope' })
  assert.equal(unknown.ok, false)
})

test('external image URLs resolve via API with the bearer token and are cached', async () => {
  const rig = makeRig()
  const socket = await signIn(rig)
  let calls = 0
  rig.api.externalImpl = async (input) => {
    calls += 1
    assert.equal(input.accessToken, 'access1')
    assert.deepEqual(input.urls, ['https://assets.ppy.sh/a.jpg'])
    return new Map([['https://assets.ppy.sh/a.jpg', 'mp:external/h/a.jpg']])
  }
  const activity = { name: 'G', type: 0 as const, details: '', state: '', largeImage: 'https://assets.ppy.sh/a.jpg', largeText: '', smallImage: '', smallText: '' }
  await enableTracking(rig)
  await rig.c.setActivity(activity)
  await tick()
  rig.clock.advance(2000)
  await tick()
  await rig.c.setActivity({ ...activity, state: 'again' })
  await tick()
  rig.clock.advance(2000)
  await tick()
  assert.equal(calls, 1)
  assert.equal(socket.sent.filter((p) => p.op === 3).at(-1)!.d.activities[0].assets.large_image, 'mp:external/h/a.jpg')
})

test('resolved image survives disconnect and worker restart within session', async () => {
  const session = new MemStorage()
  const rig = makeRig(undefined, undefined, session)
  await signIn(rig)
  let calls = 0
  rig.api.externalImpl = async ({ urls }) => { calls++; return new Map(urls.map((url: string) => [url, 'mp:external/h/a.jpg'])) }
  const activity = { name: 'G', type: 0 as const, details: '', state: '', largeImage: 'https://assets.ppy.sh/a.jpg', largeText: '', smallImage: '', smallText: '' }
  await enableTracking(rig)
  await rig.c.setActivity(activity)
  await tick()
  rig.clock.advance(2000)
  await tick()
  assert.equal(calls, 1)
  await rig.c.disconnect()
  await rig.c.startAuth()
  await rig.c.completeAuth(callbackFor(rig.tabs.at(-1)!))
  await tick()
  rig.sockets.at(-1)!.hello()
  rig.sockets.at(-1)!.ready()
  await tick()
  assert.equal(calls, 1)
  const restarted = makeRig(rig.storage, rig.clock, session)
  restarted.api.externalImpl = async () => { calls++; return new Map() }
  await restarted.c.init()
  await tick()
  restarted.sockets[0].hello()
  restarted.sockets[0].ready()
  restarted.c.updateBrowserContext(CTX)
  await tick()
  assert.equal(calls, 1)
  assert.equal(restarted.sockets[0].sent.filter((p) => p.op === 3).at(-1)!.d.activities[0].assets.large_image, 'mp:external/h/a.jpg')
})

test('authorize URL builder is the one used for the tab', async () => {
  const rig = makeRig()
  await rig.c.init()
  await rig.c.saveSettings({ clientId: APP, clientSecret: '' })
  await rig.c.startAuth()
  const u = new URL(rig.tabs[0])
  const rebuilt = new URL(buildAuthorizeUrl({ clientId: APP, redirectUri: REDIRECT, state: u.searchParams.get('state')!, codeChallenge: u.searchParams.get('code_challenge')! }))
  assert.equal(rebuilt.href, u.href)
  assert.ok(!(new SupersededError() instanceof TransientError))
})

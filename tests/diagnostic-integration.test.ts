import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Controller } from '../src/background/controller.ts'
import type { StorageLike } from '../src/background/storage.ts'
import type { DiscordApi, TokenSet } from '../src/lib/discord-api.ts'
import { DiagnosticLogger } from '../src/lib/diagnostics.ts'
import type { DiagnosticAreaLike } from '../src/lib/diagnostics.ts'
import { TransientError } from '../src/lib/errors.ts'
import type { Clock, SocketHandlers } from '../src/lib/gateway.ts'
import { DEFAULT_TRACKING } from '../src/shared/types.ts'

const ID = 'e'.repeat(32)
const REDIRECT = `chrome-extension://${ID}/callback.html`
const APP = '123456789012345678'
const NOW0 = 1_000_000
const CANARY = 'SECRET-CANARY'

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

class MemArea implements DiagnosticAreaLike {
  data: Record<string, unknown> = {}
  async get(keys: string[]) {
    const out: Record<string, unknown> = {}
    for (const k of keys) if (k in this.data) out[k] = structuredClone(this.data[k])
    return out
  }
  async set(items: Record<string, unknown>) {
    for (const [k, v] of Object.entries(items)) this.data[k] = structuredClone(v)
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
  failSend = false
  h: SocketHandlers
  constructor(_url: string, h: SocketHandlers) {
    this.h = h
  }
  send(data: string) {
    if (this.failSend) throw new Error(`send failed ${CANARY}`)
    this.sent.push(JSON.parse(data))
  }
  close() {}
  server(packet: unknown) {
    this.h.onMessage(JSON.stringify(packet))
  }
  ready() {
    this.server({ op: 10, d: { heartbeat_interval: 41250 } })
    this.server({ op: 0, t: 'READY', s: 1, d: { session_id: 'sess1', user: { id: '42', username: 'me', avatar: null } } })
  }
}

const tick = async (n = 20) => {
  for (let i = 0; i < n; i++) await new Promise<void>((r) => setImmediate(r))
}

const tokens: TokenSet = {
  accessToken: `access-${CANARY}`,
  refreshToken: `refresh-${CANARY}`,
  expiresAt: NOW0 + 3_600_000,
  scope: 'openid sdk.social_layer_presence',
}

const CTX = {
  focused: true,
  trackable: true,
  tabTitle: `Title ${CANARY}`,
  tabUrl: `https://example.com/${CANARY}`,
  tabOrigin: 'https://example.com',
  tabHostname: 'example.com',
  tabFavicon: '',
  tabCount: 3,
  windowCount: 2,
  windowTabCount: 3,
  browserStartedAt: NOW0 - 5000,
  tabOpenedAt: NOW0 - 3000,
  tabActiveAt: NOW0 - 1000,
}

async function rig() {
  const storage = new MemStorage()
  const clock = new FakeClock()
  const sockets: FakeSocket[] = []
  const tabs: string[] = []
  const session = new MemArea()
  const logger = new DiagnosticLogger({ local: new MemArea(), session, now: () => clock.t })
  await logger.setEnabled(true)
  const state = { external: async (): Promise<Map<string, string>> => new Map() }
  const api: DiscordApi = {
    exchangeCode: async () => tokens,
    refresh: async () => tokens,
    getUser: async () => ({ id: '42', username: 'me', avatar: null }),
    resolveExternalAssets: () => state.external(),
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
    alarms: { create: () => {}, clear: () => {} },
    openTab: async (url) => void tabs.push(url),
    redirectUri: REDIRECT,
    diagnostic: (event, details) => logger.record(event, details),
  })
  return { c, logger, clock, sockets, tabs, state }
}

async function signIn(r: Awaited<ReturnType<typeof rig>>) {
  await r.c.init()
  await r.c.saveSettings({ clientId: APP, clientSecret: '' })
  await r.c.startAuth()
  const state = new URL(r.tabs[0]!).searchParams.get('state')
  await r.c.completeAuth(`${REDIRECT}?code=${CANARY}&state=${state}`)
  await tick()
  const socket = r.sockets.at(-1)!
  socket.ready()
  await tick()
  return socket
}

const ACTIVITY = {
  name: 'Game',
  type: 0 as const,
  details: '{title}',
  state: '{url}',
  largeImage: 'key',
  largeText: '',
  smallImage: '',
  smallText: '',
}

test('lifecycle, context, hidden and presence events are logged with safe values only', async () => {
  const r = await rig()
  const socket = await signIn(r)
  await r.c.setActivity(ACTIVITY)
  await r.c.saveTrackingSettings({ ...DEFAULT_TRACKING, enabled: true, allowUrlSharing: true })
  r.c.updateBrowserContext({ ...CTX })
  await tick()
  r.clock.advance(2000)
  await tick()
  assert.equal(socket.sent.filter((p) => p.op === 3).length >= 1, true)

  // Identical context: deduped. Unfocused: hidden (reason unfocused) once.
  r.c.updateBrowserContext({ ...CTX })
  r.c.updateBrowserContext({ ...CTX, focused: false })
  r.c.updateBrowserContext({ ...CTX, focused: false, tabTitle: 'other' })
  await tick()

  const d = await r.logger.get()
  const events = d.entries.map((e) => e.event)
  for (const expected of [
    'init',
    'auth_started',
    'auth_completed',
    'gateway_connecting',
    'gateway_ready',
    'tracking_toggled',
    'context_updated',
    'presence_sent',
    'presence_hidden',
  ]) {
    assert.ok(events.includes(expected), `missing ${expected}`)
  }
  const ctxEntries = d.entries.filter((e) => e.event === 'context_updated')
  assert.equal(ctxEntries.length, 2, 'unchanged contexts are deduped')
  assert.deepEqual(ctxEntries[0]!.details, { focused: true, trackable: true, tabCount: 3, windowCount: 2 })
  // Hidden reasons are deduped: consecutive identical reasons log once.
  const hidden = d.entries.filter((e) => e.event === 'presence_hidden')
  const reasons = hidden.map((e) => e.details?.reason)
  assert.equal(reasons.at(-1), 'unfocused')
  assert.equal(reasons.filter((x) => x === 'unfocused').length, 1)
  assert.equal(reasons.every((x, i) => i === 0 || x !== reasons[i - 1]), true)
  const sent = d.entries.find((e) => e.event === 'presence_sent')!
  assert.deepEqual(sent.details, { imagesCount: 1, buttonsCount: 0 })

  const dump = JSON.stringify(d)
  for (const secret of [CANARY, 'example.com', 'Title', 'access', 'refresh', APP, 'sess1']) {
    assert.equal(dump.includes(secret), false, `leaked ${secret}`)
  }
})

test('presence_sent is not logged and shown stays false when the send fails', async () => {
  const r = await rig()
  const socket = await signIn(r)
  await r.c.setActivity(ACTIVITY)
  await r.c.saveTrackingSettings({ ...DEFAULT_TRACKING, enabled: true })
  socket.failSend = true
  r.c.updateBrowserContext({ ...CTX })
  await tick()
  r.clock.advance(2000)
  await tick()

  const d = await r.logger.get()
  assert.equal(d.entries.some((e) => e.event === 'presence_sent'), false)
  const failed = d.entries.find((e) => e.event === 'presence_failed')
  assert.deepEqual(failed?.details, { errorKind: 'other' })
  assert.equal(r.c.presenceShown, false)
  assert.equal(JSON.stringify(d).includes(CANARY), false)
})

test('external assets: resolving/resolved logged with counts and kind, never URLs', async () => {
  const r = await rig()
  const socket = await signIn(r)
  const url = `https://img.example.com/${CANARY}.png`
  r.state.external = async () => new Map([[new URL(url).toString(), `mp:external/hash/https/img.example.com/${CANARY}.png`]])
  await r.c.setActivity({ ...ACTIVITY, largeImage: url })
  await r.c.saveTrackingSettings({ ...DEFAULT_TRACKING, enabled: true })
  r.c.updateBrowserContext({ ...CTX })
  await tick()
  r.clock.advance(2000)
  await tick()
  assert.equal(socket.sent.filter((p) => p.op === 3).length >= 1, true)

  const d = await r.logger.get()
  assert.deepEqual(d.entries.find((e) => e.event === 'assets_resolving')?.details, { provider: 'discord', count: 1 })
  assert.deepEqual(d.entries.find((e) => e.event === 'assets_resolved')?.details, { count: 1, assetKind: 'external' })
  assert.equal(JSON.stringify(d).includes(CANARY), false)
})

test('asset failure logs a fixed error kind and no raw error text', async () => {
  const r = await rig()
  await signIn(r)
  r.state.external = async () => {
    throw new TransientError(`boom ${CANARY}`)
  }
  await r.c.setActivity({ ...ACTIVITY, largeImage: `https://img.example.com/${CANARY}.png` })
  await r.c.saveTrackingSettings({ ...DEFAULT_TRACKING, enabled: true })
  r.c.updateBrowserContext({ ...CTX })
  await tick()
  r.clock.advance(2000)
  await tick()

  const d = await r.logger.get()
  assert.deepEqual(d.entries.find((e) => e.event === 'assets_failed')?.details, { errorKind: 'transient' })
  assert.equal(JSON.stringify(d).includes(CANARY), false)
})

test('a throwing diagnostic hook never breaks the controller', async () => {
  const r = await rig()
  void r
  const storage = new MemStorage()
  const c = new Controller({
    storage,
    api: { exchangeCode: async () => tokens, refresh: async () => tokens, getUser: async () => null, resolveExternalAssets: async () => new Map() },
    clock: new FakeClock(),
    random: () => 0.5,
    socketFactory: (url, h) => new FakeSocket(url, h),
    alarms: { create: () => {}, clear: () => {} },
    openTab: async () => {},
    redirectUri: REDIRECT,
    diagnostic: () => {
      throw new Error('hook')
    },
  })
  await c.init()
  const snap = await c.saveSettings({ clientId: APP, clientSecret: '' })
  assert.equal(snap.settings.clientId, APP)
})

/**
 * Discord Social SDK gateway connection over the browser WebSocket.
 *
 * Transport is injected (`SocketFactory`) so the protocol logic can be tested
 * without a network. One instance == one socket == one session; reconnects are
 * orchestrated by the caller and always IDENTIFY fresh (no RESUME).
 *
 * Service worker keepalive: Chrome 116+ treats WebSocket traffic as activity, so
 * heartbeats are sent at most every MAX_HEARTBEAT_INTERVAL_MS (20s), even when
 * the server asks for a longer interval. Only valid protocol frames are sent.
 */
import {
  ACK_TIMEOUT_MS,
  FATAL_CLOSE_CODES,
  GatewayOp,
  HELLO_TIMEOUT_MS,
  IDENTIFY_INTENTS,
  MAX_HEARTBEAT_INTERVAL_MS,
  READY_TIMEOUT_MS,
  SUPER_PROPERTIES,
} from './constants.ts'

export interface SocketHandlers {
  onOpen(): void
  onMessage(data: unknown): void
  onClose(code: number, reason: string): void
  onError(): void
}

export interface SocketLike {
  send(data: string): void
  close(code: number, reason: string): void
}

export type SocketFactory = (url: string, handlers: SocketHandlers) => SocketLike

export interface Clock {
  now(): number
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

export interface ReadyInfo {
  sessionId: string
  user: { id: string; username: string; avatar: string | null } | null
}

export interface CloseInfo {
  code: number
  reason: string
  /** Retrying with the same token/identify cannot succeed. */
  fatal: boolean
  /** The gateway rejected the token (4004). */
  authFailed: boolean
  reachedReady: boolean
  /** Milliseconds the session was READY (0 if never). */
  readyMs: number
  /** We closed it (timeout, disconnect, op7/op9), not the server. */
  local: boolean
}

export interface GatewayOptions {
  url: string
  /** Complete token string including the `Bearer ` prefix. */
  token: string
  factory: SocketFactory
  clock: Clock
  random?: () => number
  helloTimeoutMs?: number
  readyTimeoutMs?: number
  ackTimeoutMs?: number
  maxHeartbeatMs?: number
  onReady(info: ReadyInfo): void
  onClose(info: CloseInfo): void
}

function parseUser(value: unknown): ReadyInfo['user'] {
  if (typeof value !== 'object' || value === null) return null
  const u = value as Record<string, unknown>
  if (typeof u.id !== 'string' || typeof u.username !== 'string') return null
  return { id: u.id, username: u.username, avatar: typeof u.avatar === 'string' ? u.avatar : null }
}

export class GatewayConnection {
  private readonly o: GatewayOptions
  private socket: SocketLike | null = null
  private opened = false
  private finished = false
  private seq: number | null = null
  private ready = false
  private readyAt = 0
  private reachedReady = false
  private awaitingAck = false
  private sessionIdValue: string | null = null
  private helloTimer: unknown = null
  private readyTimer: unknown = null
  private beatTimer: unknown = null
  private ackTimer: unknown = null

  constructor(options: GatewayOptions) {
    this.o = options
  }

  get isReady(): boolean {
    return this.ready && !this.finished
  }

  get sessionId(): string | null {
    return this.sessionIdValue
  }

  start(): void {
    if (this.socket || this.finished) return
    this.helloTimer = this.o.clock.setTimeout(
      () => this.fail(4000, 'HELLO timeout'),
      this.o.helloTimeoutMs ?? HELLO_TIMEOUT_MS,
    )
    try {
      this.socket = this.o.factory(this.o.url, {
        onOpen: () => {
          this.opened = true
        },
        onMessage: (data) => this.handleMessage(data),
        onClose: (code, reason) => this.finish(code, reason, false),
        onError: () => {
          /* a close event always follows; it carries the code */
        },
      })
    } catch {
      this.finish(1006, 'socket creation failed', true)
    }
  }

  /** Sends op 3. Returns false if the session is not READY. */
  sendPresence(d: unknown): boolean {
    if (!this.isReady) return false
    return this.send(GatewayOp.PRESENCE_UPDATE, d)
  }

  /** Clean local close (disconnect / invalidation). */
  close(): void {
    this.finish(1000, 'closed', true)
  }

  wasOpened(): boolean {
    return this.opened
  }

  // --- internals ---------------------------------------------------------

  private send(op: number, d: unknown): boolean {
    if (!this.socket || this.finished) return false
    try {
      this.socket.send(JSON.stringify({ op, d }))
      return true
    } catch {
      this.fail(4000, 'send failed')
      return false
    }
  }

  private handleMessage(data: unknown): void {
    if (this.finished || typeof data !== 'string') return
    let packet: { op?: unknown; d?: unknown; s?: unknown; t?: unknown }
    try {
      packet = JSON.parse(data) as typeof packet
    } catch {
      return
    }
    if (typeof packet !== 'object' || packet === null) return
    if (typeof packet.s === 'number' && (this.seq === null || packet.s > this.seq)) this.seq = packet.s

    switch (packet.op) {
      case GatewayOp.HELLO:
        this.onHello(packet.d)
        break
      case GatewayOp.HEARTBEAT_ACK:
        this.awaitingAck = false
        this.clearTimer('ackTimer')
        break
      case GatewayOp.HEARTBEAT:
        this.beat(true)
        break
      case GatewayOp.RECONNECT:
        this.fail(4000, 'server requested reconnect')
        break
      case GatewayOp.INVALID_SESSION:
        this.fail(4000, 'invalid session')
        break
      case GatewayOp.DISPATCH:
        if (packet.t === 'READY') this.onReadyDispatch(packet.d)
        break
      default:
        break
    }
  }

  private onHello(d: unknown): void {
    this.clearTimer('helloTimer')
    const raw = typeof d === 'object' && d !== null ? (d as Record<string, unknown>).heartbeat_interval : undefined
    const serverInterval = typeof raw === 'number' && raw > 0 ? raw : MAX_HEARTBEAT_INTERVAL_MS
    const interval = Math.max(1000, Math.min(serverInterval, this.o.maxHeartbeatMs ?? MAX_HEARTBEAT_INTERVAL_MS))
    const random = this.o.random ?? Math.random

    this.send(GatewayOp.IDENTIFY, {
      capabilities: 0,
      intents: IDENTIFY_INTENTS,
      token: this.o.token,
      properties: SUPER_PROPERTIES,
    })
    this.readyTimer = this.o.clock.setTimeout(
      () => this.fail(4000, 'READY timeout'),
      this.o.readyTimeoutMs ?? READY_TIMEOUT_MS,
    )
    this.scheduleBeat(Math.floor(interval * random()), interval)
  }

  private scheduleBeat(delay: number, interval: number): void {
    this.beatTimer = this.o.clock.setTimeout(() => {
      this.beatTimer = null
      if (this.finished) return
      this.beat(false)
      if (!this.finished) this.scheduleBeat(interval, interval)
    }, delay)
  }

  private beat(forced: boolean): void {
    if (!forced && this.awaitingAck) {
      this.fail(4009, 'heartbeat ack missed')
      return
    }
    if (!this.send(GatewayOp.HEARTBEAT, this.seq)) return
    if (!forced) {
      this.awaitingAck = true
      this.clearTimer('ackTimer')
      this.ackTimer = this.o.clock.setTimeout(
        () => this.fail(4009, 'heartbeat ack timeout'),
        this.o.ackTimeoutMs ?? ACK_TIMEOUT_MS,
      )
    }
  }

  private onReadyDispatch(d: unknown): void {
    if (this.ready) return
    const record = typeof d === 'object' && d !== null ? (d as Record<string, unknown>) : {}
    if (typeof record.session_id !== 'string' || !record.session_id) {
      this.fail(4000, 'malformed READY')
      return
    }
    this.clearTimer('readyTimer')
    this.ready = true
    this.reachedReady = true
    this.readyAt = this.o.clock.now()
    this.sessionIdValue = record.session_id
    this.o.onReady({ sessionId: record.session_id, user: parseUser(record.user) })
  }

  private clearTimer(name: 'helloTimer' | 'readyTimer' | 'beatTimer' | 'ackTimer'): void {
    const handle = this[name]
    if (handle !== null) this.o.clock.clearTimeout(handle)
    this[name] = null
  }

  private fail(code: number, reason: string): void {
    this.finish(code, reason, true)
  }

  private finish(code: number, reason: string, local: boolean): void {
    if (this.finished) return
    this.finished = true
    const wasReady = this.ready
    this.ready = false
    this.clearTimer('helloTimer')
    this.clearTimer('readyTimer')
    this.clearTimer('beatTimer')
    this.clearTimer('ackTimer')
    if (local && this.socket) {
      try {
        this.socket.close(code === 1000 ? 1000 : code >= 4000 && code <= 4999 ? code : 4000, reason.slice(0, 100))
      } catch {
        /* already closed */
      }
    }
    this.o.onClose({
      code,
      reason: reason.slice(0, 100),
      fatal: !local && FATAL_CLOSE_CODES.has(code),
      authFailed: !local && code === 4004,
      reachedReady: this.reachedReady,
      readyMs: wasReady ? this.o.clock.now() - this.readyAt : 0,
      local,
    })
  }
}

/** Reconnect delay: exponential, jittered, bounded. */
export function backoffDelay(attempt: number, random: () => number, baseMs: number, maxMs: number): number {
  const exp = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1))
  return Math.round(exp * (0.8 + 0.4 * random()))
}

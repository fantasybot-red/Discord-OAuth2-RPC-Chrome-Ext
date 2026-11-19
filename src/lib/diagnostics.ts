/**
 * Bounded, opt-in debug log. Events come from a fixed allowlist with fixed
 * messages; details are restricted to whitelisted primitive keys with safe
 * values. Arbitrary strings (errors, URLs, titles, tokens, IDs) can never be
 * recorded because the only string values allowed are enum members.
 */
import type { Diagnostics, DiagnosticDetails, DiagnosticEntry, DiagnosticLevel } from '../shared/types.ts'
import { FatalError, SupersededError, TransientError, UserError } from './errors.ts'

export const DIAGNOSTICS_KEY = 'rpcDiagnostics'
export const DEBUG_ENABLED_KEY = 'rpcDebugEnabled'
export const MAX_DIAGNOSTIC_ENTRIES = 100

export type DiagnosticRecorder = (event: string, details?: Record<string, unknown>) => void

export interface DiagnosticAreaLike {
  get(keys: string[]): Promise<Record<string, unknown>>
  set(items: Record<string, unknown>): Promise<void>
}

export interface DiagnosticLoggerDeps {
  local: DiagnosticAreaLike
  session: DiagnosticAreaLike
  now?: () => number
}

type Validator = (value: unknown) => string | number | boolean | undefined

const bool: Validator = (v) => (typeof v === 'boolean' ? v : undefined)
const count: Validator = (v) =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(1_000_000_000, Math.max(0, Math.trunc(v))) : undefined
const oneOf =
  (...allowed: string[]): Validator =>
  (v) =>
    typeof v === 'string' && allowed.includes(v) ? v : undefined

const ERROR_KIND = oneOf('user', 'fatal', 'transient', 'superseded', 'other')
const ASSET_KIND = oneOf('external', 'proxied', 'mixed', 'unknown', 'none')

interface EventSpec {
  level: DiagnosticLevel
  message: string
  details?: Record<string, Validator>
}

const CATALOG: Record<string, EventSpec> = {
  debug_enabled: { level: 'info', message: 'Debug logging enabled.' },
  init: { level: 'info', message: 'Background worker started.', details: { enabled: bool } },
  auth_started: { level: 'info', message: 'Authorization started.' },
  auth_completed: { level: 'info', message: 'Authorization completed.' },
  auth_failed: {
    level: 'error',
    message: 'Authorization failed.',
    details: { reason: oneOf('denied', 'expired', 'mismatch', 'none', 'exchange', 'cancelled', 'tab') },
  },
  gateway_connecting: { level: 'info', message: 'Connecting to Discord.' },
  gateway_ready: { level: 'info', message: 'Discord connection ready.' },
  gateway_closed: {
    level: 'warn',
    message: 'Discord connection closed.',
    details: { code: count, fatal: bool, authFailed: bool },
  },
  retry_scheduled: {
    level: 'warn',
    message: 'Reconnect scheduled.',
    details: { attempt: count, delayMs: count },
  },
  refresh_started: { level: 'info', message: 'Token refresh started.' },
  refresh_succeeded: { level: 'info', message: 'Token refresh succeeded.' },
  refresh_failed: { level: 'error', message: 'Token refresh failed.', details: { errorKind: ERROR_KIND } },
  tracking_toggled: { level: 'info', message: 'Tracking changed.', details: { enabled: bool } },
  browser_event: {
    level: 'info',
    message: 'Browser event received.',
    details: {
      eventKind: oneOf(
        'focus',
        'tab_created',
        'activation',
        'url',
        'title',
        'status',
        'favicon',
        'tab_removed',
        'tab_replaced',
        'window_removed',
        'startup',
      ),
      source: oneOf('chrome'),
      phase: oneOf('received'),
      hasTab: bool,
      hasWindow: bool,
      focused: bool,
    },
  },
  context_updated: {
    level: 'info',
    message: 'Browser context changed.',
    details: { focused: bool, trackable: bool, tabCount: count, windowCount: count },
  },
  presence_sent: {
    level: 'info',
    message: 'Presence sent.',
    details: { imagesCount: count, buttonsCount: count },
  },
  presence_hidden: {
    level: 'info',
    message: 'Presence hidden.',
    details: { reason: oneOf('tracking_off', 'activity_off', 'no_context', 'untrackable', 'unfocused') },
  },
  presence_failed: { level: 'error', message: 'Presence update failed.', details: { errorKind: ERROR_KIND } },
  assets_resolving: {
    level: 'info',
    message: 'Resolving external images.',
    details: { provider: oneOf('discord'), count },
  },
  assets_resolved: {
    level: 'info',
    message: 'External images resolved.',
    details: { count, assetKind: ASSET_KIND },
  },
  assets_failed: {
    level: 'error',
    message: 'Resolving external images failed.',
    details: { errorKind: ERROR_KIND, status: count },
  },
}

export function isDiagnosticEvent(event: unknown): event is string {
  return typeof event === 'string' && Object.prototype.hasOwnProperty.call(CATALOG, event)
}

/** Whitelists details for a known event; unknown keys and unsafe values are dropped. */
export function sanitizeDetails(event: string, details: unknown): DiagnosticDetails | undefined {
  if (!isDiagnosticEvent(event)) return undefined
  const spec = CATALOG[event]!.details
  if (!spec || typeof details !== 'object' || details === null) return undefined
  const out: DiagnosticDetails = {}
  for (const [key, validate] of Object.entries(spec)) {
    if (!Object.prototype.hasOwnProperty.call(details, key)) continue
    const value = validate((details as Record<string, unknown>)[key])
    if (value !== undefined) out[key] = value
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/** Coarse kind of a raw external asset path from its prefix only; never the path itself. */
export function classifyAssetKind(rawPath: string): 'external' | 'proxied' | 'unknown' {
  if (typeof rawPath !== 'string') return 'unknown'
  if (rawPath.startsWith('mp:external/') || rawPath.startsWith('external/')) return 'external'
  if (rawPath.startsWith('mp:')) return 'proxied'
  return 'unknown'
}

export function classifyAssetKinds(rawPaths: readonly string[]): 'external' | 'proxied' | 'mixed' | 'unknown' | 'none' {
  if (rawPaths.length === 0) return 'none'
  const kinds = new Set(rawPaths.map(classifyAssetKind))
  if (kinds.size > 1) return 'mixed'
  return [...kinds][0]!
}

export function classifyErrorKind(error: unknown): 'user' | 'fatal' | 'transient' | 'superseded' | 'other' {
  if (error instanceof SupersededError) return 'superseded'
  if (error instanceof FatalError) return 'fatal'
  if (error instanceof UserError) return 'user'
  if (error instanceof TransientError) return 'transient'
  return 'other'
}

function cloneEntry(entry: DiagnosticEntry): DiagnosticEntry {
  const out: DiagnosticEntry = { id: entry.id, time: entry.time, level: entry.level, event: entry.event, message: entry.message }
  if (entry.details) out.details = { ...entry.details }
  return out
}

/** Rebuilds an entry from persisted data using the catalog; null if invalid. */
function restoreEntry(raw: unknown): DiagnosticEntry | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  if (!isDiagnosticEvent(r.event)) return null
  if (typeof r.id !== 'string' || r.id.length > 64 || !/^[a-z0-9]+-[a-z0-9]+$/.test(r.id)) return null
  if (typeof r.time !== 'number' || !Number.isFinite(r.time) || r.time <= 0) return null
  const spec = CATALOG[r.event]!
  const entry: DiagnosticEntry = { id: r.id, time: r.time, level: spec.level, event: r.event, message: spec.message }
  const details = sanitizeDetails(r.event, r.details)
  if (details) entry.details = details
  return entry
}

export class DiagnosticLogger {
  private readonly d: DiagnosticLoggerDeps
  private enabled = false
  private entries: DiagnosticEntry[] = []
  private seq = 0
  private chain: Promise<void> = Promise.resolve()
  private initPromise: Promise<void> | null = null

  constructor(deps: DiagnosticLoggerDeps) {
    this.d = deps
  }

  /** Loads the preference and persisted entries. Idempotent; never rejects. */
  init(): Promise<void> {
    this.initPromise ??= this.load()
    return this.initPromise
  }

  private async load(): Promise<void> {
    let enabled = false
    let entries: DiagnosticEntry[] = []
    try {
      const stored = await this.d.local.get([DEBUG_ENABLED_KEY])
      enabled = stored[DEBUG_ENABLED_KEY] === true
    } catch {
      /* default off */
    }
    if (enabled) {
      try {
        const stored = await this.d.session.get([DIAGNOSTICS_KEY])
        const raw = stored[DIAGNOSTICS_KEY]
        if (Array.isArray(raw)) {
          entries = raw.map(restoreEntry).filter((e): e is DiagnosticEntry => e !== null)
        }
      } catch {
        /* start empty */
      }
    }
    // Anything recorded or toggled while loading wins over persisted state.
    if (this.touched) return
    this.enabled = enabled
    this.entries = entries.slice(-MAX_DIAGNOSTIC_ENTRIES)
  }

  private touched = false

  /** Snapshot clone of the current log, after pending writes settle. */
  async get(): Promise<Diagnostics> {
    await this.init()
    await this.chain
    return this.snapshot()
  }

  async setEnabled(enabled: boolean): Promise<Diagnostics> {
    await this.init()
    this.touched = true
    const was = this.enabled
    // Idempotent enable keeps the existing log and writes nothing.
    if (enabled && was) return this.get()
    this.enabled = enabled
    this.entries = []
    const items = { local: { [DEBUG_ENABLED_KEY]: enabled }, session: { [DIAGNOSTICS_KEY]: [] as DiagnosticEntry[] } }
    this.enqueue(async () => {
      await this.d.local.set(items.local)
      await this.d.session.set(items.session)
    })
    if (enabled && !was) this.record('debug_enabled')
    return this.get()
  }

  async clear(): Promise<Diagnostics> {
    await this.init()
    this.touched = true
    this.entries = []
    this.persistEntries()
    return this.get()
  }

  /** Records a catalogued event. No-op when disabled, unknown or before init. */
  record(event: string, details?: Record<string, unknown>): void {
    if (!this.enabled || !isDiagnosticEvent(event)) return
    try {
      const spec = CATALOG[event]!
      const entry: DiagnosticEntry = {
        id: `${(this.d.now ?? Date.now)().toString(36)}-${(++this.seq).toString(36)}`,
        time: (this.d.now ?? Date.now)(),
        level: spec.level,
        event,
        message: spec.message,
      }
      const clean = sanitizeDetails(event, details)
      if (clean) entry.details = clean
      this.touched = true
      this.entries.push(entry)
      if (this.entries.length > MAX_DIAGNOSTIC_ENTRIES) {
        this.entries.splice(0, this.entries.length - MAX_DIAGNOSTIC_ENTRIES)
      }
      this.persistEntries()
    } catch {
      /* logging must never break the extension */
    }
  }

  private snapshot(): Diagnostics {
    return { enabled: this.enabled, entries: this.entries.map(cloneEntry) }
  }

  private persistEntries(): void {
    const copy = this.entries.map(cloneEntry)
    this.enqueue(() => this.d.session.set({ [DIAGNOSTICS_KEY]: copy }))
  }

  /** Writes are serialized in call order; failures are swallowed. */
  private enqueue(write: () => Promise<void>): void {
    this.chain = this.chain.then(write).then(
      () => undefined,
      () => undefined,
    )
  }
}

let singleton: DiagnosticLogger | null = null

/** Process-wide logger; deps are used only on first call. */
export function getDiagnosticLogger(deps: DiagnosticLoggerDeps): DiagnosticLogger {
  singleton ??= new DiagnosticLogger(deps)
  return singleton
}


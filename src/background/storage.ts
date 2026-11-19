import { normalizeActivity } from '../lib/activity.ts'
import type { PendingAuth } from '../lib/pkce.ts'
import { ACTIVITY_TYPES, DEFAULT_ACTIVITY, DEFAULT_SETTINGS, DEFAULT_TRACKING } from '../shared/types.ts'
import type {
  Activity,
  ActivityButton,
  ConnectionState,
  Settings,
  SnapshotUser,
  TrackingSettings,
} from '../shared/types.ts'

export interface Credentials {
  accessToken: string
  refreshToken: string | null
  /** epoch ms */
  expiresAt: number
  scope: string
  clientId: string
}

export interface Status {
  connection: ConnectionState
  error: string | null
}

/** Everything persisted in chrome.storage.local (one key per field). */
export interface Stored {
  settings: Settings
  activity: Activity
  activityEnabled: boolean
  credentials: Credentials | null
  user: SnapshotUser | null
  pending: PendingAuth | null
  /** The user wants the gateway connected (survives worker restarts). */
  desired: boolean
  status: Status
  /** Tracking preferences only; browser/tab data is never persisted here. */
  tracking: TrackingSettings
}

export const STORED_KEYS: ReadonlyArray<keyof Stored> = [
  'tracking',
  'settings',
  'activity',
  'activityEnabled',
  'credentials',
  'user',
  'pending',
  'desired',
  'status',
]

export interface StorageLike {
  get(keys: string[]): Promise<Record<string, unknown>>
  set(items: Record<string, unknown>): Promise<void>
  remove(keys: string[]): Promise<void>
}

const CONNECTIONS: readonly ConnectionState[] = ['disconnected', 'authorizing', 'connecting', 'connected', 'error']

function rec(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

export function parseSettings(value: unknown): Settings {
  const r = rec(value)
  return r ? { clientId: str(r.clientId), clientSecret: str(r.clientSecret) } : { ...DEFAULT_SETTINGS }
}

/**
 * Lenient parse for stored data: unknown/invalid fields fall back to defaults.
 * Unknown extras (e.g. fields from older builds) are ignored, not migrated.
 */
export function parseTracking(value: unknown): TrackingSettings {
  const r = rec(value)
  if (!r) return { ...DEFAULT_TRACKING }
  return {
    enabled: r.enabled === true,
    allowUrlSharing: r.allowUrlSharing === true,
    // Defaults to true: anything but an explicit `false` keeps hiding on unfocus.
    hideOnUnfocus: r.hideOnUnfocus !== false,
  }
}

/**
 * Strict parse for commands. Returns the settings, or an error message that is
 * safe to show to the user. Wrong types are rejected rather than defaulted.
 * Only the three real fields are read; legacy fields (showTimer, timerMode, ...)
 * are ignored. The timer lives solely in the activity's timestamp templates.
 */
export function validateTracking(value: unknown): { ok: true; tracking: TrackingSettings } | { ok: false; error: string } {
  const r = rec(value)
  if (!r) return { ok: false, error: 'Tracking settings are invalid.' }
  if (
    typeof r.enabled !== 'boolean' ||
    typeof r.allowUrlSharing !== 'boolean' ||
    (r.hideOnUnfocus !== undefined && typeof r.hideOnUnfocus !== 'boolean')
  ) {
    return { ok: false, error: 'Tracking settings are invalid.' }
  }
  return {
    ok: true,
    tracking: {
      enabled: r.enabled,
      allowUrlSharing: r.allowUrlSharing,
      hideOnUnfocus: r.hideOnUnfocus !== false,
    },
  }
}

/** Compatibility wrapper: null when invalid. */
export function parseTrackingStrict(value: unknown): TrackingSettings | null {
  const result = validateTracking(value)
  return result.ok ? result.tracking : null
}

function parseButtons(value: unknown): ActivityButton[] | undefined {
  if (!Array.isArray(value)) return undefined
  const out: ActivityButton[] = []
  for (const item of value.slice(0, 2)) {
    const r = rec(item)
    if (r && typeof r.label === 'string' && typeof r.url === 'string') out.push({ label: r.label, url: r.url })
  }
  return out.length > 0 ? out : undefined
}

export function parseActivity(value: unknown): Activity {
  try {
    return normalizeActivity(value)
  } catch {
    const r = rec(value)
    if (!r) return { ...DEFAULT_ACTIVITY }
    // Keep the stored draft as far as it is usable (name may be empty).
    const type = typeof r.type === 'number' && ACTIVITY_TYPES.includes(r.type as Activity['type']) ? (r.type as Activity['type']) : 0
    const draft: Activity = {
      name: str(r.name),
      type,
      details: str(r.details),
      state: str(r.state),
      largeImage: str(r.largeImage),
      largeText: str(r.largeText),
      smallImage: str(r.smallImage),
      smallText: str(r.smallText),
    }
    const buttons = parseButtons(r.buttons)
    if (buttons) draft.buttons = buttons
    const ts = rec(r.timestamps)
    if (ts && (typeof ts.start === 'string' || typeof ts.end === 'string')) {
      // Raw template strings only (no tab data); validated again at send time.
      draft.timestamps = { start: str(ts.start), end: str(ts.end) }
    }
    return draft
  }
}

export function parseCredentials(value: unknown): Credentials | null {
  const r = rec(value)
  if (!r || typeof r.accessToken !== 'string' || !r.accessToken) return null
  if (typeof r.expiresAt !== 'number' || typeof r.clientId !== 'string') return null
  return {
    accessToken: r.accessToken,
    refreshToken: typeof r.refreshToken === 'string' && r.refreshToken ? r.refreshToken : null,
    expiresAt: r.expiresAt,
    scope: str(r.scope),
    clientId: r.clientId,
  }
}

export function parseUser(value: unknown): SnapshotUser | null {
  const r = rec(value)
  if (!r || typeof r.id !== 'string' || typeof r.username !== 'string') return null
  return { id: r.id, username: r.username, avatar: typeof r.avatar === 'string' ? r.avatar : null }
}

export function parsePending(value: unknown): PendingAuth | null {
  const r = rec(value)
  if (!r) return null
  if (
    typeof r.state !== 'string' ||
    typeof r.verifier !== 'string' ||
    typeof r.clientId !== 'string' ||
    typeof r.redirectUri !== 'string' ||
    typeof r.createdAt !== 'number' ||
    typeof r.expiresAt !== 'number'
  ) {
    return null
  }
  return {
    state: r.state,
    verifier: r.verifier,
    clientId: r.clientId,
    redirectUri: r.redirectUri,
    createdAt: r.createdAt,
    expiresAt: r.expiresAt,
  }
}

export function parseStatus(value: unknown): Status {
  const r = rec(value)
  if (!r || !CONNECTIONS.includes(r.connection as ConnectionState)) return { connection: 'disconnected', error: null }
  return {
    connection: r.connection as ConnectionState,
    error: typeof r.error === 'string' ? r.error : null,
  }
}

export async function loadStored(storage: StorageLike): Promise<Stored> {
  const raw = await storage.get([...STORED_KEYS])
  return {
    settings: parseSettings(raw.settings),
    activity: parseActivity(raw.activity),
    activityEnabled: raw.activityEnabled === true,
    credentials: parseCredentials(raw.credentials),
    user: parseUser(raw.user),
    pending: parsePending(raw.pending),
    desired: raw.desired === true,
    status: parseStatus(raw.status),
    tracking: parseTracking(raw.tracking),
  }
}

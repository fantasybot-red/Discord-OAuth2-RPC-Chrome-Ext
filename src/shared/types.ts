export type ActivityType = 0 | 2 | 3 | 5

export interface Settings {
  clientId: string
  clientSecret: string
}

export interface ActivityButton {
  label: string
  url: string
}

export interface Activity {
  name: string
  type: ActivityType
  details: string
  state: string
  largeImage: string
  largeText: string
  smallImage: string
  smallText: string
  /** Discord link buttons (max 2). Templates are expanded at send time. */
  buttons?: ActivityButton[]
  /**
   * Raw timer templates; the only source of the Discord timer. Each is empty,
   * an ISO date-time with timezone, epoch ms, or a placeholder such as
   * {browser_started_at}, {tab_opened_at}, {tab_active_at}. Both blank (or
   * absent) means no timer.
   */
  timestamps?: { start: string; end: string }
}

export interface TrackingSettings {
  enabled: boolean
  allowUrlSharing: boolean
  /**
   * true (default): hide the activity entirely when Chrome has no focused
   * window. false: keep showing the last eligible tab while unfocused. A
   * focused private/internal tab always hides, regardless of this setting.
   */
  hideOnUnfocus: boolean
}

export interface BrowserContext {
  focused: boolean
  trackable: boolean
  tabTitle: string
  /** Blank unless allowUrlSharing is on (always blank in snapshots otherwise). */
  tabUrl: string
  tabOrigin: string
  tabHostname: string
  tabFavicon: string
  tabCount: number
  windowCount: number
  windowTabCount: number
  /** Epoch ms; 0 if unknown. */
  browserStartedAt: number
  tabOpenedAt: number
  tabActiveAt: number
}

export type ConnectionState =
  | 'disconnected'
  | 'authorizing'
  | 'connecting'
  | 'connected'
  | 'error'

export interface SnapshotUser {
  id: string
  username: string
  avatar: string | null
}

export interface Snapshot {
  settings: Settings
  activity: Activity
  connection: ConnectionState
  error: string | null
  user: SnapshotUser | null
  hasCredentials: boolean
  activityEnabled: boolean
  redirectUri: string
  tracking: TrackingSettings
  /** Live browser context (memory only); null when unavailable. */
  browser: BrowserContext | null
  trackingError: string | null
}

export type DiagnosticLevel = 'info' | 'warn' | 'error'

export type DiagnosticDetails = Record<string, string | number | boolean | null>

/** One sanitized debug-log entry. Never contains tokens, URLs, titles or IDs. */
export interface DiagnosticEntry {
  id: string
  /** Epoch ms. */
  time: number
  level: DiagnosticLevel
  event: string
  message: string
  details?: DiagnosticDetails
}

export interface Diagnostics {
  enabled: boolean
  entries: DiagnosticEntry[]
}

export const ACTIVITY_TYPES: readonly ActivityType[] = [0, 2, 3, 5]

export const DEFAULT_TRACKING: TrackingSettings = {
  enabled: false,
  allowUrlSharing: false,
  hideOnUnfocus: true,
}

export const DEFAULT_SETTINGS: Settings = { clientId: '', clientSecret: '' }

export const DEFAULT_ACTIVITY: Activity = {
  name: '',
  type: 0,
  details: '',
  state: '',
  largeImage: '',
  largeText: '',
  smallImage: '',
  smallText: '',
}

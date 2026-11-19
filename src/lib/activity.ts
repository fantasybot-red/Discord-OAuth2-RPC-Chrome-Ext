import { MAX_FIELD_LENGTH } from './constants.ts'
import { UserError } from './errors.ts'
import { ACTIVITY_TYPES } from '../shared/types.ts'
import type { Activity, ActivityButton, ActivityType } from '../shared/types.ts'
import {
  MAX_BUTTONS,
  MAX_BUTTON_LABEL_LENGTH,
  MAX_BUTTON_URL_LENGTH,
  hasTemplateToken,
  isValidButtonUrl,
  isValidButtonUrlTemplate,
  isValidImageTemplate,
  normalizeTimestampFields,
} from './templates.ts'

const MAX_IMAGE_LENGTH = 512
const SNOWFLAKE_RE = /^\d{17,20}$/
const PASSTHROUGH_PREFIXES = ['mp:', 'youtube:', 'spotify:', 'twitch:']
const DISCORD_CDN_ORIGINS = new Set(['https://cdn.discordapp.com', 'https://media.discordapp.net'])

export type ImageRef =
  | { kind: 'none' }
  /** Asset key / snowflake / proxied (`mp:`) reference sent as-is. */
  | { kind: 'asset'; value: string }
  /** External https URL that must be registered via /external-assets first. */
  | { kind: 'external'; url: string }

function text(value: unknown, field: string, max = MAX_FIELD_LENGTH): string {
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string') throw new UserError(`${field} must be text.`)
  const trimmed = value.trim()
  if (trimmed.length > max) throw new UserError(`${field} must be at most ${max} characters.`)
  return trimmed
}

/** Validates and trims untrusted activity input from a message. */
export function normalizeActivity(input: unknown): Activity {
  if (typeof input !== 'object' || input === null) throw new UserError('Activity is invalid.')
  const v = input as Record<string, unknown>
  const name = text(v.name, 'Name')
  if (!name) throw new UserError('Activity name is required.')
  const type = v.type
  if (typeof type !== 'number' || !ACTIVITY_TYPES.includes(type as ActivityType)) {
    throw new UserError('Activity type must be Playing, Listening, Watching or Competing.')
  }
  const activity: Activity = {
    name,
    type: type as ActivityType,
    details: text(v.details, 'Details'),
    state: text(v.state, 'State'),
    largeImage: text(v.largeImage, 'Large image', MAX_IMAGE_LENGTH),
    largeText: text(v.largeText, 'Large image text'),
    smallImage: text(v.smallImage, 'Small image', MAX_IMAGE_LENGTH),
    smallText: text(v.smallText, 'Small image text'),
  }
  // Fail early on unusable image references (templated images are checked against example values).
  checkImage(activity.largeImage, 'Large image')
  checkImage(activity.smallImage, 'Small image')
  const buttons = normalizeButtons(v.buttons)
  if (buttons.length > 0) activity.buttons = buttons
  const timestamps = normalizeTimestampFields(v.timestamps)
  if (timestamps) activity.timestamps = timestamps
  return activity
}

function checkImage(value: string, field: string): void {
  if (hasTemplateToken(value)) {
    if (!isValidImageTemplate(value)) throw new UserError(`${field} template must produce an https URL.`)
    return
  }
  classifyImage(value)
}

/** Optional Discord link buttons: max 2, label 1-32 chars, http(s) URL or URL template. */
function normalizeButtons(input: unknown): ActivityButton[] {
  if (input === undefined || input === null) return []
  if (!Array.isArray(input)) throw new UserError('Buttons must be a list.')
  if (input.length > MAX_BUTTONS) throw new UserError(`At most ${MAX_BUTTONS} buttons are allowed.`)
  const buttons: ActivityButton[] = []
  input.forEach((item: unknown, index: number) => {
    const n = index + 1
    if (item === undefined || item === null) return
    if (typeof item !== 'object' || Array.isArray(item)) throw new UserError(`Button ${n} is invalid.`)
    const b = item as Record<string, unknown>
    const label = text(b.label, `Button ${n} label`, MAX_BUTTON_LABEL_LENGTH)
    const url = text(b.url, `Button ${n} URL`, MAX_BUTTON_URL_LENGTH)
    if (!label && !url) return
    if (!label) throw new UserError(`Button ${n} needs a label.`)
    if (!url) throw new UserError(`Button ${n} needs a URL.`)
    if (!isValidButtonUrlTemplate(url)) {
      throw new UserError(`Button ${n} URL must be a valid http(s) link (no credentials).`)
    }
    buttons.push({ label, url })
  })
  return buttons
}

/**
 * Decides how an image reference is sent to Discord:
 *  - Discord CDN URLs are proxied (`mp:path`) like the reference does.
 *  - Other https URLs must be registered through /external-assets.
 *  - Asset keys, snowflakes and `mp:`/`youtube:`/`spotify:`/`twitch:` pass through.
 */
export function classifyImage(raw: string): ImageRef {
  const value = raw.trim()
  if (!value) return { kind: 'none' }
  if (/^https?:\/\//i.test(value)) {
    let url: URL
    try {
      url = new URL(value)
    } catch {
      throw new UserError('Image URL is not valid.')
    }
    if (url.protocol !== 'https:') throw new UserError('Image URLs must use https.')
    if (url.username || url.password) throw new UserError('Image URLs must not contain credentials.')
    if (DISCORD_CDN_ORIGINS.has(url.origin)) {
      return { kind: 'asset', value: `mp:${url.pathname.slice(1)}${url.search}` }
    }
    return { kind: 'external', url: url.toString() }
  }
  if (SNOWFLAKE_RE.test(value)) return { kind: 'asset', value }
  if (PASSTHROUGH_PREFIXES.some((prefix) => value.startsWith(prefix))) return { kind: 'asset', value }
  if (value.startsWith('external/')) return { kind: 'asset', value: `mp:${value}` }
  if (value.includes(':')) throw new UserError('Unsupported image reference. Use an https URL or an asset key.')
  return { kind: 'asset', value }
}

/** Distinct external URLs (max 2) that need resolving. */
export function externalUrls(activity: Activity): string[] {
  const urls: string[] = []
  for (const raw of [activity.largeImage, activity.smallImage]) {
    const ref = classifyImage(raw)
    if (ref.kind === 'external' && !urls.includes(ref.url)) urls.push(ref.url)
  }
  return urls
}

/** `external_asset_path` -> value usable in `assets.*_image`. */
export function externalAssetValue(path: string): string {
  return path.startsWith('mp:') ? path : `mp:${path}`
}

function resolveImage(raw: string, resolved: ReadonlyMap<string, string>): string | undefined {
  const ref = classifyImage(raw)
  if (ref.kind === 'none') return undefined
  if (ref.kind === 'asset') return ref.value
  const value = resolved.get(ref.url)
  if (!value) throw new UserError('External image has not been resolved.')
  return value
}

export interface PresenceActivity {
  application_id: string
  name: string
  type: number
  state?: string
  details?: string
  session_id: string
  platform: 'desktop'
  created_at: number
  assets?: {
    large_image?: string
    large_text?: string
    small_image?: string
    small_text?: string
  }
  /** Epoch ms; Discord renders the elapsed/remaining timer itself. */
  timestamps?: { start?: number; end?: number }
  /** Link button labels (max 2); URLs live in metadata.button_urls in the same order. */
  buttons?: string[]
  metadata?: { button_urls: string[] }
}

export interface PresenceUpdate {
  activities: PresenceActivity[]
  afk: false
  since: 0
  status: 'online'
}

export interface BuildPresenceInput {
  activity: Activity
  clientId: string
  sessionId: string
  /** external url -> resolved asset value */
  resolved: ReadonlyMap<string, string>
  createdAt: number
  /** Optional epoch ms for `timestamps.start`; omitted unless a finite positive number. */
  startTimestamp?: number
  /** Optional epoch ms for `timestamps.end`; dropped if not finite positive or not after the start. */
  endTimestamp?: number
}

function validEpoch(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined
}

/** Payload `d` for gateway op 3 (presence update). */
export function buildPresence(input: BuildPresenceInput): PresenceUpdate {
  const { activity, clientId, sessionId, resolved, createdAt, startTimestamp, endTimestamp } = input
  const entry: PresenceActivity = {
    application_id: clientId,
    name: activity.name,
    type: activity.type,
    session_id: sessionId,
    platform: 'desktop',
    created_at: createdAt,
  }
  if (activity.state) entry.state = activity.state
  if (activity.details) entry.details = activity.details

  const assets: NonNullable<PresenceActivity['assets']> = {}
  const largeImage = resolveImage(activity.largeImage, resolved)
  const smallImage = resolveImage(activity.smallImage, resolved)
  if (largeImage) assets.large_image = largeImage
  if (activity.largeText) assets.large_text = activity.largeText
  if (smallImage) assets.small_image = smallImage
  if (activity.smallText) assets.small_text = activity.smallText
  if (Object.keys(assets).length > 0) entry.assets = assets

  const start = validEpoch(startTimestamp)
  const rawEnd = validEpoch(endTimestamp)
  const end = rawEnd !== undefined && (start === undefined || rawEnd > start) ? rawEnd : undefined
  if (start !== undefined || end !== undefined) {
    const timestamps: NonNullable<PresenceActivity['timestamps']> = {}
    if (start !== undefined) timestamps.start = start
    if (end !== undefined) timestamps.end = end
    entry.timestamps = timestamps
  }

  // Only fully rendered, valid http(s) buttons are ever sent (max 2).
  const buttons = (activity.buttons ?? [])
    .filter((b) => b && b.label && isValidButtonUrl(b.url))
    .slice(0, MAX_BUTTONS)
  if (buttons.length > 0) {
    entry.buttons = buttons.map((b) => b.label.slice(0, MAX_BUTTON_LABEL_LENGTH))
    entry.metadata = { button_urls: buttons.map((b) => b.url) }
  }

  return { activities: [entry], afk: false, since: 0, status: 'online' }
}

export function buildClearPresence(): PresenceUpdate {
  return { activities: [], afk: false, since: 0, status: 'online' }
}

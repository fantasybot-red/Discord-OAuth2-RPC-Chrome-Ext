import { UserError } from './errors.ts'
import { DEFAULT_TRACKING } from '../shared/types.ts'
import type { Activity, ActivityButton, BrowserContext, TrackingSettings } from '../shared/types.ts'

export interface TemplateParameter {
  key: string
  label: string
  description?: string
}

/** Placeholder metadata for the UI. Aliases are accepted but not listed. */
export const TEMPLATE_PARAMETERS: readonly TemplateParameter[] = [
  { key: 'tab_title', label: 'Tab title', description: 'Title of the focused tab' },
  { key: 'tab_favicon', label: 'Tab favicon', description: 'Site icon as a 128px PNG from Google (works for SVG/ICO favicons). Google receives the site hostname' },
  { key: 'tab_icon_large', label: 'Large site icon', description: 'Larger site icon, 128px PNG, from Icon Horse (no key). Icon Horse receives the site hostname; size is not guaranteed native' },
  { key: 'tab_count', label: 'Tab count', description: 'Number of open tabs' },
  { key: 'window_count', label: 'Window count', description: 'Number of browser windows' },
  { key: 'window_tab_count', label: 'Window tab count', description: 'Number of tabs in the focused window' },
  { key: 'tab_hostname', label: 'Tab hostname', description: 'Domain of the focused tab' },
  { key: 'tab_origin', label: 'Tab origin', description: 'Scheme and domain of the focused tab (no path)' },
  { key: 'tab_url', label: 'Tab URL', description: 'Full URL of the focused tab. Only works when URL sharing is on' },
  { key: 'browser_elapsed', label: 'Browser elapsed', description: 'Time since this browser session was first observed' },
  { key: 'tab_elapsed', label: 'Tab elapsed', description: 'Time since tab creation or first observation' },
  { key: 'active_elapsed', label: 'Active elapsed', description: 'Time since the tab became active' },
  { key: 'browser_started_at', label: 'Browser started at', description: 'Start/end timestamp fields only: when this browser session was first observed' },
  { key: 'tab_opened_at', label: 'Tab opened at', description: 'Start/end timestamp fields only: when the tab was created or first observed' },
  { key: 'tab_active_at', label: 'Tab active at', description: 'Start/end timestamp fields only: when the tab became active' },
]

/** Alias -> canonical key. `tab_fravirte_icon` keeps the user's original spelling. */
const ALIASES: Readonly<Record<string, string>> = {
  tab_favorite_icon: 'tab_favicon',
  tab_fravirte_icon: 'tab_favicon',
}

export const MAX_TEXT_LENGTH = 128
export const MAX_BUTTON_LABEL_LENGTH = 32
export const MAX_BUTTON_URL_LENGTH = 2048
export const MAX_BUTTONS = 2
const MAX_IMAGE_LENGTH = 512

const TOKEN_RE = /\{([A-Za-z0-9_]+)\}/g
const URL_FORBIDDEN_RE = /[\s\u0000-\u001f\u007f]/

/** Placeholder values used to validate raw URL/image templates before any tab exists. */
const EXAMPLE_VALUES: Readonly<Record<string, string>> = {
  tab_title: 'Example',
  tab_favicon: 'https://www.google.com/s2/favicons?domain=example.com&sz=128',
  tab_icon_large: 'https://icon.horse/icon/example.com/128',
  tab_count: '1',
  window_count: '1',
  window_tab_count: '1',
  tab_hostname: 'example.com',
  tab_origin: 'https://example.com',
  tab_url: 'https://example.com/path',
  browser_elapsed: '0:00',
  tab_elapsed: '0:00',
  active_elapsed: '0:00',
}

/** Values that are complete URLs and may be inserted unencoded at the start of a URL template. */
const VERBATIM_URL_KEYS: ReadonlySet<string> = new Set(['tab_url', 'tab_origin', 'tab_favicon', 'tab_icon_large'])

function canonicalKey(key: string): string {
  return ALIASES[key] ?? key
}

function truncate(value: string, max: number): string {
  const chars = Array.from(value)
  return chars.length > max ? chars.slice(0, max).join('') : value
}

function cleanText(value: unknown): string {
  if (typeof value !== 'string') return ''
  return value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()
}

/** True when `template` contains a known placeholder (or alias). */
export function hasTemplateToken(template: string): boolean {
  for (const match of template.matchAll(TOKEN_RE)) {
    if (canonicalKey(match[1]) in EXAMPLE_VALUES) return true
  }
  return false
}

/**
 * Single-pass expansion: substituted values are never re-scanned, so a page title
 * containing "{tab_url}" stays literal. Unknown placeholders remain literal.
 */
export function renderText(template: string, values: Readonly<Record<string, string>>, max = MAX_TEXT_LENGTH): string {
  const out = template.replace(TOKEN_RE, (whole: string, raw: string) => {
    const key = canonicalKey(raw)
    return Object.prototype.hasOwnProperty.call(values, key) ? values[key] : whole
  })
  return truncate(out.trim(), max)
}

function httpUrlOrNull(value: string, protocols: readonly string[]): URL | null {
  if (!value || URL_FORBIDDEN_RE.test(value)) return null
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return null
  }
  if (!protocols.includes(url.protocol)) return null
  if (url.username || url.password) return null
  if (!url.hostname) return null
  return url
}

/** Valid http(s) link without credentials/whitespace, max 2048. */
export function isValidButtonUrl(value: string): boolean {
  return value.length <= MAX_BUTTON_URL_LENGTH && httpUrlOrNull(value, ['http:', 'https:']) !== null
}

/**
 * URL templates: tab_url/tab_origin/tab_favicon/tab_icon_large are inserted verbatim only when
 * they are the very start of the template; everywhere else values are percent-encoded.
 */
export function renderUrlTemplate(template: string, values: Readonly<Record<string, string>>): string {
  return template.replace(TOKEN_RE, (whole: string, raw: string, offset: number) => {
    const key = canonicalKey(raw)
    if (!Object.prototype.hasOwnProperty.call(values, key)) return whole
    const value = values[key]
    if (offset === 0 && VERBATIM_URL_KEYS.has(key)) return value
    return encodeURIComponent(value)
  }).trim()
}

/** Whether a raw button URL (literal or template) can yield a valid http(s) URL. */
export function isValidButtonUrlTemplate(template: string): boolean {
  if (!hasTemplateToken(template)) return isValidButtonUrl(template)
  return isValidButtonUrl(renderUrlTemplate(template, EXAMPLE_VALUES))
}

/** Whether a raw image template (containing placeholders) can yield an https URL. */
export function isValidImageTemplate(template: string): boolean {
  if (template.length > MAX_IMAGE_LENGTH) return false
  return httpUrlOrNull(renderUrlTemplate(template, EXAMPLE_VALUES), ['https:']) !== null
}

function epochOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : null
}

/** Lenient normalizer: malformed fields fall back to the shared defaults; legacy fields (showTimer/timerMode) are ignored. */
export function normalizeTracking(input: unknown): TrackingSettings {
  const v = typeof input === 'object' && input !== null && !Array.isArray(input) ? (input as Record<string, unknown>) : {}
  return {
    enabled: typeof v.enabled === 'boolean' ? v.enabled : DEFAULT_TRACKING.enabled,
    allowUrlSharing: typeof v.allowUrlSharing === 'boolean' ? v.allowUrlSharing : DEFAULT_TRACKING.allowUrlSharing,
    hideOnUnfocus: typeof v.hideOnUnfocus === 'boolean' ? v.hideOnUnfocus : DEFAULT_TRACKING.hideOnUnfocus,
  }
}

// ---- activity timestamp fields (start / end) ----------------------------------

export const MAX_TIMESTAMP_FIELD_LENGTH = 128
const MAX_EPOCH_MS = 8_640_000_000_000_000
const TIMESTAMP_HELP =
  'Use epoch milliseconds, an ISO 8601 time with Z or an offset (e.g. 2026-01-02T03:04:05Z), or {browser_started_at}, {tab_opened_at} or {tab_active_at}.'
const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(?:(Z)|([+-])(\d{2}):(\d{2}))$/

/** Placeholders valid only inside the activity start/end fields. */
export const TIMESTAMP_TOKENS: Readonly<Record<string, keyof BrowserContext>> = {
  browser_started_at: 'browserStartedAt',
  tab_opened_at: 'tabOpenedAt',
  tab_active_at: 'tabActiveAt',
}

export type ParsedTimestamp =
  | { kind: 'blank' }
  | { kind: 'literal'; ms: number }
  | { kind: 'anchor'; field: 'browserStartedAt' | 'tabOpenedAt' | 'tabActiveAt' }

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

/**
 * Strict parser for one raw timestamp field. Accepts blank, a positive epoch in milliseconds,
 * ISO 8601 with an explicit zone (Z / ±hh:mm; real calendar dates only) or one exact anchor
 * placeholder. No other expansion, no local-time guessing, no seconds->ms conversion.
 */
export function parseTimestampField(raw: string, label = 'Timestamp'): ParsedTimestamp {
  const value = raw.trim()
  if (!value) return { kind: 'blank' }
  if (value.length > MAX_TIMESTAMP_FIELD_LENGTH) {
    throw new UserError(`${label} must be at most ${MAX_TIMESTAMP_FIELD_LENGTH} characters.`)
  }
  const token = /^\{([A-Za-z0-9_]+)\}$/.exec(value)
  if (token) {
    const field = TIMESTAMP_TOKENS[token[1]]
    if (!field) throw new UserError(`${label} has an unknown placeholder ${value}. ${TIMESTAMP_HELP}`)
    return { kind: 'anchor', field: field as 'browserStartedAt' | 'tabOpenedAt' | 'tabActiveAt' }
  }
  if (/^\d+$/.test(value)) {
    const ms = Number(value)
    if (!Number.isSafeInteger(ms) || ms <= 0 || ms > MAX_EPOCH_MS) {
      throw new UserError(`${label} must be a positive epoch in milliseconds. ${TIMESTAMP_HELP}`)
    }
    return { kind: 'literal', ms }
  }
  const m = ISO_RE.exec(value)
  if (m) {
    const [year, month, day, hour, minute] = [m[1], m[2], m[3], m[4], m[5]].map(Number)
    const second = m[6] === undefined ? 0 : Number(m[6])
    const millis = m[7] === undefined ? 0 : Number(m[7].padEnd(3, '0').slice(0, 3))
    const offsetH = m[10] === undefined ? 0 : Number(m[10])
    const offsetM = m[11] === undefined ? 0 : Number(m[11])
    const valid =
      month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month) &&
      hour <= 23 && minute <= 59 && second <= 59 && offsetH <= 23 && offsetM <= 59
    if (valid) {
      const sign = m[9] === '-' ? -1 : 1
      const ms = Date.UTC(year, month - 1, day, hour, minute, second, millis) - sign * (offsetH * 60 + offsetM) * 60_000
      if (Number.isFinite(ms) && ms > 0) return { kind: 'literal', ms }
    }
    throw new UserError(`${label} is not a valid date and time. ${TIMESTAMP_HELP}`)
  }
  throw new UserError(`${label} is not recognised. ${TIMESTAMP_HELP}`)
}

/**
 * Validates the raw start/end strings of an activity. A blank pair is allowed (returns undefined).
 * When both are literals, end must be after start; dynamic anchors are checked at runtime.
 */
export function normalizeTimestampFields(input: unknown): { start: string; end: string } | undefined {
  if (input === undefined || input === null) return undefined
  if (typeof input !== 'object' || Array.isArray(input)) throw new UserError('Timestamps are invalid.')
  const v = input as Record<string, unknown>
  const read = (value: unknown, label: string): string => {
    if (value === undefined || value === null) return ''
    if (typeof value !== 'string') throw new UserError(`${label} must be text.`)
    return value.trim()
  }
  const start = read(v.start, 'Start timestamp')
  const end = read(v.end, 'End timestamp')
  const a = parseTimestampField(start, 'Start timestamp')
  const b = parseTimestampField(end, 'End timestamp')
  if (a.kind === 'blank' && b.kind !== 'blank') throw new UserError(END_WITHOUT_START)
  if (a.kind === 'literal' && b.kind === 'literal' && b.ms <= a.ms) {
    throw new UserError('The end timestamp must be after the start timestamp.')
  }
  return start || end ? { start, end } : undefined
}

export interface ActivityTimestamps {
  start?: number
  end?: number
}

function resolveTimestamp(parsed: ParsedTimestamp, context: BrowserContext): number | null {
  if (parsed.kind === 'literal') return parsed.ms
  if (parsed.kind === 'anchor') return epochOrNull(context[parsed.field])
  return null
}

const END_WITHOUT_START = 'Set a start timestamp or clear the end timestamp.'

/**
 * Discord `timestamps` from the activity template's start/end fields only (single source; no
 * tracking setting or implicit browser/tab default). Never substitutes the current time.
 *  - no `activity`, no `timestamps`, or both fields blank -> undefined (no timer, no error)
 *  - end without start -> UserError
 *  - start (literal or anchor) must resolve; an unresolved anchor throws
 *  - a given end must resolve and be after the start (may be in the future: countdown)
 */
export function activityTimestamps(context: BrowserContext, activity?: Activity): ActivityTimestamps | undefined {
  const raw = activity?.timestamps
  if (!raw) return undefined
  const startField = parseTimestampField(raw.start ?? '', 'Start timestamp')
  const endField = parseTimestampField(raw.end ?? '', 'End timestamp')
  if (startField.kind === 'blank') {
    if (endField.kind === 'blank') return undefined
    throw new UserError(END_WITHOUT_START)
  }
  const start = resolveTimestamp(startField, context)
  if (start === null) {
    throw new UserError(
      `The start timestamp ${raw.start.trim()} is not available yet. Use a fixed time, or wait until the browser has seen that tab.`,
    )
  }
  if (endField.kind === 'blank') return { start }
  const end = resolveTimestamp(endField, context)
  if (end === null) {
    throw new UserError(
      `The end timestamp ${raw.end.trim()} is not available yet. Clear it, use a fixed time, or wait until the browser has seen that tab.`,
    )
  }
  if (end <= start) throw new UserError('The end timestamp must be after the start timestamp.')
  return { start, end }
}

/** `activityTimestamps(context, activity)?.start`. */
export function activityTimestamp(context: BrowserContext, activity?: Activity): number | undefined {
  return activityTimestamps(context, activity)?.start
}

function formatElapsed(anchor: number, now: number): string {
  if (!Number.isFinite(anchor) || anchor <= 0 || !Number.isFinite(now) || anchor > now) return ''
  const total = Math.floor((now - anchor) / 1000)
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  const ss = String(seconds).padStart(2, '0')
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${ss}` : `${String(minutes).padStart(2, '0')}:${ss}`
}

/** Reserved / non-public suffixes that third-party icon services must never be asked about. */
const NON_PUBLIC_TLDS: ReadonlySet<string> = new Set([
  'localhost', 'local', 'localdomain', 'internal', 'intranet', 'lan', 'home', 'corp', 'private',
  'test', 'invalid', 'example', 'onion', 'arpa',
])
const DNS_LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/
const DNS_TLD_RE = /^(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/

/**
 * Returns a lowercase public DNS name or ''. Requires at least one dot and an alphabetic (or
 * punycode) TLD, so IPv4/IPv6 literals, bare hosts (`intranet`), ports, paths and credentials are
 * rejected, as are `.local`, `.localhost`, `.internal`, `.lan`, ... names.
 */
export function publicDomain(value: unknown): string {
  if (typeof value !== 'string') return ''
  let host = value.trim().toLowerCase()
  if (host.endsWith('.')) host = host.slice(0, -1)
  if (!host || host.length > 253) return ''
  const labels = host.split('.')
  if (labels.length < 2) return ''
  if (!labels.every((label) => DNS_LABEL_RE.test(label))) return ''
  const tld = labels[labels.length - 1]
  if (!DNS_TLD_RE.test(tld) || NON_PUBLIC_TLDS.has(tld)) return ''
  return host
}

/** Google S2 favicon (PNG, handles SVG/ICO sources). Sends only the hostname. '' for non-public hosts. */
export function faviconUrl(hostname: unknown): string {
  const host = publicDomain(hostname)
  return host ? `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=128` : ''
}

/** Icon Horse 128px PNG, keyless. Sends only the hostname. '' for non-public hosts. */
export function largeIconUrl(hostname: unknown): string {
  const host = publicDomain(hostname)
  return host ? `https://icon.horse/icon/${encodeURIComponent(host)}/128` : ''
}

function safeOrigin(value: unknown): string {
  if (typeof value !== 'string') return ''
  const url = httpUrlOrNull(value.trim(), ['http:', 'https:'])
  return url ? url.origin : ''
}

function safeHostname(value: unknown): string {
  if (typeof value !== 'string') return ''
  const host = value.trim().toLowerCase()
  return /^[a-z0-9.\-:[\]]{1,253}$/.test(host) ? host : ''
}

function safeTabUrl(value: unknown): string {
  if (typeof value !== 'string') return ''
  const url = httpUrlOrNull(value.trim(), ['http:', 'https:'])
  return url && url.href.length <= MAX_BUTTON_URL_LENGTH ? url.href : ''
}

function count(value: unknown): string {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? String(Math.floor(value)) : '0'
}

function buildValues(context: BrowserContext, tracking: TrackingSettings, now: number): Record<string, string> {
  return {
    tab_title: cleanText(context.tabTitle),
    tab_favicon: faviconUrl(context.tabHostname),
    tab_icon_large: largeIconUrl(context.tabHostname),
    tab_count: count(context.tabCount),
    window_count: count(context.windowCount),
    window_tab_count: count(context.windowTabCount),
    tab_hostname: safeHostname(context.tabHostname) || 'Unknown domain',
    tab_origin: safeOrigin(context.tabOrigin) || 'Unknown domain',
    tab_url: tracking.allowUrlSharing ? safeTabUrl(context.tabUrl) : '',
    browser_elapsed: formatElapsed(context.browserStartedAt, now),
    tab_elapsed: formatElapsed(context.tabOpenedAt, now),
    active_elapsed: formatElapsed(context.tabActiveAt, now),
  }
}

function renderImage(template: string, values: Readonly<Record<string, string>>): string {
  const raw = template.trim()
  if (!raw || !hasTemplateToken(raw)) return raw
  const rendered = renderUrlTemplate(raw, values)
  // Templated images may only resolve to https URLs (no data:/chrome:/http: icons).
  return httpUrlOrNull(rendered, ['https:']) && rendered.length <= MAX_IMAGE_LENGTH ? rendered : ''
}

function renderButtons(buttons: readonly ActivityButton[] | undefined, values: Readonly<Record<string, string>>): ActivityButton[] {
  const out: ActivityButton[] = []
  for (const button of buttons ?? []) {
    if (out.length >= MAX_BUTTONS) break
    if (typeof button !== 'object' || button === null) continue
    const label = renderText(String(button.label ?? ''), values, MAX_BUTTON_LABEL_LENGTH)
    const url = renderUrlTemplate(String(button.url ?? '').trim(), values)
    if (!label || !isValidButtonUrl(url)) continue
    out.push({ label, url })
  }
  return out
}

/**
 * Expands templates in a normalized activity for one concrete browser context.
 * `buttons` is only present on the result when at least one button survives.
 */
export function renderActivityTemplate(
  activity: Activity,
  context: BrowserContext,
  tracking: TrackingSettings,
  now: number,
): Activity {
  const values = buildValues(context, tracking, now)
  const { buttons, ...rest } = activity
  const rendered: Activity = {
    ...rest,
    name: renderText(activity.name, values) || 'Browser',
    details: renderText(activity.details, values),
    state: renderText(activity.state, values),
    largeImage: renderImage(activity.largeImage, values),
    largeText: renderText(activity.largeText, values),
    smallImage: renderImage(activity.smallImage, values),
    smallText: renderText(activity.smallText, values),
  }
  const renderedButtons = renderButtons(buttons, values)
  if (renderedButtons.length > 0) rendered.buttons = renderedButtons
  return rendered
}

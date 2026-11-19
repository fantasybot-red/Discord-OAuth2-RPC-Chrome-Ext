import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildPresence, normalizeActivity } from '../src/lib/activity.ts'
import { UserError } from '../src/lib/errors.ts'
import {
  TEMPLATE_PARAMETERS,
  activityTimestamp,
  activityTimestamps,
  faviconUrl,
  largeIconUrl,
  normalizeTracking,
  publicDomain,
  renderActivityTemplate,
  renderText,
} from '../src/lib/templates.ts'
import { DEFAULT_TRACKING } from '../src/shared/types.ts'
import type { Activity, BrowserContext, TrackingSettings } from '../src/shared/types.ts'

const NOW = 1_700_000_000_000
const BROWSER_AT = NOW - (3600 + 120 + 5) * 1000 // 1:02:05 ago
const TAB_AT = NOW - (10 * 60 + 7) * 1000 // 10:07 ago
const ACTIVE_AT = NOW - 42 * 1000 // 00:42 ago

const ctx: BrowserContext = {
  focused: true,
  trackable: true,
  tabTitle: 'My Page',
  tabUrl: 'https://example.com/a/b?q=1#frag',
  tabOrigin: 'https://example.com',
  tabHostname: 'example.com',
  tabFavicon: 'https://example.com/favicon.ico',
  tabCount: 7,
  windowCount: 2,
  windowTabCount: 4,
  browserStartedAt: BROWSER_AT,
  tabOpenedAt: TAB_AT,
  tabActiveAt: ACTIVE_AT,
}

const off: TrackingSettings = { ...DEFAULT_TRACKING }
const on: TrackingSettings = { ...DEFAULT_TRACKING, enabled: true, allowUrlSharing: true }

const base: Activity = {
  name: 'Browsing',
  type: 0,
  details: '',
  state: '',
  largeImage: '',
  largeText: '',
  smallImage: '',
  smallText: '',
}

const GOOGLE_EXAMPLE = 'https://www.google.com/s2/favicons?domain=example.com&sz=128'
const HORSE_EXAMPLE = 'https://icon.horse/icon/example.com/128'

const render = (patch: Partial<Activity>, c: BrowserContext = ctx, t: TrackingSettings = off): Activity =>
  renderActivityTemplate({ ...base, ...patch }, c, t, NOW)

// ---- placeholders -----------------------------------------------------------

test('expands the documented placeholders', () => {
  const out = render({
    name: '{tab_title}',
    details: '{tab_hostname} | {tab_origin}',
    state: '{tab_count} tabs, {window_count} windows, {window_tab_count} here',
    largeText: '{tab_favicon}',
  })
  assert.equal(out.name, 'My Page')
  assert.equal(out.details, 'example.com | https://example.com')
  assert.equal(out.state, '7 tabs, 2 windows, 4 here')
  assert.equal(out.largeText, GOOGLE_EXAMPLE)
})

test('favicon aliases incl. the {tab_fravirte_icon} spelling all map to the canonical Google S2 URL', () => {
  const out = render({ details: '{tab_favorite_icon}', state: '{tab_fravirte_icon}', largeText: '{tab_favicon}' })
  assert.equal(out.details, GOOGLE_EXAMPLE)
  assert.equal(out.state, GOOGLE_EXAMPLE)
  assert.equal(out.largeText, GOOGLE_EXAMPLE)
})

test('elapsed placeholders format as MM:SS and H:MM:SS', () => {
  const out = render({ details: '{browser_elapsed}', state: '{tab_elapsed}', largeText: '{active_elapsed}' })
  assert.equal(out.details, '1:02:05')
  assert.equal(out.state, '10:07')
  assert.equal(out.largeText, '00:42')
})

test('elapsed is empty for a missing or future anchor', () => {
  assert.equal(render({ details: '[{tab_elapsed}]' }, { ...ctx, tabOpenedAt: 0 }).details, '[]')
  assert.equal(render({ details: '[{tab_elapsed}]' }, { ...ctx, tabOpenedAt: NOW + 5000 }).details, '[]')
})

test('unknown placeholders stay literal', () => {
  assert.equal(render({ details: '{nope} {tab_title} {}' }).details, '{nope} My Page {}')
})

test('expansion is single-pass: hostile page title is not re-expanded', () => {
  const hostile = { ...ctx, tabTitle: '{tab_url} {tab_hostname}' }
  const out = render({ name: '{tab_title}', details: 'x {tab_title}' }, hostile, on)
  assert.equal(out.name, '{tab_url} {tab_hostname}')
  assert.equal(out.details, 'x {tab_url} {tab_hostname}')
})

test('{tab_url} is empty by default and never leaks the full URL', () => {
  const out = render({ name: 'a{tab_url}b', details: '{tab_origin}' })
  assert.equal(out.name, 'ab')
  assert.ok(!JSON.stringify(out).includes('/a/b'))
  assert.ok(!JSON.stringify(out).includes('q=1'))
})

test('{tab_url} works only when URL sharing is allowed', () => {
  assert.equal(render({ details: '{tab_url}' }, ctx, on).details, 'https://example.com/a/b?q=1#frag')
})

test('internal tabs show title and generic domain without exposing URL or icons', () => {
  const internal = { ...ctx, tabTitle: 'OAuth callback', tabHostname: '', tabOrigin: '', tabUrl: '', tabFavicon: '' }
  const out = render({ name: '{tab_title}', state: 'Viewing on {tab_hostname}', details: '{tab_origin} {tab_url}', largeImage: '{tab_favicon}', smallImage: '{tab_icon_large}', buttons: [{ label: 'Open', url: '{tab_url}' }, { label: 'Origin', url: '{tab_origin}/foo' }] }, internal, on)
  assert.equal(out.name, 'OAuth callback')
  assert.equal(out.state, 'Viewing on Unknown domain')
  assert.equal(out.details, 'Unknown domain')
  assert.equal(out.largeImage, '')
  assert.equal(out.smallImage, '')
  assert.equal(out.buttons, undefined)
  assert.doesNotMatch(JSON.stringify(out), /undefined|chrome:|code=|state=/)
  assert.equal(render({ buttons: [{ label: 'Search', url: 'https://example.com/?host={tab_hostname}' }] }, internal, on).buttons?.[0].url, 'https://example.com/?host=Unknown%20domain')
})

test('invalid domain and origin fields use generic fallback', () => {
  const invalid = { ...ctx, tabHostname: 'bad/path', tabOrigin: 'chrome://settings' }
  const out = render({ details: '{tab_hostname} / {tab_origin}' }, invalid)
  assert.equal(out.details, 'Unknown domain / Unknown domain')
})

test('tab_origin never carries a path even if the context is dirty', () => {
  const dirty = { ...ctx, tabOrigin: 'https://example.com/secret/path?x=1' }
  assert.equal(render({ details: '{tab_origin}' }, dirty).details, 'https://example.com')
})

test('rendered text fields are capped at 128 chars; button labels at 32', () => {
  const long = { ...ctx, tabTitle: 'x'.repeat(500) }
  const out = render(
    { name: '{tab_title}', details: '{tab_title}', state: '{tab_title}', largeText: '{tab_title}', smallText: '{tab_title}', buttons: [{ label: '{tab_title}', url: 'https://example.com' }] },
    long,
  )
  for (const field of [out.name, out.details, out.state, out.largeText, out.smallText]) assert.equal(field.length, 128)
  assert.equal(out.buttons?.[0].label.length, 32)
})

test('renderText truncates after expansion', () => {
  assert.equal(renderText('too long {tab_title}', { tab_title: '1234567890' }, 10), 'too long 1')
  assert.equal(renderText('hi {tab_title}', { tab_title: 'foo' }, 10), 'hi foo')
})

test('TEMPLATE_PARAMETERS is a stable metadata list', () => {
  const keys = TEMPLATE_PARAMETERS.map((p) => p.key)
  for (const key of ['tab_title', 'tab_favicon', 'tab_icon_large', 'tab_count', 'window_count', 'window_tab_count', 'tab_hostname', 'tab_origin', 'tab_url', 'browser_elapsed', 'tab_elapsed', 'active_elapsed']) {
    assert.ok(keys.includes(key), key)
  }
  assert.equal(new Set(keys).size, keys.length)
  for (const p of TEMPLATE_PARAMETERS) assert.ok(p.label)
})

// ---- images -----------------------------------------------------------------

test('{tab_favicon} is Google S2 128px PNG regardless of the raw favIconUrl (SVG/ICO/data/none)', () => {
  for (const tabFavicon of [
    'https://example.com/favicon.ico',
    'https://example.com/logo.svg',
    'http://example.com/f.ico',
    'data:image/png;base64,AAAA',
    'chrome://favicon/x',
    'https://u:p@example.com/f.ico',
    '',
  ]) {
    assert.equal(render({ smallImage: '{tab_favicon}' }, { ...ctx, tabFavicon }).smallImage, GOOGLE_EXAMPLE, tabFavicon)
  }
})

test('YouTube keeps www and the URL carries only the hostname', () => {
  const yt = { ...ctx, tabHostname: 'www.youtube.com', tabUrl: 'https://www.youtube.com/watch?v=SECRET&list=PRIVATE', tabOrigin: 'https://www.youtube.com' }
  const out = render({ smallImage: '{tab_favicon}', largeImage: '{tab_icon_large}' }, yt, on)
  assert.equal(out.smallImage, 'https://www.google.com/s2/favicons?domain=www.youtube.com&sz=128')
  assert.equal(out.largeImage, 'https://icon.horse/icon/www.youtube.com/128')
  const u = new URL(out.smallImage)
  assert.equal(u.searchParams.get('domain'), 'www.youtube.com')
  assert.equal(u.searchParams.get('sz'), '128')
  for (const s of [out.smallImage, out.largeImage]) {
    assert.ok(!/SECRET|PRIVATE|watch|\/v=/.test(s), s)
  }
})

test('{tab_icon_large} is the keyless Icon Horse 128px PNG; aliases do not apply to it', () => {
  assert.equal(render({ largeImage: '{tab_icon_large}' }).largeImage, HORSE_EXAMPLE)
  assert.equal(render({ details: 'x {tab_icon_large}' }).details, `x ${HORSE_EXAMPLE}`)
  assert.equal(render({ largeImage: '{tab_icon_large}' }, { ...ctx, tabFavicon: '' }).largeImage, HORSE_EXAMPLE)
})

test('icon URLs work without a favIconUrl but are empty for hosts that are not public domains', () => {
  const none = (host: string) => ({ ...ctx, tabHostname: host, tabFavicon: 'https://x.example/f.ico' })
  const blocked = [
    'localhost', 'app.localhost', 'printer.local', 'nas.lan', 'db.internal', 'corp.intranet', 'host.home',
    'foo.test', 'foo.example', 'x.invalid', 'abc.onion', '1.0.0.127.in-addr.arpa',
    '127.0.0.1', '10.0.0.5', '192.168.1.10', '172.16.0.1', '169.254.1.1', '8.8.8.8', '0.0.0.0',
    '::1', '[::1]', 'fe80::1', '[2001:db8::1]', 'intranet', 'myserver',
    'a b.com', 'evil.com/path', 'user@evil.com', 'evil.com:8080', 'ev il.com', 'a..com', '-a.com', 'a-.com', '.com', 'x.c', 'x.123', '',
    'a'.repeat(64) + '.com', 'x'.repeat(250) + '.com',
  ]
  for (const host of blocked) {
    const out = render({ smallImage: '{tab_favicon}', largeImage: '{tab_icon_large}', details: '[{tab_favicon}][{tab_icon_large}]' }, none(host))
    assert.equal(out.smallImage, '', `favicon ${host}`)
    assert.equal(out.largeImage, '', `large ${host}`)
    assert.equal(out.details, '[][]', `text ${host}`)
  }
  assert.equal(render({ smallImage: '{tab_favicon}' }, { ...ctx, tabHostname: '  WWW.Example.COM.  ' }).smallImage, 'https://www.google.com/s2/favicons?domain=www.example.com&sz=128')
  assert.equal(render({ smallImage: '{tab_favicon}' }, { ...ctx, tabHostname: 'xn--bcher-kva.example.org' }).smallImage, 'https://www.google.com/s2/favicons?domain=xn--bcher-kva.example.org&sz=128')
  assert.equal(render({ smallImage: '{tab_favicon}' }, { ...ctx, tabHostname: 'a.co.uk' }).smallImage, 'https://www.google.com/s2/favicons?domain=a.co.uk&sz=128')
})

test('publicDomain / faviconUrl / largeIconUrl helpers', () => {
  assert.equal(publicDomain('www.youtube.com'), 'www.youtube.com')
  assert.equal(publicDomain(' YouTube.com '), 'youtube.com')
  assert.equal(publicDomain(123), '')
  assert.equal(publicDomain(undefined), '')
  assert.equal(faviconUrl('www.youtube.com'), 'https://www.google.com/s2/favicons?domain=www.youtube.com&sz=128')
  assert.equal(largeIconUrl('www.youtube.com'), 'https://icon.horse/icon/www.youtube.com/128')
  assert.equal(largeIconUrl('discord.com'), 'https://icon.horse/icon/discord.com/128')
  assert.equal(faviconUrl('192.168.0.1'), '')
  assert.equal(largeIconUrl('localhost'), '')
  assert.ok(faviconUrl('a.com').length <= 512 && largeIconUrl('a.com').length <= 512)
})

test('icon image templates stay within 512 chars: oversize results are dropped', () => {
  const host = `${'a'.repeat(60)}.${'b'.repeat(60)}.${'c'.repeat(60)}.${'d'.repeat(60)}.com`
  const out = render({ smallImage: '{tab_favicon}' }, { ...ctx, tabHostname: host })
  assert.ok(out.smallImage === '' || out.smallImage.length <= 512)
  assert.equal(out.smallImage, faviconUrl(host))
})

test('{tab_icon_large} placement: verbatim at the start, encoded elsewhere; templates validate at normalize time', () => {
  assert.equal(normalizeActivity({ ...base, largeImage: '{tab_icon_large}' }).largeImage, '{tab_icon_large}')
  assert.equal(normalizeActivity({ ...base, smallImage: '{tab_favorite_icon}' }).smallImage, '{tab_favorite_icon}')
  assert.equal(normalizeActivity({ ...base, smallImage: '{tab_fravirte_icon}' }).smallImage, '{tab_fravirte_icon}')
  assert.throws(() => normalizeActivity({ ...base, largeImage: 'x{tab_icon_large}' }), UserError)
  assert.equal(render({ largeImage: 'https://proxy.example/?u={tab_icon_large}' }).largeImage, `https://proxy.example/?u=${encodeURIComponent(HORSE_EXAMPLE)}`)
})

test('plain image keys pass through untouched; templated images validate at normalize time', () => {
  assert.equal(render({ largeImage: 'my_asset' }).largeImage, 'my_asset')
  assert.equal(normalizeActivity({ ...base, smallImage: '{tab_favicon}' }).smallImage, '{tab_favicon}')
  assert.throws(() => normalizeActivity({ ...base, smallImage: 'http://{tab_hostname}/x.png' }), UserError)
})

// ---- tracking / timestamp ---------------------------------------------------

test('DEFAULT_TRACKING / normalizeTracking: only enabled, allowUrlSharing, hideOnUnfocus', () => {
  assert.deepEqual(Object.keys(DEFAULT_TRACKING).sort(), ['allowUrlSharing', 'enabled', 'hideOnUnfocus'])
  assert.equal(DEFAULT_TRACKING.hideOnUnfocus, true)
  assert.deepEqual(normalizeTracking(undefined), DEFAULT_TRACKING)
  assert.deepEqual(normalizeTracking('x'), DEFAULT_TRACKING)
  assert.deepEqual(normalizeTracking([]), DEFAULT_TRACKING)
  assert.deepEqual(normalizeTracking({ enabled: 'yes', allowUrlSharing: null, hideOnUnfocus: 'no' }), DEFAULT_TRACKING)
  assert.deepEqual(normalizeTracking({ enabled: true, allowUrlSharing: true, hideOnUnfocus: false }), {
    enabled: true,
    allowUrlSharing: true,
    hideOnUnfocus: false,
  })
})

test('normalizeTracking ignores legacy persisted showTimer/timerMode/custom fields (no migration)', () => {
  const out = normalizeTracking({ enabled: true, showTimer: true, timerMode: 'tab', customStart: 5, customEnd: 9, extra: 1 })
  assert.deepEqual(out, { ...DEFAULT_TRACKING, enabled: true })
  for (const key of ['showTimer', 'timerMode', 'customStart', 'customEnd', 'extra']) assert.equal(key in out, false, key)
})

// ---- activity timestamps (single source: the template start/end fields) ------

const withTs = (start: string, end = ''): Activity => ({ ...base, timestamps: { start, end } })
const T0 = 1_600_000_000_000
const ISO_T0 = new Date(T0).toISOString() // 2020-09-13T12:26:40.000Z

test('timestamps: epoch-ms literals give start and optional end (future end = countdown)', () => {
  assert.deepEqual(activityTimestamps(ctx, withTs(String(T0))), { start: T0 })
  assert.deepEqual(activityTimestamps(ctx, withTs(String(T0), String(T0 + 3_600_000))), { start: T0, end: T0 + 3_600_000 })
  assert.deepEqual(activityTimestamps(ctx, withTs(String(T0), String(NOW + 86_400_000))), { start: T0, end: NOW + 86_400_000 })
  assert.equal(activityTimestamp(ctx, withTs(String(T0))), T0)
  assert.deepEqual(activityTimestamps(ctx, withTs(' 1 ')), { start: 1 }, 'any finite positive ms accepted, no guessing')
})

test('timestamps: ISO 8601 with Z or offset', () => {
  assert.deepEqual(activityTimestamps(ctx, withTs(ISO_T0)), { start: T0 })
  assert.equal(activityTimestamps(ctx, withTs('2020-09-13T12:26:40Z'))?.start, T0)
  assert.equal(activityTimestamps(ctx, withTs('2020-09-13T19:26:40+07:00'))?.start, T0)
  assert.equal(activityTimestamps(ctx, withTs('2020-09-13T07:56:40-04:30'))?.start, T0)
  assert.equal(activityTimestamps(ctx, withTs('2020-09-13T12:26Z'))?.start, T0 - 40_000)
  assert.equal(activityTimestamps(ctx, withTs('2020-09-13T12:26:40.5Z'))?.start, T0 + 500)
})

test('timestamps: anchor placeholders resolve from the context (exact tokens only)', () => {
  assert.deepEqual(activityTimestamps(ctx, withTs('{browser_started_at}')), { start: BROWSER_AT })
  assert.deepEqual(activityTimestamps(ctx, withTs('{tab_opened_at}')), { start: TAB_AT })
  assert.deepEqual(activityTimestamps(ctx, withTs('{tab_active_at}')), { start: ACTIVE_AT })
  assert.deepEqual(activityTimestamps(ctx, withTs('{tab_opened_at}', String(NOW + 1000))), { start: TAB_AT, end: NOW + 1000 })
  assert.deepEqual(activityTimestamps(ctx, withTs(String(T0), '{tab_active_at}')), { start: T0, end: ACTIVE_AT })
})

test('timestamps: unresolved start anchor throws (never Date.now, never silent no-timer)', () => {
  for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () => activityTimestamps({ ...ctx, tabOpenedAt: bad }, withTs('{tab_opened_at}')),
      (e: unknown) => e instanceof UserError && /start timestamp \{tab_opened_at\} is not available/.test(e.message),
      String(bad),
    )
  }
  assert.throws(() => activityTimestamps({ ...ctx, browserStartedAt: 0 }, withTs('{browser_started_at}', String(T0))), UserError)
  assert.throws(() => activityTimestamps({ ...ctx, tabActiveAt: 0 }, withTs('{tab_active_at}')), UserError)
})

test('timestamps: a given end must resolve and be after start, otherwise a helpful error; blank end is fine', () => {
  const endMsg = 'The end timestamp must be after the start timestamp.'
  // static literals
  assert.throws(() => activityTimestamps(ctx, withTs(String(T0), String(T0))), (e: unknown) => e instanceof UserError && e.message === endMsg)
  assert.throws(() => activityTimestamps(ctx, withTs(String(T0), String(T0 - 1))), (e: unknown) => e instanceof UserError && e.message === endMsg)
  // dynamic anchors: end before / equal to start at runtime
  assert.throws(() => activityTimestamps(ctx, withTs('{tab_active_at}', '{tab_opened_at}')), (e: unknown) => e instanceof UserError && e.message === endMsg)
  assert.throws(() => activityTimestamps(ctx, withTs('{tab_opened_at}', '{tab_opened_at}')), (e: unknown) => e instanceof UserError && e.message === endMsg)
  assert.throws(() => activityTimestamps(ctx, withTs('{tab_opened_at}', String(TAB_AT - 1))), (e: unknown) => e instanceof UserError && e.message === endMsg)
  // unresolved end anchor
  assert.throws(
    () => activityTimestamps({ ...ctx, tabActiveAt: 0 }, withTs(String(T0), '{tab_active_at}')),
    (e: unknown) => e instanceof UserError && /end timestamp \{tab_active_at\} is not available/.test(e.message),
  )
  // optional end left blank still works
  assert.deepEqual(activityTimestamps(ctx, withTs(String(T0), '')), { start: T0 })
  assert.deepEqual(activityTimestamps(ctx, withTs('{tab_opened_at}', '  ')), { start: TAB_AT })
})

test('no timestamps / blank pair -> undefined with no error and no implicit browser/tab default', () => {
  assert.equal(activityTimestamps(ctx), undefined, 'no activity')
  assert.equal(activityTimestamps(ctx, base), undefined, 'activity without timestamps')
  assert.equal(activityTimestamps(ctx, withTs('', '')), undefined)
  assert.equal(activityTimestamps(ctx, withTs('  ', '\t')), undefined)
  assert.equal(activityTimestamp(ctx), undefined)
  assert.equal(activityTimestamp(ctx, base), undefined)
  // real anchors are present but never used unless the template asks for them
  assert.ok(ctx.browserStartedAt > 0 && ctx.tabOpenedAt > 0 && ctx.tabActiveAt > 0)
})

test('end without start throws the exact message (runtime and at normalize time)', () => {
  const msg = 'Set a start timestamp or clear the end timestamp.'
  const is = (e: unknown) => e instanceof UserError && e.message === msg
  assert.throws(() => activityTimestamps(ctx, withTs('', String(T0))), is)
  assert.throws(() => activityTimestamps(ctx, withTs('  ', '{tab_active_at}')), is)
  assert.throws(() => normalizeActivity({ ...base, timestamps: { start: '', end: String(T0) } }), is)
  assert.throws(() => normalizeActivity({ ...base, timestamps: { end: ISO_T0 } }), is)
})

test('populated timestamps are never ignored: invalid content throws', () => {
  assert.throws(() => activityTimestamps(ctx, withTs('garbage')), UserError)
  assert.throws(() => activityTimestamps(ctx, withTs(String(T0), '??')), UserError)
  assert.throws(() => activityTimestamps(ctx, withTs('{tab_title}')), UserError)
  assert.throws(() => activityTimestamps(ctx, withTs('2026-02-30T00:00:00Z')), UserError)
})

test('activityTimestamp is the start of activityTimestamps', () => {
  assert.equal(activityTimestamp(ctx, withTs(String(T0), String(T0 + 1))), T0)
  assert.equal(activityTimestamp(ctx, withTs('{tab_active_at}')), ACTIVE_AT)
  assert.throws(() => activityTimestamp({ ...ctx, tabActiveAt: 0 }, withTs('{tab_active_at}')), UserError)
})

test('normalizeActivity: raw timestamps are validated and preserved verbatim', () => {
  const a = normalizeActivity({ ...base, timestamps: { start: ' {tab_opened_at} ', end: ` ${ISO_T0} ` } })
  assert.deepEqual(a.timestamps, { start: '{tab_opened_at}', end: ISO_T0 })
  assert.deepEqual(normalizeActivity({ ...base, timestamps: { start: String(T0), end: '' } }).timestamps, { start: String(T0), end: '' })
  // rendering never converts them to display text
  assert.deepEqual(renderActivityTemplate(a, ctx, on, NOW).timestamps, { start: '{tab_opened_at}', end: ISO_T0 })
})

test('normalizeActivity: blank pair is allowed and omitted; missing key keeps the old shape', () => {
  assert.equal('timestamps' in normalizeActivity({ ...base, timestamps: { start: '', end: '' } }), false)
  assert.equal('timestamps' in normalizeActivity({ ...base, timestamps: { start: '  ', end: undefined } }), false)
  assert.equal('timestamps' in normalizeActivity(base), false)
})

test('normalizeActivity: rejects unknown expressions, seconds-like/ambiguous/invalid dates', () => {
  const bad = [
    '{tab_title}',
    '{tab_url}',
    '{unknown}',
    '{browser_elapsed}',
    'x{tab_opened_at}',
    '{tab_opened_at} {tab_active_at}',
    '{tab_opened_at}+1',
    '1+1',
    'Date.now()',
    'now',
    '-5',
    '0',
    '1.5',
    '1e12',
    '9007199254740993',
    '99999999999999999999',
    '2026-01-02',
    '2026-01-02T03:04:05',
    '2026-01-02 03:04:05Z',
    '2026-01-02T03:04:05+0700',
    'Jan 2 2026 03:04',
    '2026-02-30T00:00:00Z',
    '2026-13-01T00:00:00Z',
    '2026-04-31T00:00:00Z',
    '2026-01-02T24:00:00Z',
    '2026-01-02T03:60:00Z',
    '2026-01-02T03:04:60Z',
    '2026-01-02T03:04:05+24:00',
    '1969-12-31T00:00:00Z',
    'x'.repeat(129),
  ]
  for (const start of bad) {
    assert.throws(() => normalizeActivity({ ...base, timestamps: { start, end: '' } }), UserError, `start ${start}`)
    assert.throws(() => normalizeActivity({ ...base, timestamps: { start: String(T0), end: start } }), UserError, `end ${start}`)
  }
  assert.throws(() => normalizeActivity({ ...base, timestamps: 'x' }), UserError)
  assert.throws(() => normalizeActivity({ ...base, timestamps: [] }), UserError)
  assert.throws(() => normalizeActivity({ ...base, timestamps: { start: 5 } }), UserError)
  assert.throws(() => normalizeActivity({ ...base, timestamps: { start: '{nope}' } }), /\{browser_started_at\}/)
})

test('normalizeActivity: accepts leap day and calendar-valid dates', () => {
  assert.equal(normalizeActivity({ ...base, timestamps: { start: '2024-02-29T00:00:00Z', end: '' } }).timestamps?.start, '2024-02-29T00:00:00Z')
  assert.throws(() => normalizeActivity({ ...base, timestamps: { start: '2025-02-29T00:00:00Z' } }), UserError)
})

test('normalizeActivity: literal end must be after literal start; dynamic anchors defer to runtime', () => {
  assert.throws(() => normalizeActivity({ ...base, timestamps: { start: String(T0), end: String(T0) } }), UserError)
  assert.throws(() => normalizeActivity({ ...base, timestamps: { start: ISO_T0, end: String(T0 - 1) } }), UserError)
  assert.throws(() => normalizeActivity({ ...base, timestamps: { start: '2020-09-13T19:26:40+07:00', end: ISO_T0 } }), UserError, 'same instant')
  assert.ok(normalizeActivity({ ...base, timestamps: { start: String(T0), end: String(T0 + 1) } }))
  assert.ok(normalizeActivity({ ...base, timestamps: { start: '{tab_opened_at}', end: String(1) } }))
  assert.ok(normalizeActivity({ ...base, timestamps: { start: String(T0), end: '{tab_active_at}' } }))
})

test('TEMPLATE_PARAMETERS lists the timestamp anchors as timestamp-field only', () => {
  for (const key of ['browser_started_at', 'tab_opened_at', 'tab_active_at']) {
    const p = TEMPLATE_PARAMETERS.find((x) => x.key === key)
    assert.ok(p, key)
    assert.match(p.description ?? '', /timestamp fields only/i)
  }
})

// ---- buttons ----------------------------------------------------------------

const btn = (label: string, url: string) => ({ label, url })

test('normalizeActivity: no buttons key when none given (old payload shape kept)', () => {
  assert.equal('buttons' in normalizeActivity(base), false)
  assert.equal('buttons' in normalizeActivity({ ...base, buttons: [] }), false)
  assert.equal('buttons' in normalizeActivity({ ...base, buttons: [btn('', '')] }), false)
})

test('normalizeActivity keeps literal and templated http(s) buttons', () => {
  const a = normalizeActivity({
    ...base,
    buttons: [btn(' Site ', ' https://example.com/x '), btn('Here', '{tab_url}')],
  })
  assert.deepEqual(a.buttons, [btn('Site', 'https://example.com/x'), btn('Here', '{tab_url}')])
  assert.deepEqual(normalizeActivity({ ...base, buttons: [btn('Home', '{tab_origin}/home'), btn('Search', 'https://example.com/?q={tab_title}')] }).buttons?.length, 2)
  assert.equal(normalizeActivity({ ...base, buttons: [btn('A', 'http://example.com')] }).buttons?.length, 1)
})

test('normalizeActivity rejects bad buttons', () => {
  const bad: unknown[] = [
    [btn('a', 'https://a.com'), btn('b', 'https://b.com'), btn('c', 'https://c.com')],
    [btn('x'.repeat(33), 'https://a.com')],
    [btn('a', 'javascript:alert(1)')],
    [btn('a', 'data:text/html,hi')],
    [btn('a', 'ftp://a.com')],
    [btn('a', 'https://user:pw@a.com')],
    [btn('a', 'not a url')],
    [btn('a', 'https://a.com/' + 'x'.repeat(2048))],
    [btn('a', '')],
    [btn('', 'https://a.com')],
    [btn('a', 'javascript:{tab_url}')],
    [btn('a', '{tab_title}')],
    ['nope'],
  ]
  for (const buttons of bad) assert.throws(() => normalizeActivity({ ...base, buttons }), UserError, JSON.stringify(buttons))
  assert.throws(() => normalizeActivity({ ...base, buttons: 'x' }), UserError)
})

test('render: literal valid button survives with URL sharing off', () => {
  const out = render({ buttons: [btn('Docs', 'https://example.com/docs')] })
  assert.deepEqual(out.buttons, [btn('Docs', 'https://example.com/docs')])
})

test('render: {tab_url} button is dropped (not thrown) when sharing is off or url empty', () => {
  assert.equal('buttons' in render({ buttons: [btn('Here', '{tab_url}')] }), false)
  assert.equal('buttons' in render({ buttons: [btn('Here', '{tab_url}')] }, { ...ctx, tabUrl: '' }, on), false)
  assert.deepEqual(render({ buttons: [btn('Here', '{tab_url}'), btn('Docs', 'https://example.com/d')] }).buttons, [btn('Docs', 'https://example.com/d')])
})

test('render: {tab_url} / {tab_origin} build valid buttons', () => {
  assert.deepEqual(render({ buttons: [btn('Here', '{tab_url}')] }, ctx, on).buttons, [btn('Here', 'https://example.com/a/b?q=1#frag')])
  assert.deepEqual(render({ buttons: [btn('Home', '{tab_origin}/home')] }).buttons, [btn('Home', 'https://example.com/home')])
})

test('render: injected values cannot change the URL scheme or host', () => {
  const evil = { ...ctx, tabTitle: 'a b&x=1#h' }
  const out = render({ buttons: [btn('Q', 'https://search.example/?q={tab_title}')] }, evil)
  assert.deepEqual(out.buttons, [btn('Q', 'https://search.example/?q=a%20b%26x%3D1%23h')])
  assert.equal('buttons' in render({ buttons: [btn('X', '{tab_title}')] }, { ...ctx, tabTitle: 'javascript:alert(1)' }), false)
})

test('render: every surviving button URL is http(s) without credentials; max 2', () => {
  const out = render(
    { buttons: [btn('1', 'https://a.com'), btn('2', 'http://b.com'), btn('3', 'https://c.com')] },
    { ...ctx, tabOrigin: 'https://example.com' },
  )
  assert.equal(out.buttons?.length, 2)
  for (const b of out.buttons ?? []) {
    const u = new URL(b.url)
    assert.ok(u.protocol === 'http:' || u.protocol === 'https:')
    assert.equal(u.username + u.password, '')
  }
})

// ---- presence payload -------------------------------------------------------

const presence = (activity: Activity, startTimestamp?: number, endTimestamp?: number) =>
  buildPresence({ activity, clientId: '111111111111111111', sessionId: 's', resolved: new Map(), createdAt: 5, startTimestamp, endTimestamp }).activities[0]

test('buildPresence: buttons are labels with metadata.button_urls in order', () => {
  const entry = presence({ ...base, buttons: [btn('One', 'https://a.com/'), btn('Two', 'http://b.com/x')] })
  assert.deepEqual(entry.buttons, ['One', 'Two'])
  assert.deepEqual(entry.metadata, { button_urls: ['https://a.com/', 'http://b.com/x'] })
})

test('buildPresence: no buttons/metadata/timestamps keys by default (old shape)', () => {
  const entry = presence(base)
  assert.equal('buttons' in entry, false)
  assert.equal('metadata' in entry, false)
  assert.equal('timestamps' in entry, false)
})

test('buildPresence: never emits unsafe or surplus buttons', () => {
  const entry = presence({ ...base, buttons: [btn('x', 'javascript:alert(1)'), btn('a', 'https://a.com'), btn('b', 'https://b.com'), btn('c', 'https://c.com')] })
  assert.deepEqual(entry.buttons, ['a', 'b'])
  assert.deepEqual(entry.metadata, { button_urls: ['https://a.com', 'https://b.com'] })
  assert.equal('buttons' in presence({ ...base, buttons: [btn('x', 'javascript:alert(1)')] }), false)
})

test('buildPresence: timestamps.start only for a finite positive start', () => {
  assert.deepEqual(presence(base, NOW).timestamps, { start: NOW })
  for (const bad of [undefined, 0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal('timestamps' in presence(base, bad), false, String(bad))
  }
})

test('buildPresence: timestamps.end alongside start; invalid/non-increasing end omitted', () => {
  assert.deepEqual(presence(base, NOW, NOW + 1000).timestamps, { start: NOW, end: NOW + 1000 })
  assert.deepEqual(presence(base, NOW, NOW).timestamps, { start: NOW })
  assert.deepEqual(presence(base, NOW, NOW - 1).timestamps, { start: NOW })
  for (const bad of [undefined, 0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.deepEqual(presence(base, NOW, bad).timestamps, { start: NOW }, String(bad))
    assert.equal('timestamps' in presence(base, undefined, bad), false, String(bad))
  }
})

test('buildPresence consumes helper output for custom raw timestamps', () => {
  const ts = activityTimestamps(ctx, withTs(ISO_T0, String(NOW + 1000)))
  assert.deepEqual(presence(base, ts?.start, ts?.end).timestamps, { start: T0, end: NOW + 1000 })
})

test('buildPresence: end without start is allowed when valid', () => {
  assert.deepEqual(presence(base, undefined, NOW).timestamps, { end: NOW })
})

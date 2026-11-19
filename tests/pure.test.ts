import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { buildClearPresence, buildPresence, classifyImage, externalUrls, normalizeActivity } from '../src/lib/activity.ts'
import { ApiError, createClient, resolvePath } from '../src/lib/fetch-client.ts'
import {
  buildAuthorizeUrl,
  checkPending,
  createCodeChallenge,
  createCodeVerifier,
  isExactCallbackLocation,
  parseCallback,
} from '../src/lib/pkce.ts'
import { isExtensionPath, isExtensionPageUrl } from '../src/lib/urls.ts'
import { isSenderAllowed } from '../src/background/sender.ts'
import { mapTokenError, parseTokenResponse } from '../src/lib/discord-api.ts'
import { FatalError, TransientError, UserError } from '../src/lib/errors.ts'

const ID_A = 'a'.repeat(32)
const ID_B = 'b'.repeat(32)
const REDIRECT = `chrome-extension://${ID_A}/callback.html`

// ---- fetch client ----------------------------------------------------------

test('resolvePath accepts relative paths and keeps the base prefix', () => {
  assert.equal(resolvePath('https://discord.com/api/v9/', 'users/@me').href, 'https://discord.com/api/v9/users/@me')
  assert.equal(resolvePath('https://discord.com/api/v9/', '/users/@me?x=1').href, 'https://discord.com/api/v9/users/@me?x=1')
  assert.equal(resolvePath('https://discord.com/api/', 'oauth2/token').href, 'https://discord.com/api/oauth2/token')
})

test('resolvePath rejects absolute, protocol-relative, traversal and odd paths', () => {
  const bad = [
    'https://evil.com/x',
    'http://discord.com/x',
    '//evil.com/x',
    '/\\evil.com',
    'a\\b',
    '../x',
    'a/../../x',
    'a/%2e%2e/x',
    'a/%2E%2E%2Fx',
    'a/./b',
    'javascript:alert(1)',
    'users/@me#frag',
    'users/ @me',
    'users/\n',
    '',
    'a/%zz',
  ]
  for (const path of bad) {
    assert.throws(() => resolvePath('https://discord.com/api/v9/', path), (e: unknown) => e instanceof ApiError && e.kind === 'invalid-path', path)
  }
})

test('client sends form/json/token, no redirect following, credentials omitted', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const client = createClient({
    baseUrl: 'https://discord.com/api/v9/',
    fetch: (async (url: string, init: RequestInit) => {
      calls.push({ url, init })
      return new Response(JSON.stringify({ ok: 1 }), { status: 200 })
    }) as unknown as typeof fetch,
  })
  assert.deepEqual(await client.json('x', { method: 'POST', json: { a: 1 }, token: 'Bearer t' }), { ok: 1 })
  await client.json('y', { method: 'POST', form: { a: 'b' } })
  assert.equal(calls[0].url, 'https://discord.com/api/v9/x')
  const h0 = new Headers(calls[0].init.headers)
  assert.equal(h0.get('authorization'), 'Bearer t')
  assert.equal(h0.get('content-type'), 'application/json')
  assert.equal(calls[0].init.body, '{"a":1}')
  assert.equal(calls[0].init.redirect, 'error')
  assert.equal(calls[0].init.credentials, 'omit')
  assert.ok(calls[1].init.body instanceof URLSearchParams)
  await assert.rejects(client.json('z', { json: {}, form: {} }), (e: unknown) => e instanceof ApiError && e.kind === 'invalid-request')
  await assert.rejects(client.json('https://evil.com'), (e: unknown) => e instanceof ApiError && e.kind === 'invalid-path')
  assert.equal(calls.length, 2, 'invalid path never reaches fetch')
})

test('client errors are sanitized and never leak body, token or secret', async () => {
  const secret = 'SUPERSECRETTOKEN123'
  const client = createClient({
    baseUrl: 'https://discord.com/api/',
    fetch: (async () => new Response(JSON.stringify({ error: secret, error_description: secret, code: 50035 }), { status: 400 })) as unknown as typeof fetch,
  })
  await assert.rejects(client.json('oauth2/token', { method: 'POST', form: { client_secret: secret }, token: `Bearer ${secret}` }), (e: unknown) => {
    assert.ok(e instanceof ApiError)
    assert.equal(e.kind, 'http')
    assert.equal(e.status, 400)
    assert.equal(e.code, '50035', 'arbitrary error strings are dropped, numeric codes kept')
    assert.ok(!String(e.message).includes(secret))
    return true
  })
  const known = createClient({
    baseUrl: 'https://discord.com/api/',
    fetch: (async () => new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 })) as unknown as typeof fetch,
  })
  await assert.rejects(known.json('a'), (e: unknown) => e instanceof ApiError && e.code === 'invalid_grant')
})

test('client timeout covers a stalled body in json() and network failures are typed', async () => {
  const stalled = createClient({
    baseUrl: 'https://discord.com/api/',
    timeoutMs: 30,
    fetch: (async () => ({ ok: true, status: 200, json: () => new Promise(() => {}) }) as unknown as Response) as unknown as typeof fetch,
  })
  await assert.rejects(stalled.json('a'), (e: unknown) => e instanceof ApiError && e.kind === 'timeout')

  const hung = createClient({
    baseUrl: 'https://discord.com/api/',
    timeoutMs: 30,
    fetch: ((_u: string, init: RequestInit) => new Promise((_r, rej) => init.signal?.addEventListener('abort', () => rej(new Error('x'))))) as unknown as typeof fetch,
  })
  await assert.rejects(hung.json('a'), (e: unknown) => e instanceof ApiError && e.kind === 'timeout')

  const controller = new AbortController()
  const abortable = createClient({
    baseUrl: 'https://discord.com/api/',
    fetch: ((_u: string, init: RequestInit) => new Promise((_r, rej) => init.signal?.addEventListener('abort', () => rej(new Error('x'))))) as unknown as typeof fetch,
  })
  const pending = abortable.json('a', { signal: controller.signal })
  controller.abort()
  await assert.rejects(pending, (e: unknown) => e instanceof ApiError && e.kind === 'aborted')

  const down = createClient({ baseUrl: 'https://discord.com/api/', fetch: (async () => { throw new Error('boom token') }) as unknown as typeof fetch })
  await assert.rejects(down.json('a'), (e: unknown) => e instanceof ApiError && e.kind === 'network' && !e.message.includes('token'))

  const badJson = createClient({ baseUrl: 'https://discord.com/api/', fetch: (async () => new Response('not json', { status: 200 })) as unknown as typeof fetch })
  await assert.rejects(badJson.json('a'), (e: unknown) => e instanceof ApiError && e.kind === 'parse')
})

test('client refuses non-https base', () => {
  assert.throws(() => createClient({ baseUrl: 'http://discord.com/api/' }))
})

// ---- URL / callback matching ------------------------------------------------

test('extension URL matching uses protocol+hostname+path, not URL.origin', () => {
  // Document the hazard this guards against: origins of chrome-extension URLs may be 'null'.
  assert.equal(isExactCallbackLocation(REDIRECT, REDIRECT), true)
  assert.equal(isExactCallbackLocation(`${REDIRECT}?code=1&state=2`, REDIRECT), true)
  assert.equal(isExactCallbackLocation(`chrome-extension://${ID_B}/callback.html?code=1`, REDIRECT), false)
  assert.equal(isExactCallbackLocation(`chrome-extension://${ID_A}/other.html`, REDIRECT), false)
  assert.equal(isExactCallbackLocation(`chrome-extension://${ID_A}/callback.html/`, REDIRECT), false)
  assert.equal(isExactCallbackLocation(`chrome-extension://user:pw@${ID_A}/callback.html`, REDIRECT), false)
  assert.equal(isExactCallbackLocation(`https://${ID_A}/callback.html`, REDIRECT), false)
  assert.equal(isExactCallbackLocation(`https://evil.com/callback.html`, REDIRECT), false)
  // A different non-special scheme with an opaque ('null') origin must not match either.
  assert.equal(isExactCallbackLocation(`moz-extension://${ID_A}/callback.html`, REDIRECT), false)
  assert.equal(isExactCallbackLocation('not a url', REDIRECT), false)
  assert.equal(isExactCallbackLocation(REDIRECT, 'also not'), false)
})

test('sender validation: extension pages only; completeAuth only from callback path', () => {
  assert.equal(isSenderAllowed({ id: ID_A, url: `chrome-extension://${ID_A}/src/popup/index.html` }, ID_A, 'getSnapshot'), true)
  assert.equal(isSenderAllowed({ id: ID_A, url: `chrome-extension://${ID_A}/src/popup/index.html` }, ID_A, 'completeAuth'), false)
  assert.equal(isSenderAllowed({ id: ID_A, url: `chrome-extension://${ID_A}/callback.html` }, ID_A, 'completeAuth'), true)
  assert.equal(isSenderAllowed({ id: ID_A, url: `chrome-extension://${ID_A}/callback.html?code=x&state=y` }, ID_A, 'completeAuth'), true)
  assert.equal(isSenderAllowed({ id: ID_A, url: `chrome-extension://${ID_A}/callback.html/x` }, ID_A, 'completeAuth'), false)
  assert.equal(isSenderAllowed({ id: ID_B, url: `chrome-extension://${ID_B}/callback.html` }, ID_A, 'completeAuth'), false)
  assert.equal(isSenderAllowed({ id: ID_A, url: `chrome-extension://${ID_B}/callback.html` }, ID_A, 'completeAuth'), false)
  assert.equal(isSenderAllowed({ id: ID_A, url: 'https://discord.com/' }, ID_A, 'getSnapshot'), false, 'content-script/web sender')
  assert.equal(isSenderAllowed({ url: `chrome-extension://${ID_A}/x.html` }, ID_A, 'getSnapshot'), false)
  assert.equal(isSenderAllowed({ id: ID_A }, ID_A, 'getSnapshot'), false)
  assert.equal(isExtensionPageUrl('chrome-extension://x/y', ''), false)
  assert.equal(isExtensionPath(`chrome-extension://${ID_A}/callback.html`, ID_A, '/callback.html'), true)
})

// ---- PKCE / state ------------------------------------------------------------

test('PKCE verifier is 32 random bytes base64url and challenge is SHA256 base64url', async () => {
  const v1 = createCodeVerifier()
  const v2 = createCodeVerifier()
  assert.match(v1, /^[A-Za-z0-9_-]{43}$/)
  assert.notEqual(v1, v2)
  assert.equal(await createCodeChallenge(v1), createHash('sha256').update(v1, 'utf8').digest('base64url'))
  // RFC 7636 appendix B vector
  assert.equal(await createCodeChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'), 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM')
})

test('authorize URL carries scope, S256 challenge, state and exact redirect', () => {
  const url = new URL(buildAuthorizeUrl({ clientId: '123456789012345678', redirectUri: REDIRECT, state: 'st', codeChallenge: 'ch' }))
  assert.equal(url.origin + url.pathname, 'https://discord.com/oauth2/authorize')
  assert.equal(url.searchParams.get('client_id'), '123456789012345678')
  assert.equal(url.searchParams.get('redirect_uri'), REDIRECT)
  assert.equal(url.searchParams.get('response_type'), 'code')
  assert.equal(url.searchParams.get('scope'), 'openid sdk.social_layer_presence')
  assert.equal(url.searchParams.get('code_challenge'), 'ch')
  assert.equal(url.searchParams.get('code_method'), 'S256')
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256')
  assert.equal(url.searchParams.get('state'), 'st')
  assert.equal(url.searchParams.has('client_secret'), false)
})

test('parseCallback validates location and extracts code/state/errors', () => {
  assert.deepEqual(parseCallback(`${REDIRECT}?code=c&state=s`, REDIRECT), { kind: 'code', code: 'c', state: 's' })
  assert.throws(() => parseCallback(`chrome-extension://${ID_B}/callback.html?code=c&state=s`, REDIRECT), UserError)
  assert.throws(() => parseCallback(`${REDIRECT}?code=c`, REDIRECT), /state/)
  assert.throws(() => parseCallback(`${REDIRECT}?state=s`, REDIRECT), /code/)
  assert.throws(() => parseCallback('nope', REDIRECT), UserError)
  const err = parseCallback(`${REDIRECT}?error=access_denied&error_description=No%0Away&state=s`, REDIRECT)
  assert.deepEqual(err, { kind: 'error', error: 'access_denied', description: 'No way', state: 's' })
})

test('checkPending: none, expired, mismatch, client change, ok', () => {
  const pending = { state: 's', verifier: 'v', clientId: '1', redirectUri: REDIRECT, createdAt: 0, expiresAt: 100 }
  assert.deepEqual(checkPending(null, 's', '1', 0), { ok: false, reason: 'none' })
  assert.deepEqual(checkPending(pending, 's', '1', 101), { ok: false, reason: 'expired' })
  assert.deepEqual(checkPending(pending, 'x', '1', 50), { ok: false, reason: 'state-mismatch' })
  assert.deepEqual(checkPending(pending, null, '1', 50), { ok: false, reason: 'state-mismatch' })
  assert.deepEqual(checkPending(pending, 's', '2', 50), { ok: false, reason: 'client-changed' })
  assert.deepEqual(checkPending(pending, 's', '1', 100), { ok: true })
})

// ---- token parsing / error mapping -------------------------------------------

test('token response parsing keeps previous refresh token when not rotated', () => {
  const t = parseTokenResponse({ access_token: 'a', token_type: 'Bearer', expires_in: 100, refresh_token: 'r2', scope: 'openid' }, 1000, 'r1')
  assert.deepEqual(t, { accessToken: 'a', refreshToken: 'r2', expiresAt: 101_000, scope: 'openid' })
  assert.equal(parseTokenResponse({ access_token: 'a' }, 0, 'r1').refreshToken, 'r1')
  assert.throws(() => parseTokenResponse({}, 0, null), TransientError)
  assert.throws(() => parseTokenResponse({ access_token: 'a', token_type: 'mac' }, 0, null), UserError)
})

test('token error mapping: public-client hint, transient, fatal refresh', () => {
  const invalidClient = new ApiError('http', 'x', 401, 'invalid_client')
  assert.match(mapTokenError(invalidClient, 'exchange').message, /Public Client/)
  assert.ok(mapTokenError(invalidClient, 'exchange') instanceof UserError)
  assert.ok(mapTokenError(invalidClient, 'refresh') instanceof FatalError)
  assert.ok(mapTokenError(new ApiError('http', 'x', 429), 'refresh') instanceof TransientError)
  assert.ok(mapTokenError(new ApiError('http', 'x', 503), 'refresh') instanceof TransientError)
  const grant = mapTokenError(new ApiError('http', 'x', 400, 'invalid_grant'), 'refresh')
  assert.ok(grant instanceof FatalError && grant.clearCredentials)
  assert.ok(mapTokenError(new ApiError('network', 'x'), 'refresh') instanceof TransientError)
  assert.ok(mapTokenError(new ApiError('network', 'x'), 'exchange') instanceof UserError)
})

// ---- activity ----------------------------------------------------------------

const baseActivity = { name: 'Game', type: 0 as const, details: 'd', state: 's', largeImage: '', largeText: '', smallImage: '', smallText: '' }

test('normalizeActivity validates and trims', () => {
  assert.equal(normalizeActivity({ ...baseActivity, name: '  Game  ' }).name, 'Game')
  assert.throws(() => normalizeActivity({ ...baseActivity, name: '' }), UserError)
  assert.throws(() => normalizeActivity({ ...baseActivity, type: 4 }), UserError)
  assert.throws(() => normalizeActivity({ ...baseActivity, type: 1 }), UserError)
  assert.throws(() => normalizeActivity({ ...baseActivity, details: 'x'.repeat(129) }), UserError)
  assert.throws(() => normalizeActivity({ ...baseActivity, largeImage: 'http://x.com/a.png' }), UserError)
  assert.throws(() => normalizeActivity({ ...baseActivity, largeImage: 'ftp:foo' }), UserError)
  assert.throws(() => normalizeActivity(null), UserError)
})

test('image classification: keys pass through, CDN proxied, other https external', () => {
  assert.deepEqual(classifyImage(''), { kind: 'none' })
  assert.deepEqual(classifyImage('my_asset'), { kind: 'asset', value: 'my_asset' })
  assert.deepEqual(classifyImage('373370493127884800'), { kind: 'asset', value: '373370493127884800' })
  assert.deepEqual(classifyImage('mp:external/abc/x.png'), { kind: 'asset', value: 'mp:external/abc/x.png' })
  assert.deepEqual(classifyImage('spotify:abc'), { kind: 'asset', value: 'spotify:abc' })
  assert.deepEqual(classifyImage('external/abc/x.png'), { kind: 'asset', value: 'mp:external/abc/x.png' })
  assert.deepEqual(classifyImage('https://cdn.discordapp.com/attachments/1/2/a.png'), { kind: 'asset', value: 'mp:attachments/1/2/a.png' })
  assert.deepEqual(classifyImage('https://assets.ppy.sh/a.jpg'), { kind: 'external', url: 'https://assets.ppy.sh/a.jpg' })
  assert.throws(() => classifyImage('https://u:p@x.com/a.png'), UserError)
})

test('presence payload shape (op 3) with application_id, session_id and assets', () => {
  const activity = normalizeActivity({
    ...baseActivity,
    largeImage: 'https://assets.ppy.sh/a.jpg',
    largeText: 'LT',
    smallImage: 'key',
    smallText: 'ST',
  })
  assert.deepEqual(externalUrls(activity), ['https://assets.ppy.sh/a.jpg'])
  const resolved = new Map([['https://assets.ppy.sh/a.jpg', 'mp:external/h/a.jpg']])
  assert.deepEqual(buildPresence({ activity, clientId: '111111111111111111', sessionId: 'sess', resolved, createdAt: 5 }), {
    activities: [
      {
        application_id: '111111111111111111',
        name: 'Game',
        type: 0,
        session_id: 'sess',
        platform: 'desktop',
        created_at: 5,
        state: 's',
        details: 'd',
        assets: { large_image: 'mp:external/h/a.jpg', large_text: 'LT', small_image: 'key', small_text: 'ST' },
      },
    ],
    afk: false,
    since: 0,
    status: 'online',
  })
  assert.throws(() => buildPresence({ activity, clientId: '1', sessionId: 's', resolved: new Map(), createdAt: 0 }), UserError)
  assert.deepEqual(buildClearPresence(), { activities: [], afk: false, since: 0, status: 'online' })
  const minimal = buildPresence({ activity: normalizeActivity({ ...baseActivity, details: '', state: '' }), clientId: '1', sessionId: 's', resolved: new Map(), createdAt: 0 })
  assert.equal('assets' in minimal.activities[0], false)
  assert.equal('state' in minimal.activities[0], false)
})

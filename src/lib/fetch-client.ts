/**
 * Minimal fetch client that takes a *path* (never a full URL) and resolves it
 * against a fixed base. Written from scratch; it is intentionally not the
 * reference repo's request client.
 *
 * Safety properties:
 *  - Only relative paths are accepted. Absolute URLs, protocol-relative
 *    (`//host`), backslashes, `..` segments (also percent-encoded), control
 *    characters and fragments are rejected, and the resolved URL must keep the
 *    base origin and path prefix. This prevents bearer tokens leaking to
 *    another host.
 *  - Redirects are never followed (`redirect: 'error'`).
 *  - Errors are typed and sanitized: they never contain request/response
 *    bodies, headers, tokens or secrets.
 */

export type ApiErrorKind =
  | 'invalid-path'
  | 'invalid-request'
  | 'network'
  | 'timeout'
  | 'aborted'
  | 'http'
  | 'parse'

export class ApiError extends Error {
  readonly kind: ApiErrorKind
  readonly status: number | null
  /** Sanitized provider error code (e.g. `invalid_grant`), if any. */
  readonly code: string | null

  constructor(
    kind: ApiErrorKind,
    message: string,
    status: number | null = null,
    code: string | null = null,
  ) {
    super(message)
    this.name = 'ApiError'
    this.kind = kind
    this.status = status
    this.code = code
  }
}

export interface ClientInit extends Omit<RequestInit, 'body' | 'redirect' | 'credentials'> {
  /** Raw body (string, URLSearchParams, FormData, Blob, ...). */
  body?: BodyInit | null
  /** JSON body; sets `Content-Type: application/json`. */
  json?: unknown
  /** `application/x-www-form-urlencoded` body. */
  form?: Record<string, string>
  /** Sent as `Authorization: <token>`; value must be the complete header value. */
  token?: string
  /** Per-request timeout in ms (default: client timeout). */
  timeoutMs?: number
}

export interface ClientOptions {
  /** Absolute base URL. A trailing slash is enforced. */
  baseUrl: string
  fetch?: typeof fetch
  timeoutMs?: number
}

export interface FetchClient {
  readonly baseUrl: string
  resolve(path: string): URL
  request(path: string, init?: ClientInit): Promise<Response>
  json<T>(path: string, init?: ClientInit): Promise<T>
}

const SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:/
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f\s]/

function pathError(message: string): ApiError {
  return new ApiError('invalid-path', message)
}

/**
 * Validates `path` and resolves it against `baseUrl`. Throws ApiError
 * (`invalid-path`) if the result could leave the base origin/prefix.
 */
export function resolvePath(baseUrl: string, path: string): URL {
  if (typeof path !== 'string' || path.length === 0) throw pathError('Request path must be a non-empty string.')
  if (CONTROL_RE.test(path)) throw pathError('Request path contains forbidden characters.')
  if (path.includes('\\')) throw pathError('Request path must not contain backslashes.')
  if (path.includes('#')) throw pathError('Request path must not contain a fragment.')
  if (path.startsWith('//')) throw pathError('Protocol-relative paths are not allowed.')
  if (SCHEME_RE.test(path)) throw pathError('Absolute URLs are not allowed; pass a path.')

  const relative = path.startsWith('/') ? path.slice(1) : path
  const [pathname] = relative.split('?', 1)
  for (const segment of pathname.split('/')) {
    let decoded: string
    try {
      decoded = decodeURIComponent(segment)
    } catch {
      throw pathError('Request path is not valid percent-encoding.')
    }
    if (decoded === '.' || decoded === '..' || decoded.includes('/') || decoded.includes('\\')) {
      throw pathError('Path traversal is not allowed.')
    }
  }

  const base = new URL(baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`)
  const url = new URL(relative, base)
  if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname) || url.hash) {
    throw pathError('Resolved URL escapes the API base.')
  }
  return url
}

const ERROR_CODE_ALLOWLIST: ReadonlySet<string> = new Set([
  'invalid_request',
  'invalid_client',
  'invalid_grant',
  'invalid_scope',
  'unauthorized_client',
  'unsupported_grant_type',
  'access_denied',
  'server_error',
  'temporarily_unavailable',
])

/** Only well-known OAuth error names and small numeric API codes are surfaced. */
function sanitizeCode(value: unknown): string | null {
  if (typeof value === 'string' && ERROR_CODE_ALLOWLIST.has(value)) return value
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 999_999) return String(value)
  return null
}

function errorCodeFrom(data: unknown): string | null {
  if (typeof data !== 'object' || data === null) return null
  const record = data as Record<string, unknown>
  return sanitizeCode(record.error) ?? sanitizeCode(record.code)
}

type Mode = 'response' | 'json'

export function createClient(options: ClientOptions): FetchClient {
  const baseUrl = options.baseUrl.endsWith('/') ? options.baseUrl : `${options.baseUrl}/`
  const defaultTimeout = options.timeoutMs ?? 15_000
  if (new URL(baseUrl).protocol !== 'https:') throw new Error('Client base URL must be https.')

  function resolve(path: string): URL {
    return resolvePath(baseUrl, path)
  }

  /**
   * Runs one request. The timeout/abort covers the whole exchange. In `json`
   * mode that includes reading and parsing the body, so a stalled body cannot
   * hang the caller. In `response` mode only the headers are bounded (the
   * timer is cleared once the Response is returned); the background worker only
   * uses the bounded `json()` entry point.
   */
  async function perform(path: string, init: ClientInit, mode: Mode): Promise<unknown> {
    const url = resolve(path)
    const { json, form, token, timeoutMs, body, signal, headers, ...rest } = init
    if ([json !== undefined, form !== undefined, body !== undefined && body !== null].filter(Boolean).length > 1) {
      throw new ApiError('invalid-request', 'Provide only one of body, json or form.')
    }

    const finalHeaders = new Headers(headers)
    let finalBody: BodyInit | null | undefined = body
    if (json !== undefined) {
      finalBody = JSON.stringify(json)
      finalHeaders.set('Content-Type', 'application/json')
    } else if (form !== undefined) {
      finalBody = new URLSearchParams(form)
    }
    if (token !== undefined) finalHeaders.set('Authorization', token)

    const controller = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, timeoutMs ?? defaultTimeout)
    const onAbort = () => controller.abort()
    if (signal) {
      if (signal.aborted) controller.abort()
      else signal.addEventListener('abort', onAbort, { once: true })
    }
    const cleanup = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
    const interrupted = (): ApiError =>
      timedOut
        ? new ApiError('timeout', 'The request timed out.')
        : signal?.aborted
          ? new ApiError('aborted', 'The request was cancelled.')
          : new ApiError('network', 'Network request failed.')

    // Rejects as soon as the signal aborts, even if the underlying fetch/body
    // promise never settles (e.g. a mocked or stalled stream).
    const abortable = <T>(work: Promise<T>): Promise<T> =>
      new Promise<T>((resolvePromise, reject) => {
        const fail = () => reject(interrupted())
        if (controller.signal.aborted) return fail()
        controller.signal.addEventListener('abort', fail, { once: true })
        work.then(
          (value) => {
            controller.signal.removeEventListener('abort', fail)
            resolvePromise(value)
          },
          (error: unknown) => {
            controller.signal.removeEventListener('abort', fail)
            reject(error instanceof ApiError ? error : interrupted())
          },
        )
      })

    const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis)
    let keepOpen = false
    try {
      const response = await abortable(
        doFetch(url.toString(), {
          ...rest,
          headers: finalHeaders,
          body: finalBody,
          redirect: 'error',
          credentials: 'omit',
          signal: controller.signal,
        }),
      )

      if (!response.ok) {
        let code: string | null = null
        try {
          code = errorCodeFrom(await abortable(response.json()))
        } catch (error) {
          if (error instanceof ApiError && (error.kind === 'timeout' || error.kind === 'aborted')) throw error
        }
        throw new ApiError(
          'http',
          code ? `Request failed (HTTP ${response.status}, ${code}).` : `Request failed (HTTP ${response.status}).`,
          response.status,
          code,
        )
      }
      if (mode === 'response') {
        keepOpen = true
        return response
      }
      try {
        return await abortable(response.json())
      } catch (error) {
        if (error instanceof ApiError && (error.kind === 'timeout' || error.kind === 'aborted')) throw error
        throw new ApiError('parse', 'The server returned an invalid response.', response.status)
      }
    } finally {
      cleanup()
      // Release a stalled body/connection if we bailed out early.
      if (!keepOpen && !controller.signal.aborted) controller.abort()
    }
  }

  return {
    baseUrl,
    resolve,
    request: (path, init = {}) => perform(path, init, 'response') as Promise<Response>,
    json: <T>(path: string, init: ClientInit = {}) => perform(path, init, 'json') as Promise<T>,
  }
}

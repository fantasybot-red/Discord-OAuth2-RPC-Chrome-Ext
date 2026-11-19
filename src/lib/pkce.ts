import { AUTHORIZE_URL, OAUTH_SCOPE } from './constants.ts'
import { UserError } from './errors.ts'
import { isSameLocationString } from './urls.ts'

export function base64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** Random 32-byte verifier, base64url (43 chars), as in the reference. */
export function createCodeVerifier(): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(32)))
}

export async function createCodeChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  return base64Url(new Uint8Array(digest))
}

export function createState(): string {
  return crypto.randomUUID()
}

export interface AuthorizeParams {
  clientId: string
  redirectUri: string
  state: string
  codeChallenge: string
}

export function buildAuthorizeUrl(params: AuthorizeParams): string {
  const url = new URL(AUTHORIZE_URL)
  url.searchParams.set('client_id', params.clientId)
  url.searchParams.set('redirect_uri', params.redirectUri)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('scope', OAUTH_SCOPE)
  url.searchParams.set('code_challenge', params.codeChallenge)
  // Reference uses the non-standard `code_method`; send the standard name too.
  url.searchParams.set('code_method', 'S256')
  url.searchParams.set('code_challenge_method', 'S256')
  url.searchParams.set('state', params.state)
  return url.toString()
}

export interface PendingAuth {
  state: string
  verifier: string
  clientId: string
  redirectUri: string
  createdAt: number
  expiresAt: number
}

export type CallbackResult =
  | { kind: 'code'; code: string; state: string }
  | { kind: 'error'; error: string; description: string; state: string | null }

export function isExactCallbackLocation(candidate: string, redirectUri: string): boolean {
  return isSameLocationString(candidate, redirectUri)
}

function clean(value: string, max: number): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max)
}

/**
 * Parses the URL the provider redirected to. The location must exactly match
 * the redirect URI (origin + path).
 */
export function parseCallback(callbackUrl: string, redirectUri: string): CallbackResult {
  let url: URL
  try {
    url = new URL(callbackUrl)
  } catch {
    throw new UserError('The callback URL is not valid.')
  }
  if (!isExactCallbackLocation(callbackUrl, redirectUri)) {
    throw new UserError('The callback URL does not match the extension redirect URI.')
  }
  const params = url.searchParams
  const state = params.get('state')
  const error = params.get('error')
  if (error) {
    return {
      kind: 'error',
      error: clean(error, 64),
      description: clean(params.get('error_description') ?? '', 200),
      state,
    }
  }
  const code = params.get('code')
  if (!state) throw new UserError('The callback is missing the state parameter.')
  if (!code) throw new UserError('The callback is missing the authorization code.')
  return { kind: 'code', code, state }
}

export type PendingCheck =
  | { ok: true }
  | { ok: false; reason: 'none' | 'expired' | 'state-mismatch' | 'client-changed' }

/** Pure validation of a pending auth against an incoming callback state. */
export function checkPending(
  pending: PendingAuth | null,
  state: string | null,
  clientId: string,
  now: number,
): PendingCheck {
  if (!pending) return { ok: false, reason: 'none' }
  if (now > pending.expiresAt) return { ok: false, reason: 'expired' }
  if (state === null || state !== pending.state) return { ok: false, reason: 'state-mismatch' }
  if (pending.clientId !== clientId) return { ok: false, reason: 'client-changed' }
  return { ok: true }
}


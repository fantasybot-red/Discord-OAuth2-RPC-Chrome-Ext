import { API_BASE_URL, OAUTH_BASE_URL } from './constants.ts'
import { externalAssetValue } from './activity.ts'
import { FatalError, SupersededError, TransientError, UserError } from './errors.ts'
import { ApiError, createClient } from './fetch-client.ts'

export interface TokenSet {
  accessToken: string
  refreshToken: string | null
  expiresAt: number
  scope: string
}

export interface DiscordUser {
  id: string
  username: string
  avatar: string | null
}

const SNOWFLAKE_RE = /^\d{17,20}$/

export function isSnowflake(value: string): boolean {
  return SNOWFLAKE_RE.test(value)
}

/** The gateway and REST API both need the complete header value. */
export function bearer(accessToken: string): string {
  return `Bearer ${accessToken}`
}

export function parseTokenResponse(data: unknown, now: number, previousRefresh: string | null): TokenSet {
  if (typeof data !== 'object' || data === null) throw new TransientError('Discord returned an invalid token response.')
  const r = data as Record<string, unknown>
  if (typeof r.access_token !== 'string' || !r.access_token) {
    throw new TransientError('Discord returned an invalid token response.')
  }
  if (typeof r.token_type === 'string' && r.token_type.toLowerCase() !== 'bearer') {
    throw new UserError('Discord returned an unsupported token type.')
  }
  const expiresIn = typeof r.expires_in === 'number' && r.expires_in > 0 ? r.expires_in : 3600
  return {
    accessToken: r.access_token,
    refreshToken: typeof r.refresh_token === 'string' && r.refresh_token ? r.refresh_token : previousRefresh,
    expiresAt: now + expiresIn * 1000,
    scope: typeof r.scope === 'string' ? r.scope : '',
  }
}

const PUBLIC_CLIENT_HINT =
  'Discord rejected the application. Make sure the application ID is correct, the app is a Public Client and the Social SDK is enabled.'

/** Maps token endpoint failures to errors with user-safe messages. */
export function mapTokenError(error: unknown, kind: 'exchange' | 'refresh'): Error {
  if (error instanceof SupersededError || error instanceof UserError || error instanceof FatalError) return error
  if (error instanceof TransientError) return error
  if (!(error instanceof ApiError)) return new TransientError('Unexpected error while contacting Discord.')
  if (error.kind === 'aborted') return new SupersededError()
  if (error.kind === 'timeout' || error.kind === 'network' || error.kind === 'parse') {
    return kind === 'exchange'
      ? new UserError('Could not reach Discord to finish signing in. Try again.')
      : new TransientError('Could not reach Discord to refresh the session.')
  }
  if (error.kind === 'http') {
    if (error.code === 'invalid_client' || error.code === 'unauthorized_client') {
      return kind === 'exchange' ? new UserError(PUBLIC_CLIENT_HINT) : new FatalError(PUBLIC_CLIENT_HINT, false)
    }
    const status = error.status ?? 0
    if (status === 429 || status >= 500) return new TransientError(`Discord is unavailable (HTTP ${status}).`)
    if (kind === 'exchange') {
      return new UserError(
        error.code === 'invalid_grant'
          ? 'Discord rejected the authorization code (expired or already used). Start authorization again.'
          : `Discord rejected the sign-in request (HTTP ${status}).`,
      )
    }
    return new FatalError('Your Discord session expired. Authorize again.', true)
  }
  return new UserError('Unexpected error while contacting Discord.')
}

function mapRestError(error: unknown, what: string): Error {
  if (error instanceof SupersededError || error instanceof UserError) return error
  if (error instanceof ApiError) {
    if (error.kind === 'aborted') return new SupersededError()
    if (error.kind === 'http') return new UserError(`Discord rejected the ${what} request (HTTP ${error.status ?? 0}).`)
    return new TransientError(`Could not reach Discord for the ${what} request.`)
  }
  return new TransientError(`Unexpected error during the ${what} request.`)
}

export interface DiscordApiOptions {
  fetch?: typeof fetch
  now: () => number
}

export interface DiscordApi {
  exchangeCode(input: {
    clientId: string
    /** Optional. Public clients (the documented mode) send none. */
    clientSecret?: string
    code: string
    verifier: string
    redirectUri: string
    signal: AbortSignal
  }): Promise<TokenSet>
  refresh(input: {
    clientId: string
    clientSecret?: string
    refreshToken: string
    accessToken: string | null
    signal: AbortSignal
  }): Promise<TokenSet>
  getUser(accessToken: string, signal: AbortSignal): Promise<DiscordUser>
  resolveExternalAssets(input: {
    clientId: string
    accessToken: string
    urls: string[]
    signal: AbortSignal
  }): Promise<Map<string, string>>
}

export function createDiscordApi(options: DiscordApiOptions): DiscordApi {
  const rest = createClient({ baseUrl: API_BASE_URL, fetch: options.fetch })
  // https://discord.com/api/oauth2/token (no version segment)
  const oauth = createClient({ baseUrl: OAUTH_BASE_URL, fetch: options.fetch })

  return {
    async exchangeCode({ clientId, clientSecret, code, verifier, redirectUri, signal }) {
      try {
        const data = await oauth.json<unknown>('oauth2/token', {
          method: 'POST',
          form: {
            client_id: clientId,
            grant_type: 'authorization_code',
            code,
            code_verifier: verifier,
            redirect_uri: redirectUri,
            ...(clientSecret ? { client_secret: clientSecret } : {}),
          },
          signal,
        })
        return parseTokenResponse(data, options.now(), null)
      } catch (error) {
        throw mapTokenError(error, 'exchange')
      }
    },

    async refresh({ clientId, clientSecret, refreshToken, accessToken, signal }) {
      try {
        const data = await oauth.json<unknown>('oauth2/token', {
          method: 'POST',
          form: {
            client_id: clientId,
            grant_type: 'refresh_token',
            refresh_token: refreshToken,
            ...(clientSecret ? { client_secret: clientSecret } : {}),
          },
          // The reference implementation sends the previous token on refresh.
          token: accessToken ? bearer(accessToken) : undefined,
          signal,
        })
        return parseTokenResponse(data, options.now(), refreshToken)
      } catch (error) {
        throw mapTokenError(error, 'refresh')
      }
    },

    async getUser(accessToken, signal) {
      try {
        const data = await rest.json<unknown>('users/@me', { token: bearer(accessToken), signal })
        const r = (typeof data === 'object' && data !== null ? data : {}) as Record<string, unknown>
        if (typeof r.id !== 'string' || typeof r.username !== 'string') {
          throw new TransientError('Discord returned an invalid profile.')
        }
        return { id: r.id, username: r.username, avatar: typeof r.avatar === 'string' ? r.avatar : null }
      } catch (error) {
        throw mapRestError(error, 'profile')
      }
    },

    async resolveExternalAssets({ clientId, accessToken, urls, signal }) {
      if (!isSnowflake(clientId)) throw new UserError('The application ID is invalid.')
      try {
        const data = await rest.json<unknown>(`applications/${clientId}/external-assets`, {
          method: 'POST',
          json: { urls },
          token: bearer(accessToken),
          signal,
        })
        if (!Array.isArray(data)) throw new TransientError('Discord returned an invalid asset response.')
        const entries = data.filter(
          (e): e is { url?: unknown; external_asset_path: string } =>
            typeof e === 'object' && e !== null && typeof (e as Record<string, unknown>).external_asset_path === 'string',
        )
        const result = new Map<string, string>()
        urls.forEach((url, index) => {
          const match = entries.find((e) => e.url === url) ?? (entries.length === urls.length ? entries[index] : undefined)
          if (match) result.set(url, externalAssetValue(match.external_asset_path))
        })
        for (const url of urls) {
          if (!result.has(url)) throw new UserError('Discord did not accept one of the external image URLs.')
        }
        return result
      } catch (error) {
        throw mapRestError(error, 'image upload')
      }
    },
  }
}

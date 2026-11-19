/** Origin + path prefixes used for outbound HTTP. */
export const DISCORD_ORIGIN = 'https://discord.com'
/** REST base (trailing slash required for relative resolution). */
export const API_BASE_URL = 'https://discord.com/api/v9/'
/** Base for the OAuth2 token endpoint (https://discord.com/api/oauth2/token). */
export const OAUTH_BASE_URL = 'https://discord.com/api/'

/** Social SDK gateway (NOT gateway.discord.gg). */
export const GATEWAY_URL = 'wss://gateway.gaming-sdk.com/?v=9&encoding=json'

/** Public OAuth client + Social SDK presence scope. */
export const OAUTH_SCOPE = 'openid sdk.social_layer_presence'
export const AUTHORIZE_URL = 'https://discord.com/oauth2/authorize'

export const REQUEST_TIMEOUT_MS = 15_000

export const GatewayOp = {
  DISPATCH: 0,
  HEARTBEAT: 1,
  IDENTIFY: 2,
  PRESENCE_UPDATE: 3,
  RECONNECT: 7,
  INVALID_SESSION: 9,
  HELLO: 10,
  HEARTBEAT_ACK: 11,
} as const

/** Reference Constants.ts DEFAULT_SUPER_PROPERTIES. */
export const SUPER_PROPERTIES = {
  browser: 'Discord Embedded',
  browser_user_agent: 'Discord Embedded/1.9.15780',
  browser_version: '1.9.15780',
  client_build_number: 15780,
  client_version: '1.9.15780',
  design_id: 0,
  device: 'console',
  native_build_number: 15780,
  os: 'Android',
  release_channel: 'unknown',
} as const

/**
 * Default IDENTIFY intents from reference Gateway.ts (used when the caller
 * passes no explicit intents): DIRECT_MESSAGES, PRIVATE_CHANNELS, CALLS,
 * USER_RELATIONSHIPS, USER_PRESENCE, LOBBIES, LOBBY_DELETE, UNKNOWN_29.
 */
export const IDENTIFY_INTENTS =
  (1 << 12) |
  (1 << 18) |
  (1 << 19) |
  (1 << 22) |
  (1 << 23) |
  (1 << 27) |
  (1 << 28) |
  (1 << 29)

/** Close codes after which retrying with the same token is pointless. */
export const FATAL_CLOSE_CODES: ReadonlySet<number> = new Set([
  4004, 4010, 4011, 4012, 4013, 4014,
])

/**
 * Chrome 116+ resets the service worker idle timer on WebSocket traffic, and
 * the idle limit is 30s, so protocol heartbeats are sent at least every 20s.
 */
export const MAX_HEARTBEAT_INTERVAL_MS = 20_000
export const HELLO_TIMEOUT_MS = 20_000
export const READY_TIMEOUT_MS = 30_000
export const ACK_TIMEOUT_MS = 10_000

export const AUTH_STATE_TTL_MS = 10 * 60 * 1000
export const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000

export const RECONNECT_BASE_MS = 1_000
export const RECONNECT_MAX_MS = 60_000

export const ALARM_RECOVER = 'rpc-recover'
export const ALARM_REFRESH = 'rpc-token-refresh'
/** chrome.alarms minimum period is 30s since Chrome 120. */
export const RECOVER_PERIOD_MINUTES = 0.5

export const MAX_FIELD_LENGTH = 128

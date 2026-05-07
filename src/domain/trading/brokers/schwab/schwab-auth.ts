/**
 * Schwab OAuth 2.0 flow.
 *
 * Schwab uses the authorization-code grant with client_secret_basic. The
 * one-time dance is:
 *
 *   1. buildAuthorizationUrl() → user opens in browser, logs in, authorizes
 *   2. Schwab redirects to redirect_uri with ?code=... (and a session param)
 *   3. exchangeCodeForToken(code) → access + refresh tokens
 *   4. Access token lives 30 minutes; refresh token lives 7 days
 *   5. refreshAccessToken() on every init() and before expiry
 *
 * NB: the 7-day refresh-token lifespan means OpenAlice has to actually use
 * the account at least weekly or the config breaks and the user has to
 * redo the browser dance. We rotate the refresh_token on every refresh so
 * each successful use resets the clock.
 */

import { SchwabTokenResponseSchema, type SchwabTokenResponse } from './schwab-types.js'

export const SCHWAB_AUTH_URL = 'https://api.schwabapi.com/v1/oauth/authorize'
export const SCHWAB_TOKEN_URL = 'https://api.schwabapi.com/v1/oauth/token'

export interface SchwabTokens {
  accessToken: string
  refreshToken: string
  /** Absolute expiry time (ms since epoch). */
  expiresAt: number
}

export interface TokenStore {
  /** Called whenever a refresh lands so the config file can be rewritten. */
  onTokensRefreshed(tokens: SchwabTokens): Promise<void>
}

/** Build the browser URL that kicks off the auth dance. */
export function buildAuthorizationUrl(params: {
  clientId: string
  redirectUri: string
  state?: string
}): string {
  const u = new URL(SCHWAB_AUTH_URL)
  u.searchParams.set('client_id', params.clientId)
  u.searchParams.set('redirect_uri', params.redirectUri)
  u.searchParams.set('response_type', 'code')
  if (params.state) u.searchParams.set('state', params.state)
  return u.toString()
}

/**
 * Extract the `code` param from the URL the user copied back from their browser.
 * Accepts the raw URL or just the query string — whatever's easiest to paste.
 */
export function extractAuthorizationCode(input: string): string | null {
  let search: string
  try {
    search = new URL(input).search
  } catch {
    search = input.startsWith('?') ? input : `?${input}`
  }
  const params = new URLSearchParams(search)
  const code = params.get('code')
  return code && code.length > 0 ? code : null
}

function basicAuthHeader(clientId: string, clientSecret: string): string {
  return `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`
}

function tokensFromResponse(res: SchwabTokenResponse): SchwabTokens {
  // Apply 30s safety margin — we'll refresh before the server would reject.
  const expiresAt = Date.now() + Math.max(0, (res.expires_in - 30)) * 1000
  return {
    accessToken: res.access_token,
    refreshToken: res.refresh_token,
    expiresAt,
  }
}

/** Exchange the browser-captured ?code=... for the first refresh + access token pair. */
export async function exchangeCodeForToken(params: {
  clientId: string
  clientSecret: string
  redirectUri: string
  code: string
  fetchImpl?: typeof fetch
}): Promise<SchwabTokens> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: params.code,
    redirect_uri: params.redirectUri,
  })
  const fetchFn = params.fetchImpl ?? fetch
  const resp = await fetchFn(SCHWAB_TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: basicAuthHeader(params.clientId, params.clientSecret),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  })
  if (!resp.ok) {
    const text = await resp.text()
    throw new Error(`Schwab token exchange failed (${resp.status}): ${text}`)
  }
  const json = SchwabTokenResponseSchema.parse(await resp.json())
  return tokensFromResponse(json)
}

/** Exchange a refresh token for a new access + refresh pair. */
export async function refreshAccessToken(params: {
  clientId: string
  clientSecret: string
  refreshToken: string
  fetchImpl?: typeof fetch
}): Promise<SchwabTokens> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: params.refreshToken,
  })
  const fetchFn = params.fetchImpl ?? fetch
  const resp = await fetchFn(SCHWAB_TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: basicAuthHeader(params.clientId, params.clientSecret),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  })
  if (!resp.ok) {
    const text = await resp.text()
    // 400 with "refresh_token_authentication_error" = refresh token dead (>7 days)
    // The caller should surface this as CONFIG so the account disables and the
    // user knows they need to redo the browser dance.
    throw new Error(`Schwab token refresh failed (${resp.status}): ${text}`)
  }
  const json = SchwabTokenResponseSchema.parse(await resp.json())
  return tokensFromResponse(json)
}

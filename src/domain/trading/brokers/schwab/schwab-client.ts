/**
 * Schwab REST client — thin wrapper around fetch with auto-refresh.
 *
 * Handles:
 *   - Bearer-token injection on every request
 *   - Proactive refresh when the access token is within ~30s of expiry
 *   - Reactive refresh on 401 (a single retry, then surface the error)
 *   - TokenStore callback so the broker config file can persist the new
 *     refresh_token (Schwab rotates it on every refresh)
 *
 * The client is intentionally market-data-focused for v1. Trading endpoints
 * (/trader/v1/accounts/...) are not wired yet — see SchwabBroker.ts TODOs.
 */

import {
  SchwabQuotesResponseSchema,
  SchwabOptionChainResponseSchema,
  type SchwabQuotesResponse,
  type SchwabOptionChainResponse,
  type OptionChain,
  type OptionChainParams,
  type OptionQuote,
  type SchwabOptionContract,
} from './schwab-types.js'
import { refreshAccessToken, type SchwabTokens, type TokenStore } from './schwab-auth.js'

export const SCHWAB_API_BASE = 'https://api.schwabapi.com'

export interface SchwabClientOptions {
  clientId: string
  clientSecret: string
  tokens: SchwabTokens
  tokenStore?: TokenStore
  fetchImpl?: typeof fetch
  /** Override base URL for tests. */
  baseUrl?: string
}

export class SchwabClient {
  private readonly clientId: string
  private readonly clientSecret: string
  private tokens: SchwabTokens
  private readonly tokenStore?: TokenStore
  private readonly fetchImpl: typeof fetch
  private readonly baseUrl: string

  private refreshInFlight: Promise<void> | null = null

  constructor(opts: SchwabClientOptions) {
    this.clientId = opts.clientId
    this.clientSecret = opts.clientSecret
    this.tokens = opts.tokens
    this.tokenStore = opts.tokenStore
    this.fetchImpl = opts.fetchImpl ?? fetch
    this.baseUrl = opts.baseUrl ?? SCHWAB_API_BASE
  }

  /** Current tokens — exposed so the broker can persist on init(). */
  getTokens(): SchwabTokens {
    return this.tokens
  }

  // ---- Refresh orchestration ----

  private async refreshTokens(): Promise<void> {
    // Coalesce concurrent refreshes — one HTTP call, many awaiters.
    if (this.refreshInFlight) return this.refreshInFlight
    this.refreshInFlight = (async () => {
      try {
        const next = await refreshAccessToken({
          clientId: this.clientId,
          clientSecret: this.clientSecret,
          refreshToken: this.tokens.refreshToken,
          fetchImpl: this.fetchImpl,
        })
        this.tokens = next
        if (this.tokenStore) await this.tokenStore.onTokensRefreshed(next)
      } finally {
        this.refreshInFlight = null
      }
    })()
    return this.refreshInFlight
  }

  private async ensureFreshToken(): Promise<void> {
    if (Date.now() >= this.tokens.expiresAt) {
      await this.refreshTokens()
    }
  }

  // ---- Core request helper ----

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    await this.ensureFreshToken()

    const attempt = async (): Promise<Response> => {
      return this.fetchImpl(`${this.baseUrl}${path}`, {
        ...init,
        headers: {
          ...init.headers,
          Authorization: `Bearer ${this.tokens.accessToken}`,
          Accept: 'application/json',
        },
      })
    }

    let resp = await attempt()
    if (resp.status === 401) {
      // Token was rejected even though we thought it was fresh — refresh and retry once.
      await this.refreshTokens()
      resp = await attempt()
    }

    if (!resp.ok) {
      const text = await resp.text().catch(() => '')
      throw new Error(`Schwab API ${resp.status} ${resp.statusText} on ${path}: ${text}`)
    }

    return resp.json() as Promise<T>
  }

  // ---- Market data: quotes ====================

  /**
   * Fetch realtime (or delayed, depending on your Schwab account entitlements)
   * quotes for one or more symbols. Returns the raw shape keyed by symbol.
   */
  async quotes(symbols: string[]): Promise<SchwabQuotesResponse> {
    if (symbols.length === 0) return {}
    const q = new URLSearchParams({ symbols: symbols.join(',') })
    const raw = await this.request<unknown>(`/marketdata/v1/quotes?${q}`)
    return SchwabQuotesResponseSchema.parse(raw)
  }

  // ---- Market data: option chain ====================

  /** Raw option-chain response — keyed exp-date map of strike → contracts. */
  async optionChainRaw(params: OptionChainParams): Promise<SchwabOptionChainResponse> {
    const q = new URLSearchParams({ symbol: params.symbol })
    if (params.contractType) q.set('contractType', params.contractType)
    if (params.strategy) q.set('strategy', params.strategy)
    if (params.strikeCount !== undefined) q.set('strikeCount', String(params.strikeCount))
    if (params.includeUnderlyingQuote !== undefined) q.set('includeUnderlyingQuote', String(params.includeUnderlyingQuote))
    if (params.fromDate) q.set('fromDate', params.fromDate)
    if (params.toDate) q.set('toDate', params.toDate)
    const raw = await this.request<unknown>(`/marketdata/v1/chains?${q}`)
    return SchwabOptionChainResponseSchema.parse(raw)
  }

  /** Caller-friendly option chain — flattened calls + puts arrays. */
  async optionChain(params: OptionChainParams): Promise<OptionChain> {
    const resp = await this.optionChainRaw(params)
    return flattenOptionChain(resp)
  }
}

// ==================== Flattening helpers ====================

function flattenOptionContract(c: SchwabOptionContract): OptionQuote {
  return {
    putCall: c.putCall,
    symbol: c.symbol,
    strike: c.strikePrice,
    expiration: c.expirationDate ?? '',
    daysToExpiration: c.daysToExpiration ?? 0,
    bid: c.bid ?? 0,
    ask: c.ask ?? 0,
    last: c.last ?? 0,
    mark: c.mark ?? 0,
    volume: c.totalVolume ?? 0,
    openInterest: c.openInterest ?? 0,
    delta: c.delta,
    gamma: c.gamma,
    theta: c.theta,
    vega: c.vega,
    impliedVolatility: c.volatility,
    inTheMoney: c.inTheMoney,
  }
}

export function flattenOptionChain(resp: SchwabOptionChainResponse): OptionChain {
  const calls: OptionQuote[] = []
  const puts: OptionQuote[] = []

  for (const dateMap of Object.values(resp.callExpDateMap ?? {})) {
    for (const strikeList of Object.values(dateMap)) {
      for (const c of strikeList) calls.push(flattenOptionContract(c))
    }
  }
  for (const dateMap of Object.values(resp.putExpDateMap ?? {})) {
    for (const strikeList of Object.values(dateMap)) {
      for (const c of strikeList) puts.push(flattenOptionContract(c))
    }
  }

  const underlyingPrice = resp.underlyingPrice
    ?? resp.underlying?.last
    ?? resp.underlying?.mark
    ?? 0

  return {
    symbol: resp.symbol,
    underlyingPrice,
    isDelayed: resp.isDelayed ?? false,
    calls,
    puts,
  }
}

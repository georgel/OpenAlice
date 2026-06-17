/**
 * SchwabBroker — IBroker adapter for Charles Schwab's Trader API.
 *
 * Scope (v1, 2026-04-24):
 *   - Realtime quotes (getQuote + getMarketClock)
 *   - Options chain (getOptionChain — Schwab-specific extension method)
 *   - Contract search / details for equities (underlyings only)
 *   - All trading + account endpoints throw BrokerError('CONFIG') when
 *     marketDataOnly=true (default). Trading comes in a follow-up commit.
 *
 * Out of scope (v1):
 *   - Order placement/modify/cancel — stubbed
 *   - Positions / account info / orders retrieval — stubbed
 *   - Research reports — Schwab's research is a non-API asset (PDFs gated
 *     inside client.schwab.com). Scraping path would be a separate feature.
 *
 * OAuth setup: see schwab-auth.ts header. The one-time authorization dance
 * produces the `refreshToken` that goes in the account config. On every
 * init() we call refreshAccessToken(), which rotates the refresh token,
 * and fire onTokensRefreshed so the config file can be rewritten.
 */

import { z } from 'zod'
import Decimal from 'decimal.js'
import {
  Contract,
  ContractDescription,
  ContractDetails,
  Order,
  OrderState,
  OrderCancel,
  Execution,
  UNSET_DECIMAL,
} from '@traderalice/ibkr'
import {
  BrokerError,
  type IBroker,
  type AccountCapabilities,
  type AccountInfo,
  type Position,
  type PlaceOrderResult,
  type OpenOrder,
  type Quote,
  type MarketClock,
  type BrokerConfigField,
  type TpSlParams,
} from '../types.js'
import '../../contract-ext.js'
import { SchwabClient } from './schwab-client.js'
import type {
  SchwabBrokerConfig,
  OptionChain,
  OptionChainParams,
  SchwabAccountNumber,
  SchwabTransaction,
  TransactionsParams,
} from './schwab-types.js'
import type { SchwabTokens, TokenStore } from './schwab-auth.js'
import { refreshAccessToken } from './schwab-auth.js'
import { makeStockContract, resolveSchwabSymbol, makeOptionContract } from './schwab-contracts.js'

const NOT_IMPLEMENTED_MSG =
  'Schwab trading endpoints are not enabled for this account. Set marketDataOnly=false in brokerConfig once trading support ships.'

/** Stub meta — we expose tokens via getter for the config layer to persist. */
export interface SchwabBrokerMeta {
  getCurrentTokens(): SchwabTokens
}

export class SchwabBroker implements IBroker<SchwabBrokerMeta> {
  // ---- Self-registration ----

  static configSchema = z.object({
    clientId: z.string().min(1, 'Schwab app Client ID required'),
    clientSecret: z.string().min(1, 'Schwab app Client Secret required'),
    redirectUri: z.string().url().default('https://127.0.0.1'),
    refreshToken: z.string().min(1, 'Run the one-time OAuth dance to mint a refresh token, then paste it here'),
    accountHash: z.string().optional(),
    marketDataOnly: z.boolean().default(true),
  })

  static configFields: BrokerConfigField[] = [
    { name: 'clientId', type: 'password', label: 'App Client ID', required: true, sensitive: true, description: 'From the app dashboard at developer.schwab.com.' },
    { name: 'clientSecret', type: 'password', label: 'App Client Secret', required: true, sensitive: true },
    { name: 'redirectUri', type: 'text', label: 'Callback URL', default: 'https://127.0.0.1', description: 'Must match what you registered on the Schwab app page exactly — including trailing slash.' },
    { name: 'refreshToken', type: 'password', label: 'Refresh Token', required: true, sensitive: true, description: 'Paste the refresh token printed after running the one-time OAuth helper (see Setup). Valid 7 days — rotated on every use.' },
    { name: 'accountHash', type: 'password', label: 'Account Hash (optional)', required: false, sensitive: true, description: 'Required for trading / positions. Market-data-only mode works without it. Fetch via /trader/v1/accounts/accountNumbers once authorized.' },
    { name: 'marketDataOnly', type: 'boolean', label: 'Market Data Only', default: true, description: 'When enabled, trading and account endpoints throw. Recommended until Schwab trading support lands.' },
  ]

  static fromConfig(config: { id: string; label?: string; brokerConfig: Record<string, unknown> }): SchwabBroker {
    const bc = SchwabBroker.configSchema.parse(config.brokerConfig)
    return new SchwabBroker({
      id: config.id,
      label: config.label,
      clientId: bc.clientId,
      clientSecret: bc.clientSecret,
      redirectUri: bc.redirectUri,
      refreshToken: bc.refreshToken,
      accountHash: bc.accountHash,
      marketDataOnly: bc.marketDataOnly,
    })
  }

  // ---- Instance ----

  readonly id: string
  readonly label: string

  private readonly config: SchwabBrokerConfig
  private client!: SchwabClient
  private tokenStore?: TokenStore

  constructor(config: SchwabBrokerConfig) {
    this.config = config
    this.id = config.id ?? 'schwab'
    this.label = config.label ?? 'Charles Schwab'
  }

  /** Wire up a persistence hook so refresh-token rotation survives restart. */
  setTokenStore(store: TokenStore): void {
    this.tokenStore = store
  }

  get meta(): SchwabBrokerMeta {
    return {
      getCurrentTokens: () => this.client.getTokens(),
    }
  }

  // ---- Lifecycle ----

  async init(): Promise<void> {
    if (!this.config.clientId || !this.config.clientSecret || !this.config.refreshToken) {
      throw new BrokerError(
        'CONFIG',
        `No Schwab OAuth credentials configured. clientId, clientSecret, and refreshToken are required. Run the one-time OAuth helper to mint a refreshToken.`,
      )
    }

    // Mint the first access token immediately so we know creds work.
    let tokens: SchwabTokens
    try {
      tokens = await refreshAccessToken({
        clientId: this.config.clientId,
        clientSecret: this.config.clientSecret,
        refreshToken: this.config.refreshToken,
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      // Schwab's refresh token has a 7-day TTL. Dead refresh = AUTH (the user
      // has to redo the browser dance) — permanent, don't auto-retry.
      throw new BrokerError('AUTH', `Schwab OAuth refresh failed. Refresh tokens expire 7 days after issue. You likely need to redo the browser authorization dance. ${msg}`)
    }

    this.client = new SchwabClient({
      clientId: this.config.clientId,
      clientSecret: this.config.clientSecret,
      tokens,
      tokenStore: this.tokenStore,
    })

    if (this.tokenStore) await this.tokenStore.onTokensRefreshed(tokens)

    console.log(`SchwabBroker[${this.id}]: connected (marketDataOnly=${this.config.marketDataOnly})`)
  }

  async close(): Promise<void> {
    // No persistent connections — client is stateless between requests.
  }

  // ---- Contract search ----

  async searchContracts(pattern: string): Promise<ContractDescription[]> {
    if (!pattern) return []
    const ticker = pattern.toUpperCase()
    const desc = new ContractDescription()
    desc.contract = makeStockContract(ticker)
    return [desc]
  }

  async getContractDetails(query: Contract): Promise<ContractDetails | null> {
    const symbol = resolveSchwabSymbol(query)
    if (!symbol) return null
    const details = new ContractDetails()
    details.contract = (query.secType === 'OPT' ? makeOptionContract(symbol) : makeStockContract(symbol)) ?? makeStockContract(symbol)
    details.validExchanges = 'SMART,NYSE,NASDAQ,ARCA,CBOE'
    details.orderTypes = 'MKT,LMT,STP,STP LMT,TRAIL'
    if (query.secType !== 'OPT') details.stockType = 'COMMON'
    return details
  }

  // ---- Trading (stubbed in v1) ----

  async placeOrder(_contract: Contract, _order: Order, _tpsl?: TpSlParams): Promise<PlaceOrderResult> {
    return { success: false, error: NOT_IMPLEMENTED_MSG }
  }
  async modifyOrder(_orderId: string, _changes: Partial<Order>): Promise<PlaceOrderResult> {
    return { success: false, error: NOT_IMPLEMENTED_MSG }
  }
  async cancelOrder(_orderId: string, _orderCancel?: OrderCancel): Promise<PlaceOrderResult> {
    return { success: false, error: NOT_IMPLEMENTED_MSG }
  }
  async closePosition(_contract: Contract, _quantity?: Decimal): Promise<PlaceOrderResult> {
    return { success: false, error: NOT_IMPLEMENTED_MSG }
  }

  // ---- Queries: account info / positions / orders (stubbed in v1) ----

  async getAccount(): Promise<AccountInfo> {
    throw new BrokerError('CONFIG', NOT_IMPLEMENTED_MSG)
  }
  async getPositions(): Promise<Position[]> {
    return []
  }
  async getOrders(_orderIds: string[]): Promise<OpenOrder[]> {
    return []
  }
  async getOrder(_orderId: string): Promise<OpenOrder | null> {
    return null
  }

  // ---- Market data: quotes ====================

  async getQuote(contract: Contract): Promise<Quote> {
    const symbol = resolveSchwabSymbol(contract)
    if (!symbol) throw new BrokerError('EXCHANGE', `Cannot resolve contract to Schwab symbol`)

    const resp = await this.client.quotes([symbol])
    const entry = resp[symbol]
    if (!entry || !entry.quote) {
      throw new BrokerError('EXCHANGE', `Schwab returned no quote for ${symbol}`)
    }
    const q = entry.quote
    return {
      contract,
      last: String(q.lastPrice ?? 0),
      bid: String(q.bidPrice ?? 0),
      ask: String(q.askPrice ?? 0),
      volume: String(q.totalVolume ?? 0),
      high: q.highPrice != null ? String(q.highPrice) : undefined,
      low: q.lowPrice != null ? String(q.lowPrice) : undefined,
      timestamp: new Date(q.quoteTime ?? Date.now()),
    }
  }

  async getMarketClock(): Promise<MarketClock> {
    // v1 shortcut: use wall-clock US-equity hours. Schwab has /marketdata/v1/markets
    // for authoritative schedule; wire it in when we need accuracy around holidays.
    const now = new Date()
    const nyOffsetMinutes = getNewYorkOffsetMinutes(now)
    const nyNow = new Date(now.getTime() - nyOffsetMinutes * 60_000)
    const hour = nyNow.getUTCHours()
    const day = nyNow.getUTCDay()
    const isWeekday = day >= 1 && day <= 5
    const isOpen = isWeekday && hour >= 9 && hour < 16 // 9:30-16:00 ET — we approximate 9:00 to match hour boundary; Execution layer should rely on the broker-authoritative clock for precision.
    return { isOpen, timestamp: now }
  }

  // ---- Market data: options chain (Schwab-specific extension) ====================

  /**
   * Fetch the options chain for an underlying. Not part of IBroker yet —
   * callers that need chains should type-narrow via BROKER_REGISTRY or
   * `instanceof SchwabBroker` for now. When a second broker ships chains
   * we promote this onto IBroker as an optional capability.
   */
  async getOptionChain(params: OptionChainParams): Promise<OptionChain> {
    return this.client.optionChain(params)
  }

  // ---- Accounts & transactions (read-only — independent of marketDataOnly) ----
  //
  // marketDataOnly gates *trading* (order placement); reading transaction
  // history is a read-only Accounts-API call, so these work whenever the broker
  // is connected. Requires the Schwab app to have the "Accounts and Trading
  // Production" product, and the token to carry account scope (re-auth after
  // adding the product). Without it Schwab returns 401/403, surfaced verbatim.

  /** List the account number → encrypted hash mapping for the authorized login. */
  async getAccountNumbers(): Promise<SchwabAccountNumber[]> {
    return this.client.accountNumbers()
  }

  /**
   * Transaction history. Resolves `account` (plain number or hash) against the
   * authorized accounts; omit it to pull every account. Returns a map keyed by
   * the (plain) account number → raw Schwab transaction objects.
   */
  async getTransactions(params: TransactionsParams): Promise<Record<string, SchwabTransaction[]>> {
    const accounts = await this.client.accountNumbers()
    const targets = params.account
      ? accounts.filter(a => a.accountNumber === params.account || a.hashValue === params.account)
      : accounts
    if (params.account && targets.length === 0) {
      throw new BrokerError('CONFIG', `No Schwab account matching '${params.account}' (have ${accounts.length} account(s)).`)
    }
    const out: Record<string, SchwabTransaction[]> = {}
    for (const a of targets) {
      out[a.accountNumber] = await this.client.transactions(a.hashValue, {
        startDate: params.startDate,
        endDate: params.endDate,
        types: params.types,
        symbol: params.symbol,
      })
    }
    return out
  }

  // ---- Capabilities ----

  getCapabilities(): AccountCapabilities {
    const capabilities: AccountCapabilities = {
      supportedSecTypes: ['STK', 'OPT'],
      supportedOrderTypes: this.config.marketDataOnly ? [] : ['MKT', 'LMT', 'STP', 'STP LMT', 'TRAIL'],
    }
    return capabilities
  }

  // ---- Contract identity ----

  getNativeKey(contract: Contract): string {
    return resolveSchwabSymbol(contract) ?? contract.symbol ?? ''
  }

  resolveNativeKey(nativeKey: string): Contract {
    // OCC symbols always have 15 chars after the root; simple heuristic:
    if (/\d{6}[CP]\d{8}$/.test(nativeKey.replace(/\s+/g, ''))) {
      const c = makeOptionContract(nativeKey)
      if (c) return c
    }
    return makeStockContract(nativeKey)
  }
}

/** Minutes to subtract from UTC to land in New York wall-clock time. */
function getNewYorkOffsetMinutes(d: Date): number {
  // Use Intl to get NY time and compare against UTC.
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  })
  const parts = fmt.formatToParts(d)
  const get = (t: string) => parseInt(parts.find(p => p.type === t)?.value ?? '0', 10)
  const nyMs = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'))
  return Math.round((d.getTime() - nyMs) / 60_000)
}

// Silence unused-var warnings on the stubs.
void Execution
void OrderState
void UNSET_DECIMAL

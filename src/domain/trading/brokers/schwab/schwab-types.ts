/**
 * Zod schemas and TypeScript types for the Schwab Trader API.
 *
 * Only the response shapes we consume are modeled — full swagger is enormous.
 * Unknown fields pass through (Zod passthrough) so Schwab can add fields without
 * breaking us.
 *
 * References:
 *   https://developer.schwab.com/products/trader-api--individual/details/specifications/Market%20Data%20Production
 *   https://developer.schwab.com/products/trader-api--individual/details/specifications/Accounts%20and%20Trading%20Production
 */

import { z } from 'zod'

// ==================== Broker config ====================

export interface SchwabBrokerConfig {
  id?: string
  label?: string
  /** OAuth2 app client ID from developer.schwab.com. */
  clientId: string
  /** OAuth2 app client secret. */
  clientSecret: string
  /** Registered callback URL, e.g. "https://127.0.0.1". Must match app registration exactly. */
  redirectUri: string
  /**
   * Refresh token obtained from the one-time authorization-code exchange.
   * Valid for 7 days from issue — the init() step refreshes on every boot
   * and writes the new refresh_token back via the TokenStore hook.
   */
  refreshToken: string
  /** Optional encrypted account hash. Required only for trading endpoints; market-data works without it. */
  accountHash?: string
  /** If true, all mutating trading calls throw BrokerError('CONFIG'). Default: true for v1. */
  marketDataOnly: boolean
}

// ==================== OAuth token response ====================

export const SchwabTokenResponseSchema = z.object({
  access_token: z.string(),
  refresh_token: z.string(),
  token_type: z.string(),
  expires_in: z.number(),
  scope: z.string().optional(),
  id_token: z.string().optional(),
}).passthrough()

export type SchwabTokenResponse = z.infer<typeof SchwabTokenResponseSchema>

// ==================== Quote ====================

/**
 * Schwab's /marketdata/v1/quotes response is keyed by symbol.
 * Each value has assetMainType + a nested shape that depends on asset type.
 * We model only the fields used downstream.
 */
export const SchwabQuoteEntrySchema = z.object({
  assetMainType: z.string().optional(),
  symbol: z.string().optional(),
  quote: z.object({
    bidPrice: z.number().optional(),
    askPrice: z.number().optional(),
    lastPrice: z.number().optional(),
    totalVolume: z.number().optional(),
    highPrice: z.number().optional(),
    lowPrice: z.number().optional(),
    quoteTime: z.number().optional(),
    tradeTime: z.number().optional(),
  }).passthrough().optional(),
  reference: z.record(z.string(), z.unknown()).optional(),
  regular: z.record(z.string(), z.unknown()).optional(),
}).passthrough()

export type SchwabQuoteEntry = z.infer<typeof SchwabQuoteEntrySchema>

export const SchwabQuotesResponseSchema = z.record(z.string(), SchwabQuoteEntrySchema)
export type SchwabQuotesResponse = z.infer<typeof SchwabQuotesResponseSchema>

// ==================== Option chain ====================

export const SchwabOptionContractSchema = z.object({
  putCall: z.enum(['CALL', 'PUT']),
  symbol: z.string(),
  description: z.string().optional(),
  bid: z.number().optional(),
  ask: z.number().optional(),
  last: z.number().optional(),
  mark: z.number().optional(),
  bidSize: z.number().optional(),
  askSize: z.number().optional(),
  lastSize: z.number().optional(),
  highPrice: z.number().optional(),
  lowPrice: z.number().optional(),
  totalVolume: z.number().optional(),
  openInterest: z.number().optional(),
  volatility: z.number().optional(),
  delta: z.number().optional(),
  gamma: z.number().optional(),
  theta: z.number().optional(),
  vega: z.number().optional(),
  rho: z.number().optional(),
  theoreticalOptionValue: z.number().optional(),
  theoreticalVolatility: z.number().optional(),
  strikePrice: z.number(),
  expirationDate: z.string().optional(),
  daysToExpiration: z.number().optional(),
  multiplier: z.number().optional(),
  inTheMoney: z.boolean().optional(),
}).passthrough()

export type SchwabOptionContract = z.infer<typeof SchwabOptionContractSchema>

/** Schwab returns chains keyed by "YYYY-MM-DD:daysToExp" → { "strike": [contract] }. */
export const SchwabExpDateMapSchema = z.record(
  z.string(),
  z.record(z.string(), z.array(SchwabOptionContractSchema)),
)

export const SchwabOptionChainResponseSchema = z.object({
  symbol: z.string(),
  status: z.string().optional(),
  underlying: z.object({
    symbol: z.string().optional(),
    last: z.number().optional(),
    mark: z.number().optional(),
    bid: z.number().optional(),
    ask: z.number().optional(),
  }).passthrough().nullish(),
  underlyingPrice: z.number().optional(),
  strategy: z.string().optional(),
  interval: z.number().optional(),
  isDelayed: z.boolean().optional(),
  isIndex: z.boolean().optional(),
  interestRate: z.number().optional(),
  volatility: z.number().optional(),
  daysToExpiration: z.number().optional(),
  numberOfContracts: z.number().optional(),
  callExpDateMap: SchwabExpDateMapSchema.optional(),
  putExpDateMap: SchwabExpDateMapSchema.optional(),
}).passthrough()

export type SchwabOptionChainResponse = z.infer<typeof SchwabOptionChainResponseSchema>

// ==================== Flattened option-chain (our consumers) ====================

/**
 * Our caller-friendly representation. Schwab's map-of-map-of-array is faithful
 * to the wire format but awkward to scan; the flattened shape is a simple list
 * with everything a trader needs per contract.
 */
export interface OptionQuote {
  putCall: 'CALL' | 'PUT'
  symbol: string
  strike: number
  expiration: string
  daysToExpiration: number
  bid: number
  ask: number
  last: number
  mark: number
  volume: number
  openInterest: number
  delta?: number
  gamma?: number
  theta?: number
  vega?: number
  impliedVolatility?: number
  inTheMoney?: boolean
}

export interface OptionChain {
  symbol: string
  underlyingPrice: number
  isDelayed: boolean
  calls: OptionQuote[]
  puts: OptionQuote[]
}

// ==================== Option chain request params ====================

export interface OptionChainParams {
  /** Underlying ticker, e.g. "AAPL". */
  symbol: string
  /** Filter: CALL | PUT | ALL (default ALL). */
  contractType?: 'CALL' | 'PUT' | 'ALL'
  /** Number of strikes to return around ATM. */
  strikeCount?: number
  /** true → include quotes; default true. */
  includeUnderlyingQuote?: boolean
  /** Strategy. SINGLE for plain chains. */
  strategy?: 'SINGLE' | 'ANALYTICAL' | 'COVERED' | 'VERTICAL' | 'CALENDAR' | 'STRANGLE' | 'STRADDLE' | 'BUTTERFLY' | 'CONDOR' | 'DIAGONAL' | 'COLLAR' | 'ROLL'
  /** Filter: specific expiration window, ISO yyyy-mm-dd. */
  fromDate?: string
  toDate?: string
}

// ==================== Accounts (account-number → hash mapping) ====================

/** /trader/v1/accounts/accountNumbers → [{ accountNumber, hashValue }]. */
export const SchwabAccountNumberSchema = z.object({
  accountNumber: z.string(),
  hashValue: z.string(),
}).passthrough()
export type SchwabAccountNumber = z.infer<typeof SchwabAccountNumberSchema>

export const SchwabAccountNumbersResponseSchema = z.array(SchwabAccountNumberSchema)
export type SchwabAccountNumbersResponse = z.infer<typeof SchwabAccountNumbersResponseSchema>

// ==================== Transactions ====================

/**
 * /trader/v1/accounts/{hash}/transactions → array of transaction objects.
 *
 * Schwab's transaction schema is large and varies by activity type (TRADE,
 * DIVIDEND_OR_INTEREST, ACH_RECEIPT, JOURNAL, nested transferItems[], …). We
 * deliberately DON'T model it strictly — this is a raw-dump pass-through. We
 * validate only that it's an array of objects, so a Schwab shape change can
 * never reject real account data (mirrors the "unknown fields pass through"
 * policy used for quotes/chains above).
 */
export const SchwabTransactionSchema = z.record(z.string(), z.unknown())
export type SchwabTransaction = z.infer<typeof SchwabTransactionSchema>

export const SchwabTransactionsResponseSchema = z.array(SchwabTransactionSchema)
export type SchwabTransactionsResponse = z.infer<typeof SchwabTransactionsResponseSchema>

/** Valid Schwab transaction `types` filter values (optional on the request). */
export type SchwabTransactionType =
  | 'TRADE' | 'RECEIVE_AND_DELIVER' | 'DIVIDEND_OR_INTEREST'
  | 'ACH_RECEIPT' | 'ACH_DISBURSEMENT' | 'CASH_RECEIPT' | 'CASH_DISBURSEMENT'
  | 'ELECTRONIC_FUND' | 'WIRE_OUT' | 'WIRE_IN' | 'JOURNAL' | 'MEMORANDUM'
  | 'MARGIN_CALL' | 'MONEY_MARKET' | 'SMA_ADJUSTMENT'

export interface TransactionsParams {
  /** Account number OR encrypted hashValue. Omit to fetch every authorized account. */
  account?: string
  /** ISO-8601 with ms + tz, e.g. "2026-01-01T00:00:00.000Z". Required by Schwab; max ~1-year span. */
  startDate: string
  endDate: string
  /** Optional Schwab type filter; comma-separated when multiple. */
  types?: string
  /** Optional symbol filter. */
  symbol?: string
}

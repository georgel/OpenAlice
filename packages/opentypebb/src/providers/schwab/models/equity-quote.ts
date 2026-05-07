/**
 * Schwab Equity Quote Model.
 *
 * Realtime quotes via Schwab's /marketdata/v1/quotes endpoint. The
 * SchwabBroker singleton owns the OAuth lifecycle; this fetcher delegates
 * symbol resolution + per-symbol calls and shapes the result into the
 * standard EquityQuoteData record.
 */

import { z } from 'zod'
import { Fetcher } from '../../../core/provider/abstract/fetcher.js'
import { EquityQuoteQueryParamsSchema, EquityQuoteDataSchema } from '../../../standard-models/equity-quote.js'
import { EmptyDataError } from '../../../core/provider/utils/errors.js'
import { getSchwabBroker } from '../schwab-singleton.js'
import { makeStockContract } from '../../../../../../src/domain/trading/brokers/schwab/schwab-contracts.js'
import type { Quote } from '../../../../../../src/domain/trading/brokers/types.js'

export const SchwabEquityQuoteQueryParamsSchema = EquityQuoteQueryParamsSchema
export type SchwabEquityQuoteQueryParams = z.infer<typeof SchwabEquityQuoteQueryParamsSchema>

export const SchwabEquityQuoteDataSchema = EquityQuoteDataSchema
export type SchwabEquityQuoteData = z.infer<typeof SchwabEquityQuoteDataSchema>

/** Convert Schwab Quote (string-typed decimals) to the standard EquityQuote shape. */
function quoteToRecord(symbol: string, q: Quote): Record<string, unknown> {
  const num = (s: string | undefined): number | null => {
    if (s == null) return null
    const n = Number(s)
    return Number.isFinite(n) ? n : null
  }
  return {
    symbol,
    last_price: num(q.last),
    bid: num(q.bid),
    ask: num(q.ask),
    volume: num(q.volume),
    high: num(q.high),
    low: num(q.low),
    source: 'schwab',
    quoted_at: q.timestamp.toISOString(),
  }
}

export class SchwabEquityQuoteFetcher extends Fetcher {
  static override requireCredentials = false

  static override transformQuery(params: Record<string, unknown>): SchwabEquityQuoteQueryParams {
    // `fresh=1` is a cache-bypass hint. opentypebb has no in-process quote cache
    // today (verified by codebase inspection), so this is a no-op. We strip it
    // here so it doesn't sneak into Zod's passthrough and confuse callers.
    const { fresh: _fresh, ...rest } = params
    void _fresh
    return SchwabEquityQuoteQueryParamsSchema.parse(rest)
  }

  static override async extractData(
    query: SchwabEquityQuoteQueryParams,
    _credentials: Record<string, string> | null,
  ): Promise<Record<string, unknown>[]> {
    const symbols = query.symbol.split(',').map(s => s.trim()).filter(Boolean)
    if (!symbols.length) return []

    // Boot the singleton once; if it throws (auth/credentials), let it bubble
    // up so the price-router fallback layer catches it and pivots to yfinance.
    const broker = await getSchwabBroker()

    const results = await Promise.allSettled(
      symbols.map(async (s) => {
        const q = await broker.getQuote(makeStockContract(s))
        return quoteToRecord(s, q)
      }),
    )

    const data: Record<string, unknown>[] = []
    for (const r of results) {
      if (r.status === 'fulfilled') {
        data.push(r.value)
      } else {
        const reason = r.reason
        const msg = reason instanceof Error ? reason.message : String(reason)
        // Bubble up auth failures — they apply to all symbols, not just one,
        // and should trigger the fallback layer rather than be silently dropped.
        if (msg.includes('AUTH') || msg.includes('Schwab OAuth refresh failed')) {
          throw reason instanceof Error ? reason : new Error(msg)
        }
        console.error(`[schwab equity-quote] Failed for symbol: ${msg}`)
      }
    }
    return data
  }

  static override transformData(
    _query: SchwabEquityQuoteQueryParams,
    data: Record<string, unknown>[],
  ): SchwabEquityQuoteData[] {
    if (!data.length) throw new EmptyDataError('No Schwab quote data returned')
    return data.map(d => SchwabEquityQuoteDataSchema.parse(d))
  }
}

/**
 * Schwab Options Chains Model.
 *
 * Realtime options chain (with greeks + IV) via Schwab's /marketdata/v1/chains.
 * SchwabBroker.getOptionChain returns the flattened OptionChain shape (calls +
 * puts arrays with one OptionQuote per contract). We map each OptionQuote to
 * the standard OptionsChainsData record.
 *
 * IV unit decision (recorded in build log): yfinance returns implied
 * volatility as a decimal (e.g. 0.30 = 30%) and Schwab returns percent
 * (e.g. 30.295 = 30.295%). To stay consistent across providers, we divide
 * Schwab's value by 100 before emitting. This is verified against a live
 * yfinance pull for the same symbol on the same day.
 */

import { z } from 'zod'
import { Fetcher } from '../../../core/provider/abstract/fetcher.js'
import { OptionsChainsQueryParamsSchema, OptionsChainsDataSchema } from '../../../standard-models/options-chains.js'
import { EmptyDataError } from '../../../core/provider/utils/errors.js'
import { getSchwabBroker } from '../schwab-singleton.js'
import type { OptionChain, OptionQuote } from '../../../../../../src/domain/trading/brokers/schwab/schwab-types.js'

export const SchwabOptionsChainsQueryParamsSchema = OptionsChainsQueryParamsSchema
export type SchwabOptionsChainsQueryParams = z.infer<typeof SchwabOptionsChainsQueryParamsSchema>

export const SchwabOptionsChainsDataSchema = OptionsChainsDataSchema
export type SchwabOptionsChainsData = z.infer<typeof SchwabOptionsChainsDataSchema>

function mapOptionQuote(chain: OptionChain, opt: OptionQuote): Record<string, unknown> {
  // Schwab IV is in percent units (e.g., 30.295 = 30.295%). Yfinance is in
  // decimal (0.30 = 30%). Normalize Schwab to decimal for cross-provider
  // consistency.
  const ivDecimal = opt.impliedVolatility != null
    ? opt.impliedVolatility / 100
    : null

  return {
    underlying_symbol: chain.symbol,
    underlying_price: chain.underlyingPrice,
    contract_symbol: opt.symbol,
    expiration: opt.expiration,
    dte: opt.daysToExpiration,
    strike: opt.strike,
    option_type: opt.putCall === 'CALL' ? 'call' : 'put',
    bid: opt.bid,
    ask: opt.ask,
    mark: opt.mark,
    last_trade_price: opt.last,
    volume: opt.volume,
    open_interest: opt.openInterest,
    delta: opt.delta ?? null,
    gamma: opt.gamma ?? null,
    theta: opt.theta ?? null,
    vega: opt.vega ?? null,
    implied_volatility: ivDecimal,
  }
}

export class SchwabOptionsChainsFetcher extends Fetcher {
  static override requireCredentials = false

  static override transformQuery(params: Record<string, unknown>): SchwabOptionsChainsQueryParams {
    const { fresh: _fresh, ...rest } = params
    void _fresh
    return SchwabOptionsChainsQueryParamsSchema.parse(rest)
  }

  static override async extractData(
    query: SchwabOptionsChainsQueryParams,
    _credentials: Record<string, string> | null,
  ): Promise<Record<string, unknown>[]> {
    const broker = await getSchwabBroker()
    const chain = await broker.getOptionChain({ symbol: query.symbol })

    const records: Record<string, unknown>[] = []
    for (const c of chain.calls) records.push(mapOptionQuote(chain, c))
    for (const p of chain.puts) records.push(mapOptionQuote(chain, p))

    if (!records.length) {
      throw new EmptyDataError(`No Schwab options contracts for ${query.symbol}`)
    }
    return records
  }

  static override transformData(
    _query: SchwabOptionsChainsQueryParams,
    data: Record<string, unknown>[],
  ): SchwabOptionsChainsData[] {
    return data.map(d => SchwabOptionsChainsDataSchema.parse(d))
  }
}

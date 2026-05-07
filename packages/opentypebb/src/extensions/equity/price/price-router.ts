/**
 * Equity Price Router.
 * Maps to: openbb_equity/price/price_router.py
 */

import { Router } from '../../../core/app/router.js'

export const priceRouter = new Router({
  prefix: '/price',
  description: 'Equity price data.',
})

priceRouter.command({
  model: 'EquityQuote',
  path: '/quote',
  description: 'Get the latest quote for a given stock. Schwab provides realtime data; falls back to yfinance on Schwab failure.',
  handler: async (executor, provider, params, credentials) => {
    if (provider !== 'schwab') {
      return executor.execute(provider, 'EquityQuote', params, credentials)
    }
    try {
      return await executor.execute('schwab', 'EquityQuote', params, credentials)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error('[price-router] Schwab quote failed, falling back to yfinance:', msg)
      const yfinanceResult = await executor.execute('yfinance', 'EquityQuote', params, credentials)
      // Inject fallback markers into each result record so callers can see
      // they got yfinance data even though they asked for schwab.
      const records = (Array.isArray(yfinanceResult) ? yfinanceResult : [yfinanceResult]) as Record<string, unknown>[]
      return records.map((r) => ({ ...r, source: 'yfinance', fallback: true }))
    }
  },
})

priceRouter.command({
  model: 'EquityNBBO',
  path: '/nbbo',
  description: 'Get the National Best Bid and Offer for a given stock.',
  handler: async (executor, provider, params, credentials) => {
    return executor.execute(provider, 'EquityNBBO', params, credentials)
  },
})

priceRouter.command({
  model: 'EquityHistorical',
  path: '/historical',
  description: 'Get historical price data for a given stock. This includes open, high, low, close, and volume.',
  handler: async (executor, provider, params, credentials) => {
    return executor.execute(provider, 'EquityHistorical', params, credentials)
  },
})

priceRouter.command({
  model: 'PricePerformance',
  path: '/performance',
  description: 'Get price performance data for a given stock over various time periods.',
  handler: async (executor, provider, params, credentials) => {
    return executor.execute(provider, 'PricePerformance', params, credentials)
  },
})

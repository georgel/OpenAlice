/**
 * Schwab Provider Module.
 *
 * Wires Schwab fetchers (realtime quotes, options chains) into the typebb
 * provider registry. The shared SchwabBroker singleton (see schwab-singleton.ts)
 * owns OAuth state and is initialized lazily on first request.
 */

import { Provider } from '../../core/provider/abstract/provider.js'

import { SchwabEquityQuoteFetcher } from './models/equity-quote.js'
import { SchwabOptionsChainsFetcher } from './models/options-chains.js'

export const schwabProvider = new Provider({
  name: 'schwab',
  website: 'https://developer.schwab.com',
  description: 'Charles Schwab Trader API — realtime quotes and options chains.',
  fetcherDict: {
    EquityQuote: SchwabEquityQuoteFetcher,
    OptionsChains: SchwabOptionsChainsFetcher,
  },
  reprName: 'Charles Schwab',
})

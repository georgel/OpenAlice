/**
 * SchwabBroker unit tests.
 *
 * No live Schwab calls — every test uses a mocked fetch that serves
 * recorded response shapes. This lets us exercise the parsing paths,
 * OAuth refresh, and option-chain flattening without credentials.
 */

import { describe, expect, it, beforeEach } from 'vitest'
import { SchwabBroker } from './SchwabBroker.js'
import { SchwabClient, flattenOptionChain } from './schwab-client.js'
import { makeStockContract, makeOptionContract, resolveSchwabSymbol } from './schwab-contracts.js'
import { extractAuthorizationCode, buildAuthorizationUrl } from './schwab-auth.js'

// ==================== Fixtures ====================

const QUOTES_AAPL_FIXTURE = {
  AAPL: {
    assetMainType: 'EQUITY',
    symbol: 'AAPL',
    quote: {
      bidPrice: 175.10,
      askPrice: 175.20,
      lastPrice: 175.15,
      totalVolume: 12345678,
      highPrice: 176.00,
      lowPrice: 174.50,
      quoteTime: 1729800000000,
      tradeTime: 1729800000000,
    },
  },
}

const OPTION_CHAIN_FIXTURE = {
  symbol: 'AAPL',
  status: 'SUCCESS',
  underlyingPrice: 175.15,
  isDelayed: false,
  callExpDateMap: {
    '2025-01-17:90': {
      '175.0': [{
        putCall: 'CALL',
        symbol: 'AAPL  250117C00175000',
        strikePrice: 175,
        bid: 3.20, ask: 3.30, last: 3.25, mark: 3.25,
        totalVolume: 1234, openInterest: 5678,
        delta: 0.52, gamma: 0.03, theta: -0.08, vega: 0.22,
        volatility: 28.5,
        expirationDate: '2025-01-17T00:00:00.000Z',
        daysToExpiration: 90,
        inTheMoney: true,
      }],
    },
  },
  putExpDateMap: {
    '2025-01-17:90': {
      '175.0': [{
        putCall: 'PUT',
        symbol: 'AAPL  250117P00175000',
        strikePrice: 175,
        bid: 2.80, ask: 2.90, last: 2.85, mark: 2.85,
        totalVolume: 890, openInterest: 3456,
        delta: -0.48, gamma: 0.03, theta: -0.07, vega: 0.22,
        volatility: 28.3,
        expirationDate: '2025-01-17T00:00:00.000Z',
        daysToExpiration: 90,
        inTheMoney: false,
      }],
    },
  },
}

const TOKEN_FIXTURE = {
  access_token: 'fake-access-token',
  refresh_token: 'fake-refresh-token-v2',
  token_type: 'Bearer',
  expires_in: 1800,
  scope: 'api',
}

// ==================== makeStockContract / resolveSchwabSymbol ====================

describe('schwab-contracts', () => {
  it('stock round-trip', () => {
    const c = makeStockContract('AAPL')
    expect(c.symbol).toBe('AAPL')
    expect(c.secType).toBe('STK')
    expect(resolveSchwabSymbol(c)).toBe('AAPL')
  })

  it('lowercases become uppercase', () => {
    expect(makeStockContract('msft').symbol).toBe('MSFT')
  })

  it('option OCC parse', () => {
    const c = makeOptionContract('AAPL  250117C00175000')
    expect(c).not.toBeNull()
    expect(c!.symbol).toBe('AAPL')
    expect(c!.secType).toBe('OPT')
    expect(c!.right).toBe('C')
    expect(c!.strike).toBe(175)
    expect(c!.lastTradeDateOrContractMonth).toBe('20250117')
    expect(c!.multiplier).toBe('100')
  })

  it('option round-trip via resolveSchwabSymbol', () => {
    const c = makeOptionContract('AAPL  250117P00150500')
    const back = resolveSchwabSymbol(c!)
    expect(back?.replace(/\s+/g, '')).toBe('AAPL250117P00150500')
  })

  it('rejects unsupported secType', () => {
    const c = makeStockContract('AAPL')
    c.secType = 'FUT'
    expect(resolveSchwabSymbol(c)).toBeNull()
  })
})

// ==================== OAuth helpers ====================

describe('schwab-auth', () => {
  it('builds authorization URL with required params', () => {
    const u = new URL(buildAuthorizationUrl({ clientId: 'abc', redirectUri: 'https://127.0.0.1' }))
    expect(u.searchParams.get('client_id')).toBe('abc')
    expect(u.searchParams.get('redirect_uri')).toBe('https://127.0.0.1')
    expect(u.searchParams.get('response_type')).toBe('code')
  })

  it('extracts code from redirected URL', () => {
    expect(extractAuthorizationCode('https://127.0.0.1/?code=ABC123&session=XYZ')).toBe('ABC123')
  })

  it('extracts code from bare query string', () => {
    expect(extractAuthorizationCode('code=HELLO&session=WORLD')).toBe('HELLO')
  })

  it('returns null when no code', () => {
    expect(extractAuthorizationCode('https://127.0.0.1/')).toBeNull()
  })
})

// ==================== Option chain flattening ====================

describe('flattenOptionChain', () => {
  it('flattens calls + puts with greeks', () => {
    const chain = flattenOptionChain(OPTION_CHAIN_FIXTURE as never)
    expect(chain.symbol).toBe('AAPL')
    expect(chain.underlyingPrice).toBe(175.15)
    expect(chain.calls.length).toBe(1)
    expect(chain.puts.length).toBe(1)

    const call = chain.calls[0]
    expect(call.symbol).toBe('AAPL  250117C00175000')
    expect(call.strike).toBe(175)
    expect(call.delta).toBeCloseTo(0.52)
    expect(call.impliedVolatility).toBeCloseTo(28.5)
    expect(call.inTheMoney).toBe(true)

    const put = chain.puts[0]
    expect(put.putCall).toBe('PUT')
    expect(put.delta).toBeCloseTo(-0.48)
  })

  it('handles empty maps', () => {
    const chain = flattenOptionChain({ symbol: 'X', isDelayed: false } as never)
    expect(chain.calls).toEqual([])
    expect(chain.puts).toEqual([])
    expect(chain.underlyingPrice).toBe(0)
  })
})

// ==================== SchwabClient with mocked fetch ====================

function makeFetchMock(routes: Record<string, unknown>): typeof fetch {
  return (async (url: string | URL | Request, _init?: RequestInit) => {
    const u = typeof url === 'string' ? url : 'url' in url ? url.url : url.toString()
    const key = Object.keys(routes).find((k) => u.includes(k))
    if (!key) throw new Error(`Unexpected URL: ${u}`)
    const body = routes[key]
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as unknown as typeof fetch
}

describe('SchwabClient', () => {
  const tokens = { accessToken: 'tok', refreshToken: 'rtok', expiresAt: Date.now() + 60_000 }

  it('fetches quotes and parses response', async () => {
    const fetchMock = makeFetchMock({ '/marketdata/v1/quotes': QUOTES_AAPL_FIXTURE })
    const client = new SchwabClient({
      clientId: 'x', clientSecret: 'y', tokens, fetchImpl: fetchMock,
    })
    const resp = await client.quotes(['AAPL'])
    expect(resp.AAPL.quote?.lastPrice).toBe(175.15)
  })

  it('fetches + flattens option chain', async () => {
    const fetchMock = makeFetchMock({ '/marketdata/v1/chains': OPTION_CHAIN_FIXTURE })
    const client = new SchwabClient({
      clientId: 'x', clientSecret: 'y', tokens, fetchImpl: fetchMock,
    })
    const chain = await client.optionChain({ symbol: 'AAPL' })
    expect(chain.calls.length + chain.puts.length).toBe(2)
  })

  it('refreshes on expired token before the call', async () => {
    let refreshCalls = 0
    const fetchMock = (async (url: string | URL | Request) => {
      const u = typeof url === 'string' ? url : 'url' in url ? url.url : url.toString()
      if (u.includes('/oauth/token')) {
        refreshCalls++
        return new Response(JSON.stringify(TOKEN_FIXTURE), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (u.includes('/marketdata/v1/quotes')) {
        return new Response(JSON.stringify(QUOTES_AAPL_FIXTURE), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      throw new Error(`unexpected ${u}`)
    }) as unknown as typeof fetch

    const expiredTokens = { accessToken: 'expired', refreshToken: 'rtok', expiresAt: Date.now() - 1000 }
    const client = new SchwabClient({
      clientId: 'x', clientSecret: 'y', tokens: expiredTokens, fetchImpl: fetchMock,
    })
    await client.quotes(['AAPL'])
    expect(refreshCalls).toBe(1)
    expect(client.getTokens().accessToken).toBe('fake-access-token')
    expect(client.getTokens().refreshToken).toBe('fake-refresh-token-v2')
  })

  it('retries once on 401 after refresh', async () => {
    let quoteCalls = 0
    let refreshCalls = 0
    const fetchMock = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = typeof url === 'string' ? url : 'url' in url ? url.url : url.toString()
      if (u.includes('/oauth/token')) {
        refreshCalls++
        return new Response(JSON.stringify(TOKEN_FIXTURE), { status: 200 })
      }
      if (u.includes('/marketdata/v1/quotes')) {
        quoteCalls++
        const auth = (init?.headers as Record<string, string> | undefined)?.Authorization
        // First call: return 401; after refresh, second call succeeds.
        if (quoteCalls === 1) return new Response('{"error":"unauthorized"}', { status: 401 })
        expect(auth).toContain('fake-access-token')
        return new Response(JSON.stringify(QUOTES_AAPL_FIXTURE), { status: 200 })
      }
      throw new Error(`unexpected ${u}`)
    }) as unknown as typeof fetch

    const client = new SchwabClient({
      clientId: 'x', clientSecret: 'y',
      tokens: { accessToken: 'stale', refreshToken: 'rtok', expiresAt: Date.now() + 60_000 },
      fetchImpl: fetchMock,
    })
    await client.quotes(['AAPL'])
    expect(refreshCalls).toBe(1)
    expect(quoteCalls).toBe(2)
  })
})

// ==================== SchwabBroker integration ====================

describe('SchwabBroker', () => {
  let broker: SchwabBroker

  beforeEach(() => {
    broker = SchwabBroker.fromConfig({
      id: 'schwab-test',
      label: 'Schwab Test',
      brokerConfig: {
        clientId: 'cid',
        clientSecret: 'csec',
        refreshToken: 'rtok',
        marketDataOnly: true,
      },
    })
    // Inject a stub client — skip init() because that hits the network.
    ;(broker as unknown as { client: SchwabClient }).client = new SchwabClient({
      clientId: 'cid', clientSecret: 'csec',
      tokens: { accessToken: 'tok', refreshToken: 'rtok', expiresAt: Date.now() + 60_000 },
      fetchImpl: makeFetchMock({
        '/marketdata/v1/quotes': QUOTES_AAPL_FIXTURE,
        '/marketdata/v1/chains': OPTION_CHAIN_FIXTURE,
      }),
    })
  })

  it('self-registers via configSchema + fromConfig', () => {
    expect(broker.id).toBe('schwab-test')
    expect(broker.label).toBe('Schwab Test')
  })

  it('trading endpoints are stubbed when marketDataOnly', async () => {
    const r1 = await broker.placeOrder(makeStockContract('AAPL'), {} as never)
    expect(r1.success).toBe(false)
    expect(r1.error).toMatch(/not enabled/i)

    await expect(broker.getAccount()).rejects.toThrow(/not enabled/i)
  })

  it('getQuote returns parsed Quote', async () => {
    const contract = makeStockContract('AAPL')
    const quote = await broker.getQuote(contract)
    expect(quote.last).toBe(175.15)
    expect(quote.bid).toBe(175.10)
    expect(quote.ask).toBe(175.20)
    expect(quote.volume).toBe(12345678)
  })

  it('getOptionChain returns flattened chain', async () => {
    const chain = await broker.getOptionChain({ symbol: 'AAPL' })
    expect(chain.calls.length).toBeGreaterThan(0)
    expect(chain.calls[0].symbol).toMatch(/^AAPL/)
  })

  it('capabilities respect marketDataOnly', () => {
    const caps = broker.getCapabilities()
    expect(caps.supportedSecTypes).toContain('STK')
    expect(caps.supportedSecTypes).toContain('OPT')
    expect(caps.supportedOrderTypes).toEqual([])
  })

  it('searchContracts returns stock description', async () => {
    const descs = await broker.searchContracts('MSFT')
    expect(descs.length).toBe(1)
    expect(descs[0].contract.symbol).toBe('MSFT')
  })
})

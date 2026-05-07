#!/usr/bin/env tsx
/**
 * Schwab live smoke test. Exercises the broker against the live API.
 *
 * Usage:
 *   export SCHWAB_CLIENT_ID=...
 *   export SCHWAB_CLIENT_SECRET=...
 *   export SCHWAB_REFRESH_TOKEN=...
 *   pnpm tsx scripts/schwab-smoke.ts
 *
 * Tests:
 *   1. init() — refreshes access token, rotates refresh token
 *   2. getQuote('AAPL') — realtime quote
 *   3. getOptionChain({ symbol: 'AAPL' }) — option chain w/ greeks
 *   4. Prints rotated refresh token at the end (save it — it's the new one)
 */

import { SchwabBroker } from '../src/domain/trading/brokers/schwab/index.js'

async function main() {
  const clientId = process.env.SCHWAB_CLIENT_ID
  const clientSecret = process.env.SCHWAB_CLIENT_SECRET
  const refreshToken = process.env.SCHWAB_REFRESH_TOKEN

  if (!clientId || !clientSecret || !refreshToken) {
    console.error('Missing env: SCHWAB_CLIENT_ID, SCHWAB_CLIENT_SECRET, SCHWAB_REFRESH_TOKEN required.')
    process.exit(1)
  }

  let latestRefreshToken = refreshToken

  const broker = new SchwabBroker({
    clientId,
    clientSecret,
    refreshToken,
    redirectUri: 'https://127.0.0.1',
    marketDataOnly: true,
    onTokensRefreshed: (tokens) => {
      latestRefreshToken = tokens.refreshToken
      console.log(`[token-rotated] new refresh token expires ${new Date(tokens.refreshTokenExpiresAt ?? 0).toISOString()}`)
    },
  })

  console.log('--- init ---')
  await broker.init()
  console.log('init OK')

  console.log('\n--- getQuote(AAPL) ---')
  const quote = await broker.getQuote({ symbol: 'AAPL' } as any)
  console.log(JSON.stringify(quote, null, 2))

  console.log('\n--- getOptionChain(AAPL, next monthly) ---')
  const chain = await broker.getOptionChain({ symbol: 'AAPL', strikeCount: 4 })
  const sample = {
    symbol: chain.symbol,
    expirations: Array.from(new Set([...chain.calls, ...chain.puts].map((o) => o.expiration))).slice(0, 3),
    callsCount: chain.calls.length,
    putsCount: chain.puts.length,
    firstCall: chain.calls[0],
    firstPut: chain.puts[0],
  }
  console.log(JSON.stringify(sample, null, 2))

  console.log('\n--- ROTATED REFRESH TOKEN (save this) ---')
  console.log(latestRefreshToken)
  console.log('\nSmoke test PASSED.')
}

main().catch((err) => {
  console.error('\nSMOKE TEST FAILED:', err)
  process.exit(1)
})

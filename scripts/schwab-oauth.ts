#!/usr/bin/env tsx
/**
 * One-time Schwab OAuth helper.
 *
 * Usage:
 *   pnpm tsx scripts/schwab-oauth.ts \
 *     --client-id <ID> --client-secret <SECRET> \
 *     --redirect-uri https://127.0.0.1
 *
 * Flow:
 *   1. Prints an authorization URL — open it in your browser, log in,
 *      authorize the app.
 *   2. The browser redirects to your configured redirectUri with
 *      ?code=... — the page won't load (it's 127.0.0.1 with no server),
 *      but the URL in the address bar has what we need.
 *   3. Paste the full redirected URL (or just the `code` param value)
 *      back into this helper.
 *   4. The helper exchanges the code for a refresh token and prints it.
 *      Copy that token into your Schwab account config.
 *
 * The refresh token is valid for 7 days from issue. OpenAlice will rotate
 * it on every use, so as long as you run the broker at least weekly it
 * stays alive indefinitely.
 */

import { createInterface } from 'node:readline/promises'
import {
  buildAuthorizationUrl,
  exchangeCodeForToken,
  extractAuthorizationCode,
} from '../src/domain/trading/brokers/schwab/schwab-auth.js'

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? undefined : process.argv[i + 1]
}

async function main() {
  const clientId = arg('client-id') ?? process.env.SCHWAB_CLIENT_ID
  const clientSecret = arg('client-secret') ?? process.env.SCHWAB_CLIENT_SECRET
  const redirectUri = arg('redirect-uri') ?? process.env.SCHWAB_REDIRECT_URI ?? 'https://127.0.0.1'

  if (!clientId || !clientSecret) {
    console.error('Missing --client-id or --client-secret (env SCHWAB_CLIENT_ID / SCHWAB_CLIENT_SECRET also work).')
    process.exit(1)
  }

  const url = buildAuthorizationUrl({ clientId, redirectUri })
  console.log('\nStep 1 — open this URL in your browser, log in to Schwab, and authorize the app:\n')
  console.log(url)
  console.log('\nStep 2 — after authorizing, your browser will try to load the redirect URL. It will fail to load (that\'s fine).')
  console.log('Copy the full URL from your browser\'s address bar (it should contain "?code=...").\n')

  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const pasted = (await rl.question('Paste the full redirected URL (or just the code value): ')).trim()
  rl.close()

  const code = extractAuthorizationCode(pasted) ?? pasted
  if (!code) {
    console.error('Could not extract an authorization code from your input.')
    process.exit(1)
  }

  console.log('\nStep 3 — exchanging code for tokens...')
  const tokens = await exchangeCodeForToken({ clientId, clientSecret, redirectUri, code })

  console.log('\nSuccess. Copy this refresh token into the SchwabBroker account config:\n')
  console.log(tokens.refreshToken)
  console.log('\n(Access token below expires in ~30 minutes; OpenAlice refreshes it automatically on every call.)')
  console.log(`access_token: ${tokens.accessToken}`)
  console.log(`expires_at:   ${new Date(tokens.expiresAt).toISOString()}`)
}

main().catch((err) => {
  console.error('\nFailed:', err?.message ?? err)
  process.exit(1)
})

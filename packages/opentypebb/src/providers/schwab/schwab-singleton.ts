/**
 * Schwab broker singleton for opentypebb.
 *
 * Boots a single SchwabBroker instance lazily on first use, wires a
 * filesystem-backed TokenStore that rotates the refresh token on every
 * Schwab refresh, and persists tokens to /app/data/config/schwab-tokens.json.
 *
 * The singleton is intentionally lazy — instantiation only happens on the
 * first call to getSchwabBroker(), so the opentypebb server can start cleanly
 * even if Schwab credentials or token files are missing. In that case the
 * /api/v1/schwab/health endpoint will simply report connected=false and
 * Schwab quote requests will surface the auth error to the fallback layer.
 *
 * Token file shape:
 *   { "refreshToken": string, "mintedAt": ISO8601 }
 *
 * Atomic write strategy: write to a sibling .tmp file, then rename — which
 * is atomic on POSIX filesystems and avoids torn writes if the container is
 * killed mid-rotation.
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'

// Cross-package relative imports — Schwab broker lives in the open-alice src/.
// Tsup bundles these into the opentypebb dist on `pnpm build`.
import { SchwabBroker } from '../../../../../src/domain/trading/brokers/schwab/SchwabBroker.js'
import type { SchwabTokens, TokenStore } from '../../../../../src/domain/trading/brokers/schwab/schwab-auth.js'

const TOKEN_FILE = '/app/data/config/schwab-tokens.json'

interface PersistedTokens {
  refreshToken: string
  mintedAt: string
}

let cachedBroker: SchwabBroker | null = null
let initPromise: Promise<SchwabBroker> | null = null

async function readPersistedTokens(): Promise<PersistedTokens> {
  let raw: string
  try {
    raw = await fs.readFile(TOKEN_FILE, 'utf8')
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(
      `[schwab-singleton] Could not read ${TOKEN_FILE}: ${msg}. ` +
      `Run scripts/schwab-oauth.ts on a workstation, then scp the result to this path.`,
    )
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(`[schwab-singleton] ${TOKEN_FILE} is not valid JSON: ${msg}`)
  }
  const obj = parsed as Partial<PersistedTokens>
  if (!obj || typeof obj.refreshToken !== 'string' || typeof obj.mintedAt !== 'string') {
    throw new Error(
      `[schwab-singleton] ${TOKEN_FILE} missing required fields (refreshToken, mintedAt).`,
    )
  }
  return { refreshToken: obj.refreshToken, mintedAt: obj.mintedAt }
}

async function writePersistedTokens(refreshToken: string): Promise<void> {
  const dir = path.dirname(TOKEN_FILE)
  await fs.mkdir(dir, { recursive: true })
  const payload: PersistedTokens = {
    refreshToken,
    mintedAt: new Date().toISOString(),
  }
  const tmp = `${TOKEN_FILE}.tmp`
  await fs.writeFile(tmp, JSON.stringify(payload, null, 2), { encoding: 'utf8', mode: 0o600 })
  await fs.rename(tmp, TOKEN_FILE)
}

class FilePersistTokenStore implements TokenStore {
  async onTokensRefreshed(tokens: SchwabTokens): Promise<void> {
    try {
      await writePersistedTokens(tokens.refreshToken)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[schwab-singleton] Failed to persist refreshed tokens: ${msg}`)
      // Don't rethrow — token rotation continues in-memory; on next restart we
      // just have to re-auth. Logging is sufficient.
    }
  }
}

async function bootBroker(): Promise<SchwabBroker> {
  const clientId = process.env.SCHWAB_CLIENT_ID
  const clientSecret = process.env.SCHWAB_CLIENT_SECRET
  const redirectUri = process.env.SCHWAB_REDIRECT_URI

  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error(
      `[schwab-singleton] Missing env: SCHWAB_CLIENT_ID, SCHWAB_CLIENT_SECRET, SCHWAB_REDIRECT_URI must all be set.`,
    )
  }

  const persisted = await readPersistedTokens()

  const broker = SchwabBroker.fromConfig({
    id: 'schwab',
    label: 'Charles Schwab',
    brokerConfig: {
      clientId,
      clientSecret,
      redirectUri,
      refreshToken: persisted.refreshToken,
      marketDataOnly: true,
    },
  })

  broker.setTokenStore(new FilePersistTokenStore())

  try {
    await broker.init()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    // BrokerError('AUTH') maps to refresh_token expiry — surface clearly.
    if (msg.includes('AUTH') || msg.toLowerCase().includes('refresh')) {
      console.error(
        `[schwab-singleton] Auth failed — refresh token expired. Run scripts/schwab-oauth.ts to mint a new one.`,
      )
    }
    throw err
  }
  return broker
}

/**
 * Return the singleton SchwabBroker, initializing on first call.
 *
 * Subsequent calls return the cached instance. If init fails, the failure
 * is cached as a rejected promise; the next call retries (since a one-time
 * network glitch shouldn't permanently disable the broker for the lifetime
 * of the process).
 */
export async function getSchwabBroker(): Promise<SchwabBroker> {
  if (cachedBroker) return cachedBroker
  if (initPromise) return initPromise

  initPromise = bootBroker().then(
    (broker) => {
      cachedBroker = broker
      initPromise = null
      return broker
    },
    (err) => {
      initPromise = null // allow retry on next call
      throw err
    },
  )
  return initPromise
}

/** Test-only: reset cached state. */
export function _resetSchwabSingleton(): void {
  cachedBroker = null
  initPromise = null
}

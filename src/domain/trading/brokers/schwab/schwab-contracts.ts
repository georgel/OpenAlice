/**
 * Schwab symbol ↔ IBKR Contract translation.
 *
 * Stocks: Schwab's symbol is the ticker (e.g., "AAPL"). 1:1 with Contract.symbol.
 *
 * Options: Schwab uses the OCC-21 format, padded:
 *   "AAPL  250117C00150000"
 *    ^^^^^^ ^^^^^^ ^^^^^^^^
 *    root   date   C/P+strike*1000 (8 digits)
 *
 * Date is YYMMDD. Right is C or P. Strike is strike_price * 1000 zero-padded to 8.
 */

import { Contract } from '@traderalice/ibkr'
import '../../contract-ext.js'

const OCC_SYMBOL_RE = /^(?<root>.{1,6})\s*(?<yy>\d{2})(?<mm>\d{2})(?<dd>\d{2})(?<right>[CP])(?<strike>\d{8})$/

/** Build an IBKR stock Contract from a Schwab ticker. */
export function makeStockContract(ticker: string): Contract {
  const c = new Contract()
  c.symbol = ticker.toUpperCase()
  c.secType = 'STK'
  c.exchange = 'SMART'
  c.currency = 'USD'
  return c
}

/** Build an IBKR option Contract from a Schwab OCC symbol. */
export function makeOptionContract(schwabSymbol: string): Contract | null {
  const m = schwabSymbol.replace(/\s+/g, '').padStart(21).replace(/^(.{6})(.{15})$/, '$1$2').match(OCC_SYMBOL_RE)
    ?? schwabSymbol.match(OCC_SYMBOL_RE)
  if (!m || !m.groups) return null
  const { root, yy, mm, dd, right, strike } = m.groups
  const c = new Contract()
  c.symbol = root.trim().toUpperCase()
  c.secType = 'OPT'
  c.exchange = 'SMART'
  c.currency = 'USD'
  c.right = right
  c.strike = parseInt(strike, 10) / 1000
  c.lastTradeDateOrContractMonth = `20${yy}${mm}${dd}`
  c.multiplier = '100'
  return c
}

/** Resolve any Contract back to the Schwab wire symbol, or null if unsupported. */
export function resolveSchwabSymbol(contract: Contract): string | null {
  if (!contract.symbol) return null
  const symbol = contract.symbol.toUpperCase()
  const secType = contract.secType || 'STK'

  if (secType === 'STK') return symbol

  if (secType === 'OPT') {
    if (!contract.lastTradeDateOrContractMonth || !contract.right || contract.strike === undefined) return null
    const d = contract.lastTradeDateOrContractMonth
    // Accept YYYYMMDD or YYMMDD.
    const yy = d.length === 8 ? d.slice(2, 4) : d.slice(0, 2)
    const mm = d.length === 8 ? d.slice(4, 6) : d.slice(2, 4)
    const dd = d.length === 8 ? d.slice(6, 8) : d.slice(4, 6)
    const strikeInt = Math.round(contract.strike * 1000).toString().padStart(8, '0')
    const root = symbol.padEnd(6, ' ')
    return `${root}${yy}${mm}${dd}${contract.right}${strikeInt}`
  }

  return null
}

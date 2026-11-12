/**
 * Money in ClaimKit is always an integer number of paise.
 *
 * Never a float. A claim is a reconciliation against a hospital bill, and
 * the whole point of the app is to tell a family that ₹6,400 is missing --
 * a number arrived at by subtraction. Binary floating point cannot
 * represent 0.1, so summing rupees as floats drifts, and a reconciliation
 * that drifts is worse than no reconciliation at all.
 */

export type Paise = number

export class MoneyError extends Error {}

/** Rupees as typed by a person ("2,46,900", "2460.50", "₹1200") to paise. */
export function parseRupees(input: string): Paise {
  const cleaned = input.replace(/[₹,\s]/g, '')
  if (cleaned === '') throw new MoneyError('Enter an amount')
  if (!/^-?\d+(\.\d{0,2})?$/.test(cleaned)) {
    throw new MoneyError('Enter an amount like 2460 or 2460.50')
  }
  const negative = cleaned.startsWith('-')
  const [whole, frac = ''] = cleaned.replace('-', '').split('.')
  const paise = Number(whole) * 100 + Number(frac.padEnd(2, '0'))
  if (!Number.isSafeInteger(paise)) throw new MoneyError('That amount is too large')
  return negative ? -paise : paise
}

/**
 * Paise to a displayable string, grouped the Indian way: 2,80,000 rather
 * than 280,000. Intl does this correctly for en-IN, so we do not
 * hand-roll the lakh/crore grouping.
 */
export function formatRupees(paise: Paise, options: { paise?: boolean } = {}): string {
  const showPaise = options.paise ?? paise % 100 !== 0
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    minimumFractionDigits: showPaise ? 2 : 0,
    maximumFractionDigits: showPaise ? 2 : 0,
  }).format(paise / 100)
}

/** Sums paise, refusing to silently overflow. */
export function sum(amounts: readonly Paise[]): Paise {
  const total = amounts.reduce((a, b) => a + b, 0)
  if (!Number.isSafeInteger(total)) throw new MoneyError('Total is too large to represent')
  return total
}

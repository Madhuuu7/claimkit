import { describe, expect, it } from 'vitest'
import { formatRupees, MoneyError, parseRupees, sum } from './money'

describe('parseRupees', () => {
  it('reads plain rupees', () => {
    expect(parseRupees('2460')).toBe(246000)
  })

  it('reads paise', () => {
    expect(parseRupees('2460.50')).toBe(246050)
    expect(parseRupees('0.05')).toBe(5)
  })

  it('pads a single decimal place, so .5 is fifty paise not five', () => {
    expect(parseRupees('10.5')).toBe(1050)
  })

  it('accepts what people actually type', () => {
    expect(parseRupees('₹2,46,900')).toBe(24690000)
    expect(parseRupees(' 1 200 ')).toBe(120000)
  })

  it.each(['', 'abc', '12.345', '1,2,3.4.5', '--5'])('rejects %o', (bad: string) => {
    expect(() => parseRupees(bad)).toThrow(MoneyError)
  })

  it('refuses amounts it cannot represent exactly', () => {
    expect(() => parseRupees('99999999999999999')).toThrow(MoneyError)
  })
})

describe('formatRupees', () => {
  it('groups the Indian way, not in thousands', () => {
    // 2,80,000 -- not 280,000. Getting this wrong is immediately visible
    // to every Indian user of the app.
    expect(formatRupees(28000000)).toBe('₹2,80,000')
    expect(formatRupees(1000000000)).toBe('₹1,00,00,000')
  })

  it('hides paise when there are none, shows them when there are', () => {
    expect(formatRupees(246000)).toBe('₹2,460')
    expect(formatRupees(246050)).toBe('₹2,460.50')
  })

  it('can be forced to show paise', () => {
    expect(formatRupees(246000, { paise: true })).toBe('₹2,460.00')
  })

  it('handles zero and negatives', () => {
    expect(formatRupees(0)).toBe('₹0')
    expect(formatRupees(-640000)).toBe('-₹6,400')
  })
})

describe('sum', () => {
  it('is exact where floating point rupees would drift', () => {
    // 0.1 + 0.2 !== 0.3 in binary floating point. In paise it is just
    // 10 + 20 === 30, which is the whole reason money is stored this way.
    expect(sum([10, 20])).toBe(30)
    expect(sum(Array.from({ length: 10 }, () => 10))).toBe(100)
  })

  it('is zero for nothing', () => {
    expect(sum([])).toBe(0)
  })

  it('refuses to silently lose precision', () => {
    expect(() => sum([Number.MAX_SAFE_INTEGER, 1])).toThrow(MoneyError)
  })
})

import { describe, expect, it } from 'vitest'
import {
  ALLOWED_TRANSITIONS,
  blockers,
  canTransition,
  completeness,
  daysRemaining,
  dueDate,
  isClosed,
  itemState,
  amountWithheld,
  deductionsTotal,
  settlementNote,
  unaccounted,
  unexplainedWithholding,
  uploadedTotal,
  type Claim,
  type ClaimStatus,
  type Settlement,
} from './claim'
import { demoClaim } from './demo'

const ALL_STATUSES: ClaimStatus[] = [
  'draft',
  'submitted',
  'query_raised',
  'query_resolved',
  'settled',
  'rejected',
]

describe('reconciliation', () => {
  it('totals only bills, never records', () => {
    // The demo has a signed claim form and a discharge summary. Neither
    // carries a rupee value, and counting them as zero must not change
    // the total.
    expect(uploadedTotal(demoClaim)).toBe(2_73_600_00)
  })

  it('reports the gap the insurer would query', () => {
    expect(unaccounted(demoClaim)).toBe(6_400_00)
  })

  it('reports a negative gap when uploads exceed the bill', () => {
    const over: Claim = { ...demoClaim, finalBillPaise: 2_00_000_00 }
    expect(unaccounted(over)).toBeLessThan(0)
    expect(blockers(over)[0].text).toContain('exceed the final bill')
  })

  it('is exact across many small bills', () => {
    const claim: Claim = {
      ...demoClaim,
      finalBillPaise: 1000,
      items: [
        {
          id: 'x',
          label: 'Pharmacy bills',
          kind: 'bill',
          expected: null,
          required: true,
          docs: Array.from({ length: 10 }, (_, i) => ({
            id: `p${i}`,
            name: `p${i}.jpg`,
            amountPaise: 100,
            uploadedBy: 'Madhura',
            uploadedAt: '2026-11-01T00:00:00Z',
          })),
        },
      ],
    }
    expect(unaccounted(claim)).toBe(0)
  })
})

describe('itemState', () => {
  const base = { id: 'i', label: 'l', kind: 'record' as const, required: true }

  it('is empty with no files', () => {
    expect(itemState({ ...base, expected: 1, docs: [] })).toBe('empty')
  })

  it('is partial below the expected count', () => {
    const docs = [
      { id: 'a', name: 'a', amountPaise: null, uploadedBy: 'M', uploadedAt: '' },
    ]
    expect(itemState({ ...base, expected: 3, docs })).toBe('partial')
  })

  it('is complete when the count is unknown but something was uploaded', () => {
    const docs = [
      { id: 'a', name: 'a', amountPaise: null, uploadedBy: 'M', uploadedAt: '' },
    ]
    expect(itemState({ ...base, expected: null, docs })).toBe('complete')
  })

  it('does not go partial again once the expected count is exceeded', () => {
    const docs = Array.from({ length: 4 }, (_, i) => ({
      id: `${i}`,
      name: `${i}`,
      amountPaise: null,
      uploadedBy: 'M',
      uploadedAt: '',
    }))
    expect(itemState({ ...base, expected: 3, docs })).toBe('complete')
  })
})

describe('completeness', () => {
  it('counts only required items', () => {
    const { done, total } = completeness(demoClaim)
    expect(total).toBe(9)
    expect(done).toBe(6)
  })

  it('ignores optional items entirely', () => {
    const claim: Claim = {
      ...demoClaim,
      items: [
        ...demoClaim.items,
        { id: 'opt', label: 'Nice to have', kind: 'record', expected: 1, required: false, docs: [] },
      ],
    }
    expect(completeness(claim).total).toBe(9)
  })
})

describe('daysRemaining', () => {
  it('counts from discharge plus the policy window, not from today', () => {
    // Discharged 19 Oct with a 30-day window means 18 November.
    expect(dueDate(demoClaim).toISOString().slice(0, 10)).toBe('2026-11-18')
  })

  it('is zero on the final day', () => {
    expect(daysRemaining(demoClaim, new Date('2026-11-18T23:00:00'))).toBe(0)
  })

  it('goes negative once the window has closed', () => {
    expect(daysRemaining(demoClaim, new Date('2026-11-21T09:00:00'))).toBe(-3)
  })

  it('does not drift across a daylight-saving style time jump', () => {
    const morning = daysRemaining(demoClaim, new Date('2026-11-12T00:30:00'))
    const evening = daysRemaining(demoClaim, new Date('2026-11-12T23:30:00'))
    expect(morning).toBe(evening)
  })

  it('uses the window the family entered, never a hardcoded one', () => {
    const shortPolicy: Claim = { ...demoClaim, submissionWindowDays: 7 }
    expect(dueDate(shortPolicy).toISOString().slice(0, 10)).toBe('2026-10-26')
  })

  it('lands on the same calendar date whatever the machine timezone', () => {
    // Regression: the first version read a UTC-parsed date back with
    // local getters, which moved the deadline a day earlier for anyone
    // behind UTC. Asserting on UTC parts pins the arithmetic.
    const due = dueDate(demoClaim)
    expect([due.getUTCFullYear(), due.getUTCMonth(), due.getUTCDate()]).toEqual([
      2026, 10, 18,
    ])
    expect(due.getUTCHours()).toBe(0)
  })

  it('rolls over month ends correctly', () => {
    const claim: Claim = { ...demoClaim, dischargedOn: '2026-12-20', submissionWindowDays: 30 }
    expect(dueDate(claim).toISOString().slice(0, 10)).toBe('2027-01-19')
  })

  it('handles a leap day in the window', () => {
    const claim: Claim = { ...demoClaim, dischargedOn: '2028-02-20', submissionWindowDays: 10 }
    expect(dueDate(claim).toISOString().slice(0, 10)).toBe('2028-03-01')
  })
})

describe('status transitions', () => {
  it('cannot settle a claim that was never submitted', () => {
    expect(canTransition('draft', 'settled')).toBe(false)
  })

  it('allows the ordinary path', () => {
    expect(canTransition('draft', 'submitted')).toBe(true)
    expect(canTransition('submitted', 'query_raised')).toBe(true)
    expect(canTransition('query_raised', 'query_resolved')).toBe(true)
    expect(canTransition('query_resolved', 'settled')).toBe(true)
  })

  it('allows a second query after one was resolved', () => {
    expect(canTransition('query_resolved', 'query_raised')).toBe(true)
  })

  it('treats settled and rejected as final', () => {
    for (const to of ALL_STATUSES) {
      expect(canTransition('settled', to)).toBe(false)
      expect(canTransition('rejected', to)).toBe(false)
    }
  })

  it('closes exactly the statuses nothing leads out of', () => {
    expect(isClosed('settled')).toBe(true)
    expect(isClosed('rejected')).toBe(true)
    for (const s of ALL_STATUSES) {
      if (s === 'settled' || s === 'rejected') continue
      expect(isClosed(s)).toBe(false)
    }
  })

  it('never allows a status to transition to itself', () => {
    for (const s of ALL_STATUSES) expect(canTransition(s, s)).toBe(false)
  })

  it('names only real statuses as targets', () => {
    for (const targets of Object.values(ALLOWED_TRANSITIONS)) {
      for (const t of targets) expect(ALL_STATUSES).toContain(t)
    }
  })
})

describe('blockers', () => {
  it('puts the money gap first, because that is what cuts a payout', () => {
    expect(blockers(demoClaim)[0].kind).toBe('gap')
  })

  it('names every required item that is missing or short', () => {
    const texts = blockers(demoClaim).map((b) => b.text)
    expect(texts.some((t) => t.includes('Cancelled cheque'))).toBe(true)
    expect(texts.some((t) => t.includes('Pharmacy bills: 3 of 5'))).toBe(true)
  })

  it('says nothing at all about a claim that is ready', () => {
    const ready: Claim = {
      ...demoClaim,
      finalBillPaise: uploadedTotal(demoClaim),
      items: demoClaim.items.map((i) => ({
        ...i,
        expected: i.docs.length || 1,
        docs: i.docs.length
          ? i.docs
          : [{ id: `f-${i.id}`, name: 'f', amountPaise: null, uploadedBy: 'M', uploadedAt: '' }],
      })),
    }
    expect(blockers(ready)).toEqual([])
  })
})

describe('settlement', () => {
  const settled = (
    settledAmountPaise: number,
    deductions: { amountPaise: number; reason: string }[] = [],
  ): Settlement => ({
    settledAmountPaise,
    settledAt: '2026-11-20T09:00:00Z',
    deductions: deductions.map((d, i) => ({ id: `d${i}`, ...d })),
  })

  // The demo claim's final bill.
  const bill = demoClaim.finalBillPaise

  it('reports what the insurer kept', () => {
    expect(amountWithheld(demoClaim, settled(bill - 18_000_00))).toBe(18_000_00)
  })

  it('subtracts the reasons the insurer was willing to give', () => {
    const s = settled(bill - 18_000_00, [
      { amountPaise: 12_000_00, reason: 'Non-medical consumables' },
      { amountPaise: 2_000_00, reason: 'Room rent above eligibility' },
    ])
    expect(deductionsTotal(s)).toBe(14_000_00)
    // The whole point of recording the letter: four thousand rupees
    // left this claim with nothing written against it.
    expect(unexplainedWithholding(demoClaim, s)).toBe(4_000_00)
    expect(settlementNote(demoClaim, s)).toContain('₹4,000')
  })

  it('says so when every rupee withheld was explained', () => {
    const s = settled(bill - 5_000_00, [{ amountPaise: 5_000_00, reason: 'Consumables' }])
    expect(unexplainedWithholding(demoClaim, s)).toBe(0)
    expect(settlementNote(demoClaim, s)).toContain('accounted for')
  })

  it('says so when nothing was withheld at all', () => {
    expect(settlementNote(demoClaim, settled(bill))).toBe(
      'settled in full, with nothing withheld',
    )
  })

  it('reports reasons that overshoot what was actually withheld', () => {
    // Not an error. A deduction the insurer later waived, or one counted
    // twice, reads exactly like this, and both are worth querying.
    const s = settled(bill - 1_000_00, [{ amountPaise: 3_000_00, reason: 'Consumables' }])
    expect(unexplainedWithholding(demoClaim, s)).toBe(-2_000_00)
    expect(settlementNote(demoClaim, s)).toContain('add up to ₹2,000 more')
  })

  it('is exact across a letter full of small deductions', () => {
    // The reason money is paise and never a float: thirty deductions of
    // ₹33.33 summed as rupees drift, and a reconciliation that drifts
    // invents a grievance that is not there.
    const each = 33_33
    const s = settled(
      bill - each * 30,
      Array.from({ length: 30 }, () => ({ amountPaise: each, reason: 'Consumables' })),
    )
    expect(unexplainedWithholding(demoClaim, s)).toBe(0)
  })
})

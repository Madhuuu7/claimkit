import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { Suspense } from 'react'
import { Account } from '@/components/Account'
import { SettlementForm } from '@/components/SettlementForm'
import {
  amountWithheld,
  deductionsTotal,
  settlementNote,
  unexplainedWithholding,
  STATUS_LABEL,
} from '@/lib/claim'
import { currentUser } from '@/lib/auth'
import { ClaimNotFound, getClaim, membershipOf, toClientClaim } from '@/lib/claims'
import { formatRupees } from '@/lib/money'

export const metadata: Metadata = { title: 'Settlement · ClaimKit' }

type Params = { params: Promise<{ id: string }> }

/**
 * What the insurer actually paid.
 *
 * A server-rendered page rather than part of the offline sheet, on
 * purpose. Everything on the sheet is the family editing their own claim
 * from a corridor; this is one person transcribing a letter that arrived
 * in the post, and they can do it with signal. It is also the only screen
 * in the app that is owner-only.
 */
export default function SettlementPage({ params }: Params) {
  return (
    <main className="mx-auto w-full max-w-[52rem] px-5 pb-24 sm:px-8">
      <header className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-6 text-[0.82rem]">
        <span className="font-serif text-[1.05rem] text-ink">ClaimKit</span>
        <Suspense fallback={<span className="text-ink-faint">&nbsp;</span>}>
          <Account />
        </Suspense>
      </header>

      <Suspense fallback={<p className="py-10 text-ink-faint">Opening the claim</p>}>
        <Settlement params={params} />
      </Suspense>
    </main>
  )
}

async function load(userId: string, claimId: string) {
  try {
    const detail = await getClaim(userId, claimId)
    const member = await membershipOf(userId, claimId)
    return { claim: toClientClaim(detail), role: member?.role ?? 'CONTRIBUTOR' }
  } catch (error) {
    if (error instanceof ClaimNotFound) return null
    throw error
  }
}

async function Settlement({ params }: Params) {
  const { id } = await params
  const user = await currentUser()
  if (!user) notFound()

  const loaded = await load(user.id, id)
  if (!loaded) notFound()

  const { claim, role } = loaded
  const { settlement } = claim

  return (
    <>
      <nav className="text-[0.85rem]">
        <Link className="text-teal underline decoration-rule" href={`/claims/${id}`}>
          {claim.patientName}
        </Link>
        <span className="text-ink-faint"> · {STATUS_LABEL[claim.status]}</span>
      </nav>

      <h1 className="claim-title mt-3">Settlement</h1>

      {settlement ? (
        <section className="sheet mt-6 px-6 py-7 sm:px-9">
          <p className="text-[0.82rem] text-ink-soft">The insurer paid</p>
          <p className="figure mt-1 text-[clamp(2.2rem,1.4rem+2.6vw,3rem)]">
            {formatRupees(settlement.settledAmountPaise)}
          </p>
          <p className="mt-2 max-w-[28rem] text-ink-soft">
            {settlementNote(claim, settlement)}
          </p>

          <hr className="my-7 border-0 border-t border-rule" />

          <table className="ledger">
            <thead>
              <tr>
                <th scope="col">Deduction</th>
                <th scope="col" className="num">
                  Amount
                </th>
              </tr>
            </thead>
            <tbody>
              {settlement.deductions.length === 0 && (
                <tr>
                  <td className="text-ink-faint">
                    The letter named no deductions at all
                  </td>
                  <td className="num text-ink-faint">&mdash;</td>
                </tr>
              )}
              {settlement.deductions.map((deduction) => (
                <tr key={deduction.id}>
                  <td>{deduction.reason}</td>
                  <td className="num money">{formatRupees(deduction.amountPaise)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <dl className="mt-6 space-y-1.5 text-[0.92rem]">
            <Line label="Final hospital bill" value={formatRupees(claim.finalBillPaise)} />
            <Line label="Withheld" value={formatRupees(amountWithheld(claim, settlement))} />
            <Line
              label="Explained by deductions"
              value={formatRupees(deductionsTotal(settlement))}
            />
            {/* The figure the whole page exists to produce, and the only
                one allowed to be loud. */}
            <Line
              label="With no reason against it"
              value={formatRupees(unexplainedWithholding(claim, settlement))}
              loud={unexplainedWithholding(claim, settlement) !== 0}
            />
          </dl>
        </section>
      ) : (
        <p className="mt-4 max-w-[34rem] text-ink-soft">
          Nothing recorded yet. When the insurer&rsquo;s letter arrives, put the settled
          figure and its deductions here and ClaimKit will tell you how much of the
          shortfall they never explained.
        </p>
      )}

      {role === 'OWNER' ? (
        <section className="mt-12">
          <h2 className="section-heading">
            {settlement ? 'Correct the letter' : 'From the letter'}
          </h2>
          <SettlementForm
            claimId={id}
            settlement={settlement ?? null}
            finalBillPaise={claim.finalBillPaise}
          />
        </section>
      ) : (
        <p className="mt-10 text-[0.85rem] text-ink-faint">
          Only the person who started this claim can record what the insurer paid.
        </p>
      )}
    </>
  )
}

function Line({
  label,
  value,
  loud = false,
}: {
  label: string
  value: string
  loud?: boolean
}) {
  return (
    <div className="flex justify-between gap-6">
      <dt className="text-ink-soft">{label}</dt>
      <dd className={`money ${loud ? 'text-amber' : ''}`}>{value}</dd>
    </div>
  )
}

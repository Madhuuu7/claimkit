import { connection } from 'next/server'
import { daysRemaining, dueDate, isClosed, type Claim } from '@/lib/claim'

function longDate(d: Date) {
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'long' })
}

/**
 * Once the insurer has answered, the window is history.
 *
 * A settled claim that still reads "5 days left to submit" is telling
 * the family to hurry about something that is over. The claims list has
 * always gone quiet at this point; the sheet says so too now, and in
 * the past tense, because the date is still worth seeing on a claim
 * someone is reading back later.
 */
function Closed({ claim }: { claim: Claim }) {
  return (
    <span className="text-ink-faint">
      The submission window closed on {longDate(dueDate(claim))}
    </span>
  )
}

/**
 * The due date depends only on the claim, so it prerenders with the rest
 * of the sheet and is visible immediately.
 */
export function DeadlineFallback({ claim }: { claim: Claim }) {
  if (isClosed(claim.status)) return <Closed claim={claim} />
  return <>Submit by {longDate(dueDate(claim))}</>
}

/**
 * The countdown depends on "now", which cannot be baked into a build --
 * a prerendered claim would keep insisting there were 26 days left for as
 * long as the deployment lived. connection() holds this one line until
 * there is a real request; everything around it is still static.
 */
export async function DeadlineCountdown({ claim }: { claim: Claim }) {
  // A closed claim needs no clock, so it does not wait for a request
  // either: this branch stays in the prerendered shell.
  if (isClosed(claim.status)) return <Closed claim={claim} />

  await connection()
  const days = daysRemaining(claim)

  if (days < 0) {
    const late = -days
    return (
      <span className="text-amber">
        The submission window closed{' '}
        <span className="tnum font-medium">{late}</span>{' '}
        {late === 1 ? 'day' : 'days'} ago
      </span>
    )
  }

  if (days === 0) {
    return <span className="text-amber">Today is the last day to submit</span>
  }

  return (
    <span className={days <= 7 ? 'text-amber' : undefined}>
      <span className="tnum font-medium">{days}</span> {days === 1 ? 'day' : 'days'} left
      to submit, by {longDate(dueDate(claim))}
    </span>
  )
}

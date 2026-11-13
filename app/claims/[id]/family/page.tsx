import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { Suspense } from 'react'
import { Account } from '@/components/Account'
import { InviteLink, NewInvite, RemoveMember } from '@/components/Family'
import { currentUser } from '@/lib/auth'
import {
  ClaimNotFound,
  getClaim,
  listInvites,
  listMembers,
  membershipOf,
  type InviteSummary,
  type MemberSummary,
} from '@/lib/claims'

export const metadata: Metadata = { title: 'Family · ClaimKit' }

type Params = { params: Promise<{ id: string }> }

/**
 * Who is on this claim, and how someone else gets on it.
 *
 * Server-rendered and outside the offline engine, like the settlement:
 * membership is not something two phones edit between themselves, and
 * an invite link made offline would be a link to nothing.
 *
 * Everyone in the family can see who else is here -- it is their
 * father's hospital bill too. Only the owner sees the links or can take
 * anyone off.
 */
export default function FamilyPage({ params }: Params) {
  return (
    <main className="mx-auto w-full max-w-[52rem] px-5 pb-24 sm:px-8">
      <header className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-6 text-[0.82rem]">
        <span className="font-serif text-[1.05rem] text-ink">ClaimKit</span>
        <Suspense fallback={<span className="text-ink-faint">&nbsp;</span>}>
          <Account />
        </Suspense>
      </header>

      <Suspense fallback={<p className="py-10 text-ink-faint">Opening the claim</p>}>
        <Family params={params} />
      </Suspense>
    </main>
  )
}

async function load(userId: string, claimId: string) {
  try {
    const member = await membershipOf(userId, claimId)
    if (!member) throw new ClaimNotFound()
    const claim = await getClaim(userId, claimId)
    const members = await listMembers(userId, claimId)
    // Owner only, so a contributor's page never holds a token at all --
    // not hidden with CSS, not sent and not rendered.
    const invites = member.role === 'OWNER' ? await listInvites(userId, claimId) : []
    return { claim, members, invites, role: member.role }
  } catch (error) {
    if (error instanceof ClaimNotFound) return null
    throw error
  }
}

function longDate(date: Date): string {
  return date.toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  })
}

async function Family({ params }: Params) {
  const { id } = await params
  const user = await currentUser()
  if (!user) notFound()

  const loaded = await load(user.id, id)
  if (!loaded) notFound()

  const { claim, members, invites, role } = loaded
  const isOwner = role === 'OWNER'
  const live = invites.filter((invite) => invite.live)
  const spent = invites.filter((invite) => !invite.live)

  return (
    <>
      <nav className="text-[0.85rem]">
        <Link className="text-teal underline decoration-rule" href={`/claims/${id}`}>
          {claim.patientName}
        </Link>
      </nav>

      <h1 className="claim-title mt-3">The family</h1>
      <p className="mt-3 max-w-[34rem] text-ink-soft">
        Everyone here can add files to this claim and tick things off, from their own
        phone, with or without signal.
      </p>

      <section className="mt-9">
        <h2 className="section-heading mb-4">On this claim</h2>
        <ul className="divide-y divide-rule-soft border-y border-rule">
          {members.map((member) => (
            <li key={member.userId} className="py-4">
              <Member
                member={member}
                claimId={id}
                isOwner={isOwner}
                isYou={member.userId === user.id}
              />
            </li>
          ))}
        </ul>
      </section>

      {isOwner ? (
        <section className="mt-12">
          <h2 className="section-heading">Invite someone</h2>
          <p className="mt-2 max-w-[34rem] text-ink-soft">
            A link, good for fourteen days. Whoever opens it signs in with Google and
            joins this claim, so send it to the person and not to a group.
          </p>

          <div className="mt-5">
            <NewInvite claimId={id} />
          </div>

          {live.length > 0 && (
            <ul className="mt-7 space-y-4">
              {live.map((invite) => (
                <li key={invite.id}>
                  <InviteLink
                    claimId={id}
                    inviteId={invite.id}
                    token={invite.token}
                    live
                  />
                  <p className="mt-1.5 text-[0.8rem] text-ink-faint">
                    Made {longDate(invite.createdAt)} · works until{' '}
                    {longDate(invite.expiresAt)}
                  </p>
                </li>
              ))}
            </ul>
          )}

          {spent.length > 0 && (
            <details className="mt-8">
              <summary className="cursor-pointer text-[0.85rem] text-ink-faint">
                {spent.length} link{spent.length === 1 ? '' : 's'} no longer working
              </summary>
              {/* Kept visible rather than forgotten: a revoked link may
                  still be sitting in a family chat, and the owner needs
                  to be able to recognise it when someone says it is
                  broken. */}
              <ul className="mt-3 space-y-2">
                {spent.map((invite) => (
                  <li key={invite.id} className="text-[0.82rem] text-ink-faint">
                    <code className="break-all">/join/{invite.token.slice(0, 12)}…</code>{' '}
                    {reasonSpent(invite)}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </section>
      ) : (
        <p className="mt-10 text-[0.85rem] text-ink-faint">
          Only the person who started this claim can invite anyone else or take someone
          off it.
        </p>
      )}
    </>
  )
}

function reasonSpent(invite: InviteSummary): string {
  return invite.revokedAt
    ? `revoked ${longDate(invite.revokedAt)}`
    : `expired ${longDate(invite.expiresAt)}`
}

function Member({
  member,
  claimId,
  isOwner,
  isYou,
}: {
  member: MemberSummary
  claimId: string
  isOwner: boolean
  isYou: boolean
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-x-5 gap-y-2">
      <div className="min-w-0">
        <p>
          {member.name}
          {isYou && <span className="text-ink-faint"> · you</span>}
        </p>
        <p className="mt-0.5 text-[0.85rem] text-ink-soft">
          {member.role === 'OWNER' ? 'Started this claim' : 'Can add to this claim'}
          <span className="text-ink-faint">
            {' · '}
            {member.documentCount === 0
              ? 'no files yet'
              : `${member.documentCount} ${member.documentCount === 1 ? 'file' : 'files'}`}
            {' · joined '}
            {longDate(member.joinedAt)}
          </span>
        </p>
      </div>

      {/* The owner cannot be removed, including by themselves: a claim
          with no owner can never be invited to or settled again. */}
      {isOwner && member.role !== 'OWNER' && (
        <div className="shrink-0 basis-full sm:basis-auto sm:text-right">
          <RemoveMember
            claimId={claimId}
            memberUserId={member.userId}
            name={member.name}
            documentCount={member.documentCount}
          />
        </div>
      )}
    </div>
  )
}

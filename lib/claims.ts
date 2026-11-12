import 'server-only'
import { randomBytes } from 'node:crypto'
import type { Claim as ClientClaim, ClaimStatus as ClientStatus } from './claim'
import { prisma } from './db'
import type { ClaimStatus, MemberRole } from './generated/prisma/enums'
import type { Prisma } from './generated/prisma/client'
import type { CreateClaimInput } from './schemas'
import { DEFAULT_CHECKLIST } from './template'

/**
 * The data access layer.
 *
 * Every function here takes the id of the person asking, and every query
 * is scoped by their membership of the claim. No route, action or page
 * builds its own query, which is what makes "a user must never see
 * another family's claim" structural instead of something ten different
 * handlers each have to remember.
 *
 * A non-member is told the claim does not exist, rather than that they
 * are not allowed to see it. Confirming that a claim id is real is
 * itself a leak: it would turn a stolen link into proof that someone in
 * the family is making a claim.
 */

export class ClaimNotFound extends Error {
  constructor() {
    super('That claim does not exist, or you are not a member of it')
    this.name = 'ClaimNotFound'
  }
}

export class NotPermitted extends Error {
  constructor(message = 'Only the owner can do that') {
    super(message)
    this.name = 'NotPermitted'
  }
}

export class InviteInvalid extends Error {
  constructor(message = 'That invite link is no longer valid') {
    super(message)
    this.name = 'InviteInvalid'
  }
}

/* ------------------------------------------------------------------ *
 * Membership
 * ------------------------------------------------------------------ */

export async function membershipOf(
  userId: string,
  claimId: string,
): Promise<{ role: MemberRole } | null> {
  // The compound unique index on (claimId, userId) makes this one lookup
  // the whole authorisation check, which is why it is an index and not
  // just a constraint.
  const member = await prisma.claimMember.findUnique({
    where: { claimId_userId: { claimId, userId } },
    select: { role: true },
  })
  return member
}

export async function requireMembership(
  userId: string,
  claimId: string,
): Promise<{ role: MemberRole }> {
  const member = await membershipOf(userId, claimId)
  if (!member) throw new ClaimNotFound()
  return member
}

export async function requireOwner(userId: string, claimId: string): Promise<void> {
  const member = await requireMembership(userId, claimId)
  if (member.role !== 'OWNER') throw new NotPermitted()
}

/* ------------------------------------------------------------------ *
 * Reading
 * ------------------------------------------------------------------ */

const claimDetail = {
  members: {
    orderBy: { joinedAt: 'asc' },
    include: { user: { select: { id: true, name: true, email: true, image: true } } },
  },
  items: {
    orderBy: { position: 'asc' },
    include: {
      documents: {
        orderBy: { uploadedAt: 'asc' },
        include: { uploadedBy: { select: { name: true, email: true } } },
      },
    },
  },
  deductions: true,
} satisfies Prisma.ClaimInclude

export type ClaimDetail = Prisma.ClaimGetPayload<{ include: typeof claimDetail }>

/** One claim, if this person is in the family. */
export async function getClaim(userId: string, claimId: string): Promise<ClaimDetail> {
  // Membership is part of the query rather than a check before it: there
  // is no window in which the wrong claim has been loaded.
  const claim = await prisma.claim.findFirst({
    where: { id: claimId, members: { some: { userId } } },
    include: claimDetail,
  })
  if (!claim) throw new ClaimNotFound()
  return claim
}

export type ClaimSummary = {
  id: string
  patientName: string
  hospital: string
  dischargedOn: Date
  submissionWindowDays: number
  finalBillPaise: number
  uploadedPaise: number
  status: ClaimStatus
  role: MemberRole
  isSample: boolean
  memberCount: number
  documentCount: number
}

/** Everything this person is a member of, most recent stay first. */
export async function listClaims(userId: string): Promise<ClaimSummary[]> {
  const rows = await prisma.claim.findMany({
    where: { members: { some: { userId } } },
    orderBy: { dischargedOn: 'desc' },
    include: {
      members: { where: { userId }, select: { role: true } },
      _count: { select: { members: true, documents: true } },
      documents: { select: { amountPaise: true } },
    },
  })

  return rows.map((claim) => ({
    id: claim.id,
    patientName: claim.patientName,
    hospital: claim.hospital,
    dischargedOn: claim.dischargedOn,
    submissionWindowDays: claim.submissionWindowDays,
    finalBillPaise: claim.finalBillPaise,
    // Summed here rather than in Postgres because the list is a handful
    // of rows per person; an aggregate per claim would be more SQL for
    // no measurable gain.
    uploadedPaise: claim.documents.reduce((total, doc) => total + (doc.amountPaise ?? 0), 0),
    status: claim.status,
    role: claim.members[0]?.role ?? 'CONTRIBUTOR',
    isSample: claim.isSample,
    memberCount: claim._count.members,
    documentCount: claim._count.documents,
  }))
}

/* ------------------------------------------------------------------ *
 * Writing
 * ------------------------------------------------------------------ */

export async function createClaim(
  userId: string,
  input: CreateClaimInput,
  options: { isSample?: boolean } = {},
): Promise<{ id: string }> {
  // One transaction: a claim with no owner, or with no checklist, is
  // worse than no claim at all -- the first is unreachable and the
  // second looks finished.
  return prisma.$transaction(async (tx) => {
    const claim = await tx.claim.create({
      data: {
        patientName: input.patientName,
        hospital: input.hospital,
        admittedOn: new Date(`${input.admittedOn}T00:00:00Z`),
        dischargedOn: new Date(`${input.dischargedOn}T00:00:00Z`),
        finalBillPaise: input.finalBillPaise,
        submissionWindowDays: input.submissionWindowDays,
        isSample: options.isSample ?? false,
        createdById: userId,
        members: { create: { userId, role: 'OWNER' } },
        items: {
          create: DEFAULT_CHECKLIST.map((item, index) => ({
            label: item.label,
            kind: item.kind,
            expected: item.expected,
            required: item.required,
            position: index,
          })),
        },
        statusEvents: { create: { from: null, to: 'DRAFT', byId: userId } },
      },
      select: { id: true, patientName: true },
    })

    await tx.activityLog.create({
      data: {
        claimId: claim.id,
        actorId: userId,
        kind: 'claim.created',
        summary: `started the claim for ${claim.patientName}`,
      },
    })

    return { id: claim.id }
  })
}

/* ------------------------------------------------------------------ *
 * Invites
 * ------------------------------------------------------------------ */

const INVITE_DAYS = 14

export async function createInvite(
  userId: string,
  claimId: string,
): Promise<{ token: string; expiresAt: Date }> {
  await requireOwner(userId, claimId)

  // 32 random bytes, not a claim id and not a counter: the link is the
  // only thing standing between a stranger and a family's medical bills,
  // so it has to be unguessable even to someone who has seen another one.
  const token = randomBytes(32).toString('base64url')
  const expiresAt = new Date(Date.now() + INVITE_DAYS * 86_400_000)

  await prisma.invite.create({ data: { token, claimId, createdById: userId, expiresAt } })
  return { token, expiresAt }
}

export async function revokeInvite(userId: string, inviteId: string): Promise<void> {
  const invite = await prisma.invite.findUnique({
    where: { id: inviteId },
    select: { claimId: true },
  })
  if (!invite) throw new InviteInvalid()
  await requireOwner(userId, invite.claimId)
  await prisma.invite.update({ where: { id: inviteId }, data: { revokedAt: new Date() } })
}

/**
 * Join by link. Signed in already -- the link gets you into a family, it
 * does not get you past the front door.
 */
export async function acceptInvite(
  userId: string,
  token: string,
): Promise<{ claimId: string; alreadyMember: boolean }> {
  const invite = await prisma.invite.findUnique({
    where: { token },
    select: { claimId: true, expiresAt: true, revokedAt: true },
  })

  if (!invite || invite.revokedAt || invite.expiresAt < new Date()) throw new InviteInvalid()

  const existing = await membershipOf(userId, invite.claimId)
  if (existing) return { claimId: invite.claimId, alreadyMember: true }

  await prisma.$transaction(async (tx) => {
    await tx.claimMember.create({
      data: { claimId: invite.claimId, userId, role: 'CONTRIBUTOR' },
    })
    const user = await tx.user.findUnique({ where: { id: userId }, select: { name: true, email: true } })
    await tx.activityLog.create({
      data: {
        claimId: invite.claimId,
        actorId: userId,
        kind: 'member.joined',
        summary: `${user?.name ?? user?.email ?? 'Someone'} joined the claim`,
      },
    })
  })

  return { claimId: invite.claimId, alreadyMember: false }
}

export async function removeMember(
  userId: string,
  claimId: string,
  memberUserId: string,
): Promise<void> {
  await requireOwner(userId, claimId)

  const target = await prisma.claimMember.findUnique({
    where: { claimId_userId: { claimId, userId: memberUserId } },
    select: { role: true, user: { select: { name: true, email: true } } },
  })
  if (!target) throw new ClaimNotFound()
  // An owner removing themselves would leave a claim nobody can invite
  // to, rename, or settle.
  if (target.role === 'OWNER') throw new NotPermitted('The owner cannot be removed')

  await prisma.$transaction(async (tx) => {
    await tx.claimMember.delete({ where: { claimId_userId: { claimId, userId: memberUserId } } })
    // Their sessions are rows, so access ends now rather than whenever a
    // token would have expired.
    await tx.session.deleteMany({ where: { userId: memberUserId } })
    await tx.activityLog.create({
      data: {
        claimId,
        actorId: userId,
        kind: 'member.removed',
        summary: `removed ${target.user.name ?? target.user.email ?? 'a member'} from the claim`,
      },
    })
  })
}

/* ------------------------------------------------------------------ *
 * To the client's shape
 * ------------------------------------------------------------------ */

const STATUS_TO_CLIENT: Record<ClaimStatus, ClientStatus> = {
  DRAFT: 'draft',
  SUBMITTED: 'submitted',
  QUERY_RAISED: 'query_raised',
  QUERY_RESOLVED: 'query_resolved',
  SETTLED: 'settled',
  REJECTED: 'rejected',
}

export const STATUS_FROM_CLIENT: Record<ClientStatus, ClaimStatus> = {
  draft: 'DRAFT',
  submitted: 'SUBMITTED',
  query_raised: 'QUERY_RAISED',
  query_resolved: 'QUERY_RESOLVED',
  settled: 'SETTLED',
  rejected: 'REJECTED',
}

function initialsOf(name: string | null, email: string | null): string {
  const source = name?.trim() || email?.trim() || '?'
  return source[0]!.toUpperCase()
}

/** A date column as the `YYYY-MM-DD` string the domain rules expect. */
function day(date: Date): string {
  return date.toISOString().slice(0, 10)
}

/**
 * The row shape the offline client already understands.
 *
 * This is the snapshot a phone replays its outbox over, so it is the one
 * place the database's vocabulary is translated into the domain's: the
 * engine, the replay and every rule in lib/claim.ts stay unaware that
 * Postgres exists.
 */
export function toClientClaim(claim: ClaimDetail): ClientClaim {
  return {
    id: claim.id,
    patientName: claim.patientName,
    hospital: claim.hospital,
    admittedOn: day(claim.admittedOn),
    dischargedOn: day(claim.dischargedOn),
    finalBillPaise: claim.finalBillPaise,
    submissionWindowDays: claim.submissionWindowDays,
    status: STATUS_TO_CLIENT[claim.status],
    members: claim.members.map((member) => ({
      id: member.user.id,
      name: member.user.name ?? member.user.email ?? 'A family member',
      initials: initialsOf(member.user.name, member.user.email),
    })),
    items: claim.items.map((item) => ({
      id: item.id,
      label: item.label,
      kind: item.kind === 'BILL' ? 'bill' : 'record',
      expected: item.expected,
      required: item.required,
      markedDone: item.markedDone,
      docs: item.documents.map((doc) => ({
        id: doc.id,
        name: doc.name,
        amountPaise: doc.amountPaise,
        uploadedBy: doc.uploadedBy.name ?? doc.uploadedBy.email ?? 'A family member',
        uploadedAt: doc.uploadedAt.toISOString(),
      })),
    })),
  }
}

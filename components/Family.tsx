'use client'

import { useActionState, useState } from 'react'
import {
  createInviteAction,
  removeMemberAction,
  revokeInviteAction,
  type ActionResult,
} from '@/app/actions'

/**
 * The family screen's moving parts.
 *
 * Three buttons, and the only interesting thing about any of them is
 * that two are destructive and one hands out access to a hospital bill.
 * So: revoking and removing both ask once, inline, in words rather than
 * a dialog -- and the invite link is never shown as a bare token to
 * copy by hand, because a link copied short is a link that does not
 * work and a family member left outside the claim.
 */

/* ------------------------------------------------------------------ *
 * Inviting
 * ------------------------------------------------------------------ */

export function NewInvite({ claimId }: { claimId: string }) {
  const [result, create, pending] = useActionState<ActionResult | null, FormData>(
    async () => createInviteAction(claimId),
    null,
  )

  return (
    <form action={create}>
      <button className="btn" type="submit" disabled={pending}>
        {pending ? 'Making a link' : 'Make an invite link'}
      </button>
      {result && 'error' in result && (
        <p className="mt-3 text-[0.88rem] text-amber">{result.error}</p>
      )}
    </form>
  )
}

/**
 * One link.
 */
export function InviteLink({
  claimId,
  inviteId,
  token,
  live,
}: {
  claimId: string
  inviteId: string
  token: string
  live: boolean
}) {
  const [copied, setCopied] = useState(false)

  // Shown as a path and copied as a URL. The absolute form is resolved
  // at the moment of the click, against the origin the page is actually
  // being read in, so there is no base URL to configure, nothing to
  // get wrong between localhost and the deployment, and no server and
  // client rendering the same link differently.
  const path = `/join/${token}`

  async function copy() {
    try {
      await navigator.clipboard.writeText(new URL(path, window.location.href).toString())
      setCopied(true)
      // Long enough to read, short enough that the button is ready again
      // before anyone reaches for it twice.
      setTimeout(() => setCopied(false), 2500)
    } catch {
      // Clipboard access can be refused outright, and a button that
      // claims to have copied when it has not is worse than one that
      // says nothing. The link is on screen either way.
      setCopied(false)
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
      <code className="min-w-0 flex-1 truncate rounded bg-paper-sunk px-2.5 py-1.5 text-[0.8rem] text-ink-soft">
        {path}
      </code>
      {live && (
        <>
          <button
            type="button"
            className="btn btn-quiet shrink-0 py-1.5 text-[0.85rem]"
            onClick={copy}
          >
            {copied ? 'Copied' : 'Copy'}
          </button>
          <RevokeInvite claimId={claimId} inviteId={inviteId} />
        </>
      )}
    </div>
  )
}

function RevokeInvite({ claimId, inviteId }: { claimId: string; inviteId: string }) {
  const [result, revoke, pending] = useActionState<ActionResult | null, FormData>(
    async () => revokeInviteAction(claimId, inviteId),
    null,
  )
  const [confirming, setConfirming] = useState(false)

  if (!confirming) {
    return (
      <button
        type="button"
        className="shrink-0 text-[0.82rem] text-ink-faint underline decoration-rule hover:text-ink"
        onClick={() => setConfirming(true)}
      >
        Revoke
      </button>
    )
  }

  return (
    <form action={revoke} className="flex shrink-0 items-center gap-3 text-[0.82rem]">
      <span className="text-ink-soft">Anyone holding it loses the claim.</span>
      <button type="submit" className="text-amber underline" disabled={pending}>
        {pending ? 'Revoking' : 'Revoke it'}
      </button>
      <button
        type="button"
        className="text-ink-faint underline decoration-rule"
        onClick={() => setConfirming(false)}
      >
        Keep it
      </button>
      {result && 'error' in result && <span className="text-amber">{result.error}</span>}
    </form>
  )
}

/* ------------------------------------------------------------------ *
 * Removing
 * ------------------------------------------------------------------ */

export function RemoveMember({
  claimId,
  memberUserId,
  name,
  documentCount,
}: {
  claimId: string
  memberUserId: string
  name: string
  documentCount: number
}) {
  const [result, remove, pending] = useActionState<ActionResult | null, FormData>(
    async () => removeMemberAction(claimId, memberUserId),
    null,
  )
  const [confirming, setConfirming] = useState(false)

  if (!confirming) {
    return (
      <button
        type="button"
        className="text-[0.82rem] text-ink-faint underline decoration-rule hover:text-ink"
        onClick={() => setConfirming(true)}
      >
        Remove
      </button>
    )
  }

  return (
    <form action={remove} className="text-[0.82rem]">
      <p className="text-ink-soft">
        {name} loses this claim immediately, on every device they are signed in on.
        {documentCount > 0 && (
          <>
            {' '}
            The {documentCount} {documentCount === 1 ? 'file' : 'files'} they added stay on
            the claim.
          </>
        )}
      </p>
      <span className="mt-1.5 inline-flex gap-3">
        <button type="submit" className="text-amber underline" disabled={pending}>
          {pending ? 'Removing' : `Remove ${name}`}
        </button>
        <button
          type="button"
          className="text-ink-faint underline decoration-rule"
          onClick={() => setConfirming(false)}
        >
          Keep them
        </button>
      </span>
      {result && 'error' in result && <p className="mt-1 text-amber">{result.error}</p>}
    </form>
  )
}

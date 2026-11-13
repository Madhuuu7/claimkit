'use client'

import { useActionState } from 'react'
import { addSampleClaimAction, type ActionResult } from '@/app/actions'

/**
 * The way back to the sample claim.
 *
 * New accounts are given one when they are created. This is for an
 * account that predates the sample, or deleted it and wants it again,
 * and it is a sentence rather than a button because nobody signing in
 * to assemble a real claim should have to step around it.
 */
export function AddSampleClaim() {
  const [result, add, pending] = useActionState<ActionResult | null, FormData>(
    async () => addSampleClaimAction(),
    null,
  )

  return (
    <form action={add} className="mt-3 text-[0.85rem] text-ink-faint">
      <span>Want something to poke at first? </span>
      <button type="submit" className="underline decoration-rule hover:text-ink" disabled={pending}>
        {pending ? 'Adding it' : 'Add a sample claim'}
      </button>
      {result && 'error' in result && <span className="ml-2 text-amber">{result.error}</span>}
    </form>
  )
}

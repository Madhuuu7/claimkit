'use client'

import { useActionState } from 'react'
import { createClaimAction, type ActionResult } from '@/app/actions'

/**
 * One claim per hospital stay.
 *
 * The submission window is a field, not a constant. It differs by policy
 * — thirty days, sixty, fifteen — and an app that guessed it would be
 * telling a family a deadline that is not theirs. The letter from the
 * insurer has the number; this asks for it.
 */
export function NewClaimForm() {
  const [result, submit, pending] = useActionState<ActionResult | null, FormData>(
    createClaimAction,
    null,
  )

  return (
    <form action={submit} className="sheet mt-5 px-5 py-6 sm:px-7">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Who was admitted" name="patientName" placeholder="Appa's admission" />
        <Field
          label="Hospital"
          name="hospital"
          placeholder="Manipal Hospital, Old Airport Road"
        />
        <Field label="Admitted on" name="admittedOn" type="date" />
        <Field label="Discharged on" name="dischargedOn" type="date" />
        <Field
          label="Final hospital bill"
          name="finalBill"
          placeholder="2,80,000"
          hint="The figure on the final bill, in rupees."
        />
        <Field
          label="Days the policy allows"
          name="submissionWindowDays"
          type="number"
          defaultValue="30"
          hint="Counted from discharge. Check the policy; it varies."
        />
      </div>

      {result && 'error' in result && (
        <p className="mt-4 text-[0.88rem] text-amber">{result.error}</p>
      )}

      <button className="btn mt-6" type="submit" disabled={pending}>
        {pending ? 'Starting the claim' : 'Start this claim'}
      </button>
    </form>
  )
}

function Field({
  label,
  name,
  type = 'text',
  placeholder,
  defaultValue,
  hint,
}: {
  label: string
  name: string
  type?: string
  placeholder?: string
  defaultValue?: string
  hint?: string
}) {
  return (
    <label className="block">
      <span className="block text-[0.82rem] text-ink-soft">{label}</span>
      <input
        className="mt-1 w-full rounded border border-rule bg-sheet px-2.5 py-1.5"
        name={name}
        type={type}
        placeholder={placeholder}
        defaultValue={defaultValue}
        required
      />
      {hint && <span className="mt-1 block text-[0.78rem] text-ink-faint">{hint}</span>}
    </label>
  )
}

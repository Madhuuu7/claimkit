'use client'

/**
 * The wire, with a switch on it.
 *
 * Amber when it is off, because that is this design's colour for "this
 * will cost you something" -- the same colour as the unaccounted money
 * and the closing deadline, and used nowhere else.
 */
export function SignalSwitch({
  on,
  onChange,
  label,
}: {
  on: boolean
  onChange: (on: boolean) => void
  label?: string
}) {
  return (
    <label className="flex cursor-pointer items-center gap-2.5 text-[0.85rem]">
      <span className={on ? 'text-ink-soft' : 'text-amber'}>
        {label ? `${label}: ` : ''}
        {on ? 'Signal' : 'No signal'}
      </span>
      <input
        type="checkbox"
        className="sr-only"
        checked={on}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span
        aria-hidden="true"
        className={`relative h-5 w-9 shrink-0 rounded-full border transition-colors ${
          on ? 'border-teal bg-teal' : 'border-rule bg-paper-sunk'
        }`}
      >
        <span
          className={`absolute top-[0.1rem] h-[0.95rem] w-[0.95rem] rounded-full bg-sheet shadow-sm transition-all ${
            on ? 'left-[1.05rem]' : 'left-[0.1rem]'
          }`}
        />
      </span>
    </label>
  )
}

import { Suspense } from 'react'
import { DeadlineCountdown, DeadlineFallback } from '@/components/Deadline'
import { Workspace } from '@/components/Workspace'
import { demoClaim } from '@/lib/demo'

export default function Page() {
  return (
    <Workspace
      base={demoClaim}
      // Rendered here, on the server, and handed to the client sheet as a
      // slot. The due date depends only on the claim, so it prerenders;
      // the countdown is the one line that needs a real request, because
      // a build cannot know what day someone will open this on.
      deadline={
        <Suspense fallback={<DeadlineFallback claim={demoClaim} />}>
          <DeadlineCountdown claim={demoClaim} />
        </Suspense>
      }
    />
  )
}

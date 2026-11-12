import { CoverSheet } from '@/components/CoverSheet'
import { demoClaim } from '@/lib/demo'

export default function Page() {
  return <CoverSheet claim={demoClaim} />
}

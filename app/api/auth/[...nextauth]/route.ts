import { handlers } from '@/lib/auth'

/**
 * Auth.js owns these two verbs: the Google redirect, the callback it
 * comes back to, the session endpoint and sign-out. Nothing of ours
 * lives here -- the whole file is the hand-off.
 */
export const { GET, POST } = handlers

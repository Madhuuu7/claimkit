/**
 * The upload rules, in a file with no server imports.
 *
 * lib/storage.ts is server-only -- it holds the bucket credentials --
 * but the browser needs the same two rules to give immediate feedback
 * when someone picks a 14 MB photograph. One definition, so the two
 * cannot drift; the enforcement still happens where it is binding, in
 * the signature on the presigned upload.
 */

export const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'application/pdf'] as const
export type AllowedType = (typeof ALLOWED_TYPES)[number]

export const MAX_BYTES = 10 * 1024 * 1024

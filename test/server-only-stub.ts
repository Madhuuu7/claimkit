// `server-only` is resolved by Next.js itself, not installed from npm, so
// it does not exist when Vitest runs a module that imports it. Aliased to
// this empty file: the guard still does its job in the real build, where
// importing it from a client component is a hard error.
export {}

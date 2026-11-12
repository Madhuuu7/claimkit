// Vitest does not read .env, and the integration tests need a database
// connection string. Loaded here rather than in each test file so a test
// that forgets fails loudly instead of quietly running against nothing.
import 'dotenv/config'

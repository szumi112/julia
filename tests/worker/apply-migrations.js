import { applyD1Migrations } from 'cloudflare:test'
import { env } from 'cloudflare:workers'

if (env.TEST_MIGRATIONS.length) {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS)
}

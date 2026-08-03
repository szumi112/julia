import { applyD1Migrations } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { selectCoreMigrationStage } from '../../scripts/core-migration-stages.js'

if (env.TEST_MIGRATIONS.length) {
  await applyD1Migrations(
    env.DB,
    selectCoreMigrationStage(env.TEST_MIGRATIONS, 'stage-a'),
  )
}

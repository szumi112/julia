import path from 'node:path'
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers'
import { defineConfig } from 'vitest/config'
import { selectCoreMigrationStage } from './scripts/core-migration-stages.js'

export default defineConfig({
  plugins: [
    cloudflareTest(async () => {
      const migrations = await readD1Migrations(path.resolve('migrations'))
      return {
        wrangler: { configPath: './wrangler.json' },
        miniflare: {
          bindings: {
            CORE_DIRECTORY_STAGE: 'stage-a-complete-before-fixtures',
            TEST_STAGE_A_MIGRATIONS: selectCoreMigrationStage(migrations, 'stage-a'),
            TEST_STAGE_B_MIGRATIONS: selectCoreMigrationStage(migrations, 'stage-b'),
            TEST_STAGE_C_MIGRATIONS: selectCoreMigrationStage(migrations, 'stage-c'),
            TEST_STAGE_D_MIGRATIONS: selectCoreMigrationStage(migrations, 'stage-d'),
            BWM_DATA_KEK_V1: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
            BWM_LOOKUP_HMAC_V1: 'BAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQ',
            BWM_BACKUP_KEK_V1: 'CAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAg',
          },
        },
      }
    }),
  ],
  test: {
    include: ['tests/worker/**/*.test.js'],
    setupFiles: ['./tests/worker/apply-migrations.js'],
  },
})

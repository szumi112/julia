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
          d1Databases: {
            MATERIALIZER_EXACT: 'materializer-exact',
            MATERIALIZER_NEAR: 'materializer-near',
            MATERIALIZER_TOKEN: 'materializer-token',
            MATERIALIZER_AMBIGUOUS: 'materializer-ambiguous',
            MATERIALIZER_PRESERVE: 'materializer-preserve',
            MATERIALIZER_INVALID: 'materializer-invalid',
            MATERIALIZER_CONFLICT: 'materializer-conflict',
            MATERIALIZER_CREATE: 'materializer-create',
            MATERIALIZER_FALLBACK_IDENTITY_RACE: 'materializer-fallback-identity-race',
            MATERIALIZER_FALLBACK_LINK_RACE: 'materializer-fallback-link-race',
            MATERIALIZER_FALLBACK_STALE_TIME: 'materializer-fallback-stale-time',
            MATERIALIZER_REAL_CREATE: 'materializer-real-create',
            MATERIALIZER_UPDATE: 'materializer-update',
            MATERIALIZER_STAFF_CAP: 'materializer-staff-cap',
            MATERIALIZER_PROFILE_CAP: 'materializer-profile-cap',
          },
          bindings: {
            CORE_DIRECTORY_STAGE: 'stage-a-complete-before-fixtures',
            TEST_STAGE_A_MIGRATIONS: selectCoreMigrationStage(migrations, 'stage-a'),
            TEST_STAGE_B_MIGRATIONS: selectCoreMigrationStage(migrations, 'stage-b'),
            TEST_STAGE_C_MIGRATIONS: selectCoreMigrationStage(migrations, 'stage-c'),
            TEST_STAGE_D_MIGRATIONS: selectCoreMigrationStage(migrations, 'stage-d'),
            TEST_STAGE_E_MIGRATIONS: selectCoreMigrationStage(migrations, 'stage-e'),
            BWM_DATA_KEK_V1: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
            BWM_LOOKUP_HMAC_V1: 'BAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQ',
            BWM_BACKUP_KEK_V1: 'CAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAg',
            BWM_WORKBOOK_KEK_V1: 'CQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQk',
            BWM_WORKBOOK_HMAC_V1: 'CgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgo',
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

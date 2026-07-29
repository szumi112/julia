import path from 'node:path'
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: './wrangler.json' },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations(path.resolve('migrations')),
          BWM_DATA_KEK_V1: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
          BWM_LOOKUP_HMAC_V1: 'BAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQ',
          BWM_BACKUP_KEK_V1: 'CAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAg',
        },
      },
    })),
  ],
  test: {
    include: ['tests/worker/**/*.test.js'],
    setupFiles: ['./tests/worker/apply-migrations.js'],
  },
})

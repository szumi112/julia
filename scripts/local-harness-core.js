import { isAbsolute, join } from 'node:path'

export const LOCAL_HARNESS_RUNNER_MODE = 'runner-v1'
export const LOCAL_HARNESS_WRANGLER_NAME = '.bwm-harness-wrangler.json'
export const LOCAL_HARNESS_MIGRATIONS_NAME = 'migrations'
export const LOCAL_HARNESS_ACTIVE_MIGRATIONS_NAME = 'active'
export const LOCAL_HARNESS_CORE_DIRECTORY_COMPLETE = '{"createdCount":0,"processedCount":0,"status":"complete"}\n'

export function buildLocalHarnessWranglerConfig(
  projectRoot,
  migrationsDirectory = join(projectRoot, '.core-migrations/active'),
) {
  if (typeof projectRoot !== 'string'
    || !isAbsolute(projectRoot)
    || typeof migrationsDirectory !== 'string'
    || !isAbsolute(migrationsDirectory)) {
    throw new Error('LOCAL_HARNESS_CONFIG_INVALID')
  }
  return JSON.stringify({
    name: 'bearwithme-panel-local-harness',
    main: `${projectRoot}/worker/index.js`,
    compatibility_date: '2026-07-29',
    workers_dev: false,
    preview_urls: false,
    assets: {
      binding: 'ASSETS',
      not_found_handling: 'single-page-application',
      run_worker_first: ['/api/*'],
    },
    d1_databases: [{
      binding: 'DB',
      database_name: 'bearwithme-panel-local',
      database_id: '00000000-0000-0000-0000-000000000001',
      preview_database_id: 'bearwithme-panel-local',
      migrations_dir: migrationsDirectory,
    }],
    r2_buckets: [{
      binding: 'ARCHIVE',
      bucket_name: 'bearwithme-panel-local',
      jurisdiction: 'eu',
    }],
    vars: {
      APP_ENV: 'development',
      APP_ORIGIN: 'http://127.0.0.1:5174',
      DATA_MODE: 'fictional',
      ACCESS_AUD: 'local-access-audience',
      ACCESS_HEALTH_SERVICE_TOKEN_ID: 'local-health-service',
      ACCESS_TEAM_DOMAIN: 'https://local.cloudflareaccess.com',
      ACTIVE_DATA_KEK_VERSION: '1',
      ACTIVE_LOOKUP_KEY_VERSION: '1',
      ACTIVE_BACKUP_KEK_VERSION: '1',
      ACTIVE_WORKBOOK_KEK_VERSION: '1',
      ACTIVE_WORKBOOK_HMAC_VERSION: '1',
    },
  }, null, 2)
}

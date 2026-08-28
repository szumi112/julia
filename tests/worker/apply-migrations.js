import { applyD1Migrations } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { selectCoreMigrationStage } from '../../scripts/core-migration-stages.js'
import { advanceCoreDirectoryUpgrade } from '../../scripts/upgrade-core-directory-core.js'

if (env.TEST_STAGE_A_MIGRATIONS.length) {
  await applyD1Migrations(
    env.DB,
    selectCoreMigrationStage(env.TEST_STAGE_A_MIGRATIONS, 'stage-a'),
  )
}

export const completeCoreDirectoryStageA = () => {
  if (env.CORE_DIRECTORY_STAGE !== 'stage-a-complete-before-fixtures') {
    throw new Error('CORE_DIRECTORY_TEST_SETUP_INVALID')
  }
  return advanceCoreDirectoryUpgrade({
    correlationId: '00000000-0000-4000-8000-000000000001',
    cryptoContext: null,
    db: env.DB,
    idFactory: () => 'aud_core_directory_test_setup',
    nowMs: Date.parse('2026-07-31T00:00:00.000Z'),
  })
}

export const applyCoreDirectoryStageB = () => {
  if (env.CORE_DIRECTORY_STAGE !== 'stage-a-complete-before-fixtures') {
    throw new Error('CORE_DIRECTORY_TEST_SETUP_INVALID')
  }
  return applyD1Migrations(
    env.DB,
    selectCoreMigrationStage(env.TEST_STAGE_B_MIGRATIONS, 'stage-b'),
  )
}

export const applyFinanceStageC = () => {
  if (env.CORE_DIRECTORY_STAGE !== 'stage-a-complete-before-fixtures') {
    throw new Error('CORE_DIRECTORY_TEST_SETUP_INVALID')
  }
  return applyD1Migrations(
    env.DB,
    selectCoreMigrationStage(env.TEST_STAGE_C_MIGRATIONS, 'stage-c'),
  )
}

export const applySpecialistProfilesStageD = () => {
  if (env.CORE_DIRECTORY_STAGE !== 'stage-a-complete-before-fixtures') {
    throw new Error('CORE_DIRECTORY_TEST_SETUP_INVALID')
  }
  return applyD1Migrations(
    env.DB,
    selectCoreMigrationStage(env.TEST_STAGE_D_MIGRATIONS, 'stage-d'),
  )
}

export const applyWorkbookRegistryStageE = () => {
  if (env.CORE_DIRECTORY_STAGE !== 'stage-a-complete-before-fixtures') {
    throw new Error('CORE_DIRECTORY_TEST_SETUP_INVALID')
  }
  return applyD1Migrations(
    env.DB,
    selectCoreMigrationStage(env.TEST_STAGE_E_MIGRATIONS, 'stage-e'),
  )
}

export const applyCapabilityOverridesMigration = () => {
  if (env.CORE_DIRECTORY_STAGE !== 'stage-a-complete-before-fixtures') {
    throw new Error('CORE_DIRECTORY_TEST_SETUP_INVALID')
  }
  const migration = env.TEST_STAGE_E_MIGRATIONS.find(({ name }) => (
    name === '0020_capability_overrides.sql'
  ))
  if (!migration) throw new Error('CORE_DIRECTORY_TEST_SETUP_INVALID')
  return applyD1Migrations(env.DB, [migration])
}

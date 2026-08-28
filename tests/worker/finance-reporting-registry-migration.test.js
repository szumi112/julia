import { env } from 'cloudflare:workers'
import { beforeAll, describe, expect, it } from 'vitest'

import {
  applyCoreDirectoryStageB,
  applyFinanceStageC,
  applySpecialistProfilesStageD,
  applyWorkbookRegistryStageE,
  completeCoreDirectoryStageA,
} from './apply-migrations.js'

beforeAll(async () => {
  await completeCoreDirectoryStageA()
  await applyCoreDirectoryStageB()
  await applyFinanceStageC()
  await applySpecialistProfilesStageD()
  await applyWorkbookRegistryStageE()
})

describe('finance reporting and registry migration', () => {
  it('adds bounded claim, manual-void, resolution-set and export-history authorities', async () => {
    const rows = (await env.DB.prepare(
      `SELECT name FROM sqlite_master
       WHERE type='table' AND name IN (
         'finance_appointment_authority_claims','finance_collection_events',
         'finance_manual_voids','finance_reporting_request_replays',
         'finance_reporting_classifications','finance_reporting_state',
         'workbook_import_resolution_sets','workbook_export_history'
       ) ORDER BY name`,
    ).all()).results

    expect(rows.map(({ name }) => name)).toEqual([
      'finance_appointment_authority_claims',
      'finance_collection_events',
      'finance_manual_voids',
      'finance_reporting_classifications',
      'finance_reporting_request_replays',
      'finance_reporting_state',
      'workbook_export_history',
      'workbook_import_resolution_sets',
    ])
    expect((await env.DB.prepare(
      'PRAGMA table_info(finance_reporting_classifications)',
    ).all()).results.map(({ name }) => name)).toEqual([
      'finance_entry_id', 'service_id', 'classification_source', 'version',
      'updated_at',
    ])
    expect((await env.DB.prepare(
      'PRAGMA table_info(finance_collection_events)',
    ).all()).results.map(({ name }) => name)).toEqual([
      'id', 'finance_entry_id', 'entry_version', 'amount_grosze', 'method',
      'created_at',
    ])
    expect((await env.DB.prepare(
      'PRAGMA table_info(finance_manual_voids)',
    ).all()).results.map(({ name }) => name)).toEqual([
      'id', 'finance_entry_id', 'expected_entry_version', 'reason_envelope',
      'voided_by_staff_id', 'created_at',
    ])
    expect((await env.DB.prepare(
      'PRAGMA table_info(workbook_import_resolution_sets)',
    ).all()).results.map(({ name }) => name)).toEqual([
      'id', 'import_id', 'artifact_id', 'preview_token_digest', 'plan_digest',
      'resolution_count', 'resolutions_envelope', 'created_by_staff_id', 'version',
      'created_at',
    ])
    expect((await env.DB.prepare(
      'PRAGMA table_info(workbook_export_history)',
    ).all()).results.map(({ name }) => name)).toEqual([
      'id', 'format', 'scope', 'scope_specialist_id', 'byte_size', 'filename',
      'artifact_fingerprint', 'created_by_staff_id', 'created_at',
    ])
  })

  it('enforces one active finance authority per appointment and append-only lifecycle tables', async () => {
    const indexes = (await env.DB.prepare(
      "PRAGMA index_list('finance_appointment_authority_claims')",
    ).all()).results
    expect(indexes).toContainEqual(expect.objectContaining({
      name: 'finance_appointment_authority_active_uidx', unique: 1,
    }))

    const triggers = (await env.DB.prepare(
      `SELECT name FROM sqlite_master WHERE type='trigger' AND name IN (
        'finance_manual_voids_no_update','finance_manual_voids_no_delete',
        'workbook_import_resolution_sets_no_update',
        'workbook_import_resolution_sets_no_delete',
        'workbook_export_history_no_update','workbook_export_history_no_delete'
      ) ORDER BY name`,
    ).all()).results
    expect(triggers.map(({ name }) => name)).toEqual([
      'finance_manual_voids_no_delete',
      'finance_manual_voids_no_update',
      'workbook_export_history_no_delete',
      'workbook_export_history_no_update',
      'workbook_import_resolution_sets_no_delete',
      'workbook_import_resolution_sets_no_update',
    ])

    const reciprocal = (await env.DB.prepare(
      `SELECT name FROM sqlite_master WHERE type='trigger' AND name IN (
        'historical_client_source_links_manual_void_guard',
        'historical_counterparty_source_links_manual_void_guard',
        'historical_occurrences_manual_void_guard',
        'activity_charges_manual_void_insert_guard',
        'activity_charges_manual_void_update_guard',
        'activity_source_links_manual_void_guard',
        'finance_reporting_state_import_batch_insert',
        'finance_reporting_state_import_batch_update',
        'finance_reporting_state_classification_update'
      ) ORDER BY name`,
    ).all()).results
    expect(reciprocal.map(({ name }) => name)).toEqual([
      'activity_charges_manual_void_insert_guard',
      'activity_charges_manual_void_update_guard',
      'activity_source_links_manual_void_guard',
      'finance_reporting_state_classification_update',
      'finance_reporting_state_import_batch_insert',
      'finance_reporting_state_import_batch_update',
      'historical_client_source_links_manual_void_guard',
      'historical_counterparty_source_links_manual_void_guard',
      'historical_occurrences_manual_void_guard',
    ])
  })
})

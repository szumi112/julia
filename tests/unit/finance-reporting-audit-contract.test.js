import assert from 'node:assert/strict'
import test from 'node:test'

import {
  captureCoreAuditEvent,
  CORE_AUDIT_SCHEMAS,
} from '../../src/core-audit-contract.js'

const event = (patch) => ({
  action: 'finance.entry.voided',
  actorStaffId: 'stf_finance_audit_owner',
  entityType: 'finance_entry',
  entityId: 'fin_finance_audit_entry',
  result: 'success',
  metadata: { entryVersion: 1 },
  ...patch,
})

test('registers exact finance reporting mutation audit contracts', () => {
  assert.deepEqual(Object.keys(CORE_AUDIT_SCHEMAS).filter((key) => (
    key === 'finance.entry.voided'
    || key === 'workbook.resolutions.recorded'
    || key === 'workbook.export.created'
  )), [
    'finance.entry.voided',
    'workbook.export.created',
    'workbook.resolutions.recorded',
  ])
  assert.ok(captureCoreAuditEvent(event({})))
  assert.ok(captureCoreAuditEvent(event({
    action: 'workbook.resolutions.recorded',
    entityType: 'workbook_import',
    entityId: 'wbi_finance_audit_import',
    metadata: { resolutionCount: 2, resolutionVersion: 1 },
  })))
  assert.ok(captureCoreAuditEvent(event({
    action: 'workbook.export.created',
    entityType: 'workbook_export',
    entityId: 'wbe_finance_audit_export',
    metadata: { byteSize: 2048, exportVersion: 1 },
  })))
})

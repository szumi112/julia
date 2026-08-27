import test from 'node:test'
import assert from 'node:assert/strict'
import { specialistProfilesFromWorkbook } from '../../src/workbook-specialists.js'

test('extracts unique normalized workbook specialists and ignores sheet labels', () => {
  assert.deepEqual(specialistProfilesFromWorkbook([
    { specialistName: ' Justyna J-J ' },
    { specialistName: 'Anna Janowska' },
    { specialistName: 'Anna Janowska' },
    { specialistName: null, sheet: 'Angielski Julia' },
  ]), [
    { displayName: 'Anna Janowska', standardRateGrosze: 18000 },
    { displayName: 'Justyna J-J', standardRateGrosze: 18000 },
  ])
})

#!/usr/bin/env node
import {
  AUTHORITATIVE_WORKBOOK_FINGERPRINT,
  auditWorkbook,
} from './audit-workbook-lib.mjs'

const fail = () => { throw new TypeError('WORKBOOK_AUDIT_ARGUMENTS_INVALID') }

const args = process.argv.slice(2)
if (args.length !== 4) fail()
const options = new Map()
for (let index = 0; index < args.length; index += 2) {
  if (!['--path', '--fingerprint'].includes(args[index]) || options.has(args[index])) fail()
  options.set(args[index], args[index + 1])
}

const expectedFingerprint = options.get('--fingerprint')
if (expectedFingerprint !== AUTHORITATIVE_WORKBOOK_FINGERPRINT) {
  throw new TypeError('WORKBOOK_AUDIT_FINGERPRINT_REFUSED')
}

const result = await auditWorkbook({
  sourcePath: options.get('--path'),
  expectedFingerprint,
})
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)

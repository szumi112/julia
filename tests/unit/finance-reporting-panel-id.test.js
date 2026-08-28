import assert from 'node:assert/strict'
import test from 'node:test'

import { syntheticPanelLedgerId } from '../../worker/core/finance-reporting.js'

test('creates bounded deterministic collision-resistant panel ledger IDs', async () => {
  const longest = `apt_${'a'.repeat(124)}`
  const first = await syntheticPanelLedgerId(longest)
  assert.match(first, /^fin_panel_[A-Za-z0-9_-]{43}$/)
  assert.ok(first.length <= 128)
  assert.equal(await syntheticPanelLedgerId(longest), first)
  assert.notEqual(await syntheticPanelLedgerId(`apt_${'a'.repeat(123)}b`), first)
  await assert.rejects(() => syntheticPanelLedgerId('apt_bad/value'), /INTERNAL_ERROR/)
})

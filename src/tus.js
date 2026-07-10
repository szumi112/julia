// Pure TUS domain logic (group classes) — kept .js and side-effect free so it
// is unit-testable like workspace.js. TUS money is intentionally separate from
// session billing: nothing here feeds isBillable/monthStats.
import { monthKey } from './format.js'

export const tusGroupsForRole = (state, role) =>
  role.scope === 'own' ? state.tusGroups.filter((g) => g.leaderIds.includes(role.psychId)) : state.tusGroups

export const canLeadGroup = (group, role) =>
  role.scope !== 'own' || group.leaderIds.includes(role.psychId)

export const kidsOfGroup = (kids, groupId) => kids.filter((k) => k.groupId === groupId)

export const unassignedKids = (kids) => kids.filter((k) => !k.groupId)

export const classesInMonth = (classes, ym) => classes.filter((c) => monthKey(c.date) === ym)

export const tusMonths = (classes) => [...new Set(classes.map((c) => monthKey(c.date)))].sort()

export const nextClassOf = (classes, groupId, nowIso) =>
  classes.find((c) => c.groupId === groupId && c.date >= nowIso) || null

// Rate over marked cells only — unmarked (future) classes don't dilute it.
export const attendanceRate = (classes, kidId) => {
  let present = 0
  let marked = 0
  for (const c of classes) {
    const values = kidId ? (kidId in c.attendance ? [c.attendance[kidId]] : []) : Object.values(c.attendance)
    for (const value of values) {
      marked++
      if (value) present++
    }
  }
  return marked ? Math.round((present / marked) * 100) : null
}

export const tusPaymentFor = (payments, kidId, ym) =>
  payments.find((p) => p.kidId === kidId && p.ym === ym) || {
    kidId, ym, status: 'unpaid', method: null, invoice: false, paidDate: null, note: '', amount: null,
  }

export const tusMonthSummary = (group, classes, kids, payments, ym, nowIso) => {
  const monthClasses = classesInMonth(classes, ym).filter((c) => c.groupId === group.id)
  const roster = kidsOfGroup(kids, group.id)
  const paidCount = roster.filter((k) => tusPaymentFor(payments, k.id, ym).status === 'paid').length
  const dueCount = roster.length - paidCount
  return {
    classCount: monthClasses.length,
    heldCount: monthClasses.filter((c) => c.date <= nowIso).length,
    attendanceRate: attendanceRate(monthClasses),
    paidCount,
    dueCount,
    dueAmount: dueCount * group.fee,
  }
}

// Cascade for DELETE_TUS_KID: drop the kid's attendance marks and payments.
export const stripKid = (classes, payments, kidId) => ({
  classes: classes.map((c) => {
    if (!(kidId in c.attendance)) return c
    const attendance = { ...c.attendance }
    delete attendance[kidId]
    return { ...c, attendance }
  }),
  payments: payments.filter((p) => p.kidId !== kidId),
})

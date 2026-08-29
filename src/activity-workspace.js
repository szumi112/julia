import { canPerformAction } from './capability-access.js'

const MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/
const PROGRAMS = new Set(['english', 'tus'])
const collator = new Intl.Collator('pl-PL', { sensitivity: 'base', usage: 'sort' })

const invalidMonth = () => { throw new TypeError('Invalid activity month') }

const freeze = (value) => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child)
    Object.freeze(value)
  }
  return value
}

const values = (map) => Object.values(map ?? {})
const byPolishLabel = (left, right) => (
  collator.compare(left.label, right.label) || left.id.localeCompare(right.id)
)
const byPolishName = (left, right) => (
  collator.compare(left.name, right.name) || left.id.localeCompare(right.id)
)
const byParticipant = (left, right) => (
  collator.compare(left.participant.name, right.participant.name)
    || left.participant.id.localeCompare(right.participant.id)
    || (left.charge?.id ?? left.membership?.id ?? '').localeCompare(
      right.charge?.id ?? right.membership?.id ?? '',
    )
)

const monthOfPeriod = (period) => period?.month ?? period?.day?.slice(0, 7) ?? null
const periodInMonth = (period, month) => monthOfPeriod(period) === month

const intervalInMonth = (membership, month) => {
  if (membership.membershipKind === 'observation') return periodInMonth(membership.period, month)
  const first = `${month}-01`
  const last = `${month}-31`
  return membership.startsOn <= last
    && (membership.endsOn === null || membership.endsOn >= first)
}

const programId = (program) => `apg_${program}`

const programFacts = (state, program, month) => {
  if (!PROGRAMS.has(program) || !MONTH.test(month)) invalidMonth()
  const id = programId(program)
  const groups = values(state.groupsById)
    .filter((group) => group.programId === id && group.status !== 'inactive')
    .sort(byPolishLabel)
  const groupIds = new Set(groups.map(({ id: groupId }) => groupId))
  const participants = values(state.participantsById)
    .filter((participant) => participant.programId === id && participant.status !== 'inactive')
  const participantById = new Map(participants.map((participant) => [participant.id, participant]))
  const memberships = values(state.membershipsById)
    .filter((membership) => membership.programId === id
      && membership.status !== 'inactive' && intervalInMonth(membership, month))
  const membershipById = new Map(memberships.map((membership) => [membership.id, membership]))
  const charges = values(state.chargesById)
    .filter((charge) => charge.programId === id
      && charge.status !== 'inactive' && periodInMonth(charge.period, month))
  const classes = values(state.classesById)
    .filter((activityClass) => groupIds.has(activityClass.groupId)
      && activityClass.date.slice(0, 7) === month)
    .sort((left, right) => left.date.localeCompare(right.date)
      || (left.time ?? '').localeCompare(right.time ?? '')
      || left.id.localeCompare(right.id))
  return { id, groups, groupIds, participants, participantById, memberships, membershipById, charges, classes }
}

const chargeRow = (charge, facts, groupById) => {
  const finance = charge.finance
  return {
    id: charge.id,
    charge,
    participant: facts.participantById.get(charge.participantId),
    membership: charge.membershipId === null ? null : facts.membershipById.get(charge.membershipId) ?? null,
    group: charge.groupId === null ? null : groupById.get(charge.groupId) ?? null,
    groupLabel: charge.groupId === null
      ? 'Bez przypisanej grupy'
      : groupById.get(charge.groupId)?.label ?? 'Bez przypisanej grupy',
    lessonCount: charge.lessonCount,
    amountGrosze: finance.amountGrosze,
    paidAmountGrosze: finance.paidAmountGrosze,
    outstandingAmountGrosze: finance.amountGrosze - finance.paidAmountGrosze,
    paymentMethod: finance.paymentMethod,
    settlementStatus: finance.settlementStatus,
  }
}

const summaryFor = ({ memberships, charges, classes }) => {
  const participantIds = new Set()
  for (const membership of memberships) participantIds.add(membership.participantId)
  let amountGrosze = 0
  let paidAmountGrosze = 0
  let lessonCount = 0
  for (const charge of charges) {
    participantIds.add(charge.participantId)
    amountGrosze += charge.finance.amountGrosze
    paidAmountGrosze += charge.finance.paidAmountGrosze
    if (charge.lessonCount !== null) lessonCount += charge.lessonCount
  }
  return {
    participantCount: participantIds.size,
    membershipCount: memberships.length,
    chargeCount: charges.length,
    classCount: classes.length,
    lessonCount,
    amountGrosze,
    paidAmountGrosze,
    outstandingAmountGrosze: amountGrosze - paidAmountGrosze,
  }
}

export function activityCurrentMonth(now = new Date()) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) invalidMonth()
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Warsaw', year: 'numeric', month: '2-digit',
  }).formatToParts(now)
  const year = parts.find(({ type }) => type === 'year')?.value
  const month = parts.find(({ type }) => type === 'month')?.value
  const result = `${year}-${month}`
  if (!MONTH.test(result)) invalidMonth()
  return result
}

export function activityMonthRange(month) {
  if (typeof month !== 'string' || !MONTH.test(month)) invalidMonth()
  return Object.freeze({ from: month, to: month })
}

export function activityMonthState(status, loadedMonths, month) {
  activityMonthRange(month)
  if (status === 'read-only-error') return 'unavailable'
  const covered = Array.isArray(loadedMonths)
    && loadedMonths.some((range) => range?.from <= month && range?.to >= month)
  return status === 'ready' && covered ? 'ready' : 'loading'
}

export function activityProgramOverview(state, { program, month }) {
  const facts = programFacts(state, program, month)
  const groupById = new Map(facts.groups.map((group) => [group.id, group]))
  const leaders = values(state.groupLeadersById)
    .filter((leader) => facts.groupIds.has(leader.groupId) && leader.status !== 'inactive')
  const leadersByGroup = new Map()
  for (const leader of leaders) {
    const groupLeaders = leadersByGroup.get(leader.groupId) ?? []
    groupLeaders.push(leader)
    leadersByGroup.set(leader.groupId, groupLeaders)
  }
  const rows = facts.charges.map((charge) => chargeRow(charge, facts, groupById)).sort(byParticipant)
  const cards = facts.groups.map((group) => {
    const memberships = facts.memberships.filter(({ groupId }) => groupId === group.id)
    const charges = facts.charges.filter(({ groupId }) => groupId === group.id)
    const classes = facts.classes.filter(({ groupId }) => groupId === group.id)
    return {
      group,
      leaders: (leadersByGroup.get(group.id) ?? []).sort((left, right) => (
        left.specialistId.localeCompare(right.specialistId) || left.id.localeCompare(right.id)
      )),
      summary: summaryFor({ memberships, charges, classes }),
    }
  })
  return freeze({
    program: state.programsById?.[facts.id] ?? null,
    month,
    latestPopulatedMonth: state.latestPopulatedMonths?.[program] ?? null,
    summary: summaryFor(facts),
    groups: cards,
    participants: [...facts.participants].sort(byPolishName),
    rows,
    ungroupedRows: rows.filter(({ group }) => group === null),
  })
}

export function activityGroupView(state, { groupId, month }) {
  activityMonthRange(month)
  const group = state.groupsById?.[groupId]
  if (!group) return null
  const program = state.programsById?.[group.programId]?.code
  if (!PROGRAMS.has(program)) return null
  const facts = programFacts(state, program, month)
  if (!facts.groupIds.has(groupId)) return null
  const memberships = facts.memberships.filter((membership) => membership.groupId === groupId)
  const membershipRows = memberships.map((membership) => ({
    membership,
    participant: facts.participantById.get(membership.participantId),
  })).filter(({ participant }) => participant).sort(byParticipant)
  const groupClasses = facts.classes.filter((activityClass) => activityClass.groupId === groupId)
  const classIds = new Set(groupClasses.map(({ id }) => id))
  const attendanceByClass = new Map()
  for (const attendance of values(state.attendanceById)) {
    if (!classIds.has(attendance.classId)) continue
    const rows = attendanceByClass.get(attendance.classId) ?? []
    rows.push({ attendance, participant: facts.participantById.get(attendance.participantId) })
    attendanceByClass.set(attendance.classId, rows)
  }
  const classes = groupClasses.map((activityClass) => ({
    activityClass,
    attendance: (attendanceByClass.get(activityClass.id) ?? [])
      .filter(({ participant }) => participant).sort(byParticipant),
  }))
  const charges = facts.charges.filter((charge) => charge.groupId === groupId)
  const groupById = new Map([[groupId, group]])
  const chargeRows = charges.map((charge) => chargeRow(charge, facts, groupById)).sort(byParticipant)
  const leaders = values(state.groupLeadersById)
    .filter((leader) => leader.groupId === groupId && leader.status !== 'inactive')
    .sort((left, right) => left.specialistId.localeCompare(right.specialistId)
      || left.id.localeCompare(right.id))
  return freeze({
    program: state.programsById[group.programId],
    group,
    month,
    leaders,
    memberships,
    participantRows: membershipRows,
    participantOptions: [...facts.participants].sort(byPolishName),
    classes,
    chargeRows,
    summary: summaryFor({ memberships, charges, classes: groupClasses }),
  })
}

export function activityActionAvailability({ actor, role, capabilities, group }) {
  const centre = role?.scope === 'centre'
  const specialistId = actor?.specialistId ?? null
  const led = Boolean(group?.leaders?.some((leader) => leader.specialistId === specialistId))
  const eligibleToManageGroup = centre || led
  const allowed = (actionId, eligible) => canPerformAction(capabilities, actionId) && eligible
  return freeze({
    createGroup: allowed('activity.group.create', centre),
    editGroup: allowed('activity.group.edit', eligibleToManageGroup),
    createParticipant: allowed('activity.participant.create', centre),
    editParticipant: allowed('activity.participant.edit', centre),
    createMembership: allowed('activity.membership.create', centre),
    editMembership: allowed('activity.membership.edit', centre),
    createClass: allowed('activity.class.create', eligibleToManageGroup),
    editClass: allowed('activity.class.edit', eligibleToManageGroup),
    editAttendance: allowed('activity.attendance.edit', eligibleToManageGroup),
  })
}

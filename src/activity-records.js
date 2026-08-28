const MONTH = /^(\d{4})-(\d{2})$/
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const WALL_TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/
const IDS = Object.freeze({
  program: /^apg_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/,
  group: /^agr_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/,
  groupLeader: /^agl_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/,
  participant: /^acp_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/,
  membership: /^amb_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/,
  class: /^acl_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/,
  attendance: /^aat_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/,
  charge: /^ach_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/,
  payment: /^apy_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/,
  client: /^cl_[A-Za-z0-9][A-Za-z0-9_-]{0,124}$/,
  historicalClient: /^hcl_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/,
  specialist: /^sp_[A-Za-z0-9][A-Za-z0-9_-]{0,124}$/,
  finance: /^fin_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/,
  projectionJob: /^apj_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/,
  import: /^wbi_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/,
  source: /^wbs_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/,
})

export const ACTIVITY_PROGRAM_CODES = Object.freeze(['english', 'tus'])
export const ACTIVITY_PERIOD_PRECISIONS = Object.freeze(['day', 'month', 'unknown'])

const encoder = new TextEncoder()
const invalid = (kind) => { throw new TypeError(`Invalid activity ${kind}`) }

const exact = (value, keys, kind) => {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype) invalid(kind)
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const actual = Reflect.ownKeys(descriptors)
    if (actual.length !== keys.length
      || actual.some((key) => typeof key !== 'string' || !keys.includes(key))) invalid(kind)
    const captured = {}
    for (const key of keys) {
      const descriptor = descriptors[key]
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) invalid(kind)
      captured[key] = descriptor.value
    }
    return captured
  } catch (error) {
    if (error instanceof TypeError && error.message === `Invalid activity ${kind}`) throw error
    invalid(kind)
  }
}

const frozen = (value) => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) frozen(child)
    Object.freeze(value)
  }
  return value
}

const identifier = (value, kind, { nullable = false } = {}) => {
  if (nullable && value === null) return value
  if (typeof value !== 'string' || !IDS[kind]?.test(value)) invalid(kind)
  return value
}

const canonicalInstant = (value) => typeof value === 'string' && INSTANT.test(value)
  && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value

const civilDay = (value) => {
  const match = typeof value === 'string' ? DAY.exec(value) : null
  if (!match || match[1] === '0000') return false
  const date = new Date(0)
  date.setUTCHours(0, 0, 0, 0)
  date.setUTCFullYear(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
  return date.getUTCFullYear() === Number(match[1])
    && date.getUTCMonth() + 1 === Number(match[2])
    && date.getUTCDate() === Number(match[3])
}

const civilMonth = (value) => {
  const match = typeof value === 'string' ? MONTH.exec(value) : null
  return Boolean(match && match[1] !== '0000' && Number(match[2]) >= 1
    && Number(match[2]) <= 12)
}

const expectedWorkspaceMonth = (options) => {
  if (options === undefined) return null
  const captured = exact(options, ['currentMonth'], 'workspace options')
  if (!civilMonth(captured.currentMonth)) invalid('workspace options')
  return captured.currentMonth
}

const safeText = (value, { nullable = false, maximum = 240 } = {}) => {
  if (nullable && value === null) return value
  if (typeof value !== 'string' || value !== value.trim() || value !== value.normalize('NFC')
    || value !== value.replace(/\s+/gu, ' ') || !value.length || !value.isWellFormed()
    || /[\p{Cc}\p{Cf}]/u.test(value)) {
    return false
  }
  const bytes = encoder.encode(value)
  const valid = bytes.byteLength <= maximum
  bytes.fill(0)
  return valid
}

const integer = (value, minimum, maximum) => Number.isSafeInteger(value)
  && value >= minimum && value <= maximum

const versioned = (value, kind) => {
  if (!integer(value.version, 1, Number.MAX_SAFE_INTEGER)
    || !canonicalInstant(value.createdAt) || !canonicalInstant(value.updatedAt)
    || value.updatedAt < value.createdAt) invalid(kind)
  return value
}

const programCodeForId = (programId) => {
  if (programId === 'apg_tus') return 'tus'
  if (programId === 'apg_english') return 'english'
  return null
}

export const isActivityProgramId = (value) => typeof value === 'string'
  && IDS.program.test(value)
export const isActivityGroupId = (value) => typeof value === 'string'
  && IDS.group.test(value)
export const isActivityParticipantId = (value) => typeof value === 'string'
  && IDS.participant.test(value)
export const isActivityMembershipId = (value) => typeof value === 'string'
  && IDS.membership.test(value)
export const isActivityClassId = (value) => typeof value === 'string'
  && IDS.class.test(value)
export const isActivityChargeId = (value) => typeof value === 'string'
  && IDS.charge.test(value)

export function captureActivityPeriod(value) {
  const period = exact(value, ['precision', 'day', 'month'], 'period')
  const valid = (period.precision === 'day' && civilDay(period.day)
      && period.month === period.day.slice(0, 7))
    || (period.precision === 'month' && period.day === null && civilMonth(period.month))
    || (period.precision === 'unknown' && period.day === null && period.month === null)
  if (!valid) invalid('period')
  return frozen(period)
}

export function captureActivityMonthWindow(value) {
  const window = exact(value, ['from', 'to'], 'month window')
  if (!civilMonth(window.from) || !civilMonth(window.to)) invalid('month window')
  const [fromYear, fromMonth] = window.from.split('-').map(Number)
  const [toYear, toMonth] = window.to.split('-').map(Number)
  const distance = (toYear * 12 + toMonth) - (fromYear * 12 + fromMonth)
  if (distance < 0 || distance > 11) invalid('month window')
  return frozen(window)
}

export function captureActivityProgram(value) {
  const result = versioned(exact(value, [
    'id', 'code', 'label', 'status', 'version', 'createdAt', 'updatedAt',
  ], 'program'), 'program')
  if (!identifier(result.id, 'program') || !ACTIVITY_PROGRAM_CODES.includes(result.code)
    || result.id !== `apg_${result.code}` || !safeText(result.label, { maximum: 80 })
    || !['active', 'inactive'].includes(result.status)) invalid('program')
  return frozen(result)
}

export function captureActivityGroup(value) {
  const result = versioned(exact(value, [
    'id', 'programId', 'label', 'details', 'status', 'version', 'createdAt', 'updatedAt',
  ], 'group'), 'group')
  identifier(result.id, 'group')
  identifier(result.programId, 'program')
  if (!safeText(result.label, { maximum: 160 })
    || !(result.details === null || safeText(result.details, { maximum: 2000 }))
    || !['active', 'inactive'].includes(result.status)) invalid('group')
  return frozen(result)
}

export function captureActivityGroupLeader(value) {
  const result = versioned(exact(value, [
    'id', 'groupId', 'specialistId', 'startsOn', 'endsOn', 'status',
    'version', 'createdAt', 'updatedAt',
  ], 'group leader'), 'group leader')
  identifier(result.id, 'groupLeader')
  identifier(result.groupId, 'group')
  identifier(result.specialistId, 'specialist')
  if (!civilDay(result.startsOn)
    || !(result.endsOn === null
      || (civilDay(result.endsOn) && result.endsOn >= result.startsOn))
    || !['active', 'inactive'].includes(result.status)) invalid('group leader')
  return frozen(result)
}

export function captureActivityParticipant(value) {
  const result = versioned(exact(value, [
    'id', 'programId', 'name', 'clientId', 'historicalClientId', 'status',
    'version', 'createdAt', 'updatedAt',
  ], 'participant'), 'participant')
  identifier(result.id, 'participant')
  identifier(result.programId, 'program')
  identifier(result.clientId, 'client', { nullable: true })
  identifier(result.historicalClientId, 'historicalClient', { nullable: true })
  if (!safeText(result.name, { maximum: 160 })
    || (result.clientId !== null && result.historicalClientId !== null)
    || !['active', 'inactive'].includes(result.status)) invalid('participant')
  return frozen(result)
}

export function captureActivityMembership(value) {
  const result = versioned(exact(value, [
    'id', 'participantId', 'programId', 'groupId', 'membershipKind', 'period',
    'startsOn', 'endsOn', 'status', 'version', 'createdAt', 'updatedAt',
  ], 'membership'), 'membership')
  identifier(result.id, 'membership')
  identifier(result.participantId, 'participant')
  identifier(result.programId, 'program')
  identifier(result.groupId, 'group')
  result.period = captureActivityPeriod(result.period)
  const validObservation = result.membershipKind === 'observation'
    && ['day', 'month'].includes(result.period.precision)
    && result.startsOn === null && result.endsOn === null
  const validInterval = result.membershipKind === 'interval'
    && result.period.precision === 'unknown' && civilDay(result.startsOn)
    && (result.endsOn === null || (civilDay(result.endsOn) && result.endsOn >= result.startsOn))
  if ((!validObservation && !validInterval)
    || !['active', 'inactive'].includes(result.status)) invalid('membership')
  return frozen(result)
}

export function captureActivityClass(value) {
  const result = versioned(exact(value, [
    'id', 'groupId', 'date', 'time', 'durationMinutes', 'topic', 'status',
    'version', 'createdAt', 'updatedAt',
  ], 'class'), 'class')
  identifier(result.id, 'class')
  identifier(result.groupId, 'group')
  if (!civilDay(result.date) || !(result.time === null
      || (typeof result.time === 'string' && WALL_TIME.test(result.time)))
    || !(result.durationMinutes === null || integer(result.durationMinutes, 1, 1440))
    || !(result.topic === null || safeText(result.topic, { maximum: 1000 }))
    || !['cancelled', 'completed', 'scheduled'].includes(result.status)) invalid('class')
  return frozen(result)
}

export function captureActivityAttendance(value) {
  const result = versioned(exact(value, [
    'id', 'classId', 'participantId', 'status', 'version', 'createdAt', 'updatedAt',
  ], 'attendance'), 'attendance')
  identifier(result.id, 'attendance')
  identifier(result.classId, 'class')
  identifier(result.participantId, 'participant')
  if (!['absent', 'excused', 'present', 'unknown'].includes(result.status)) {
    invalid('attendance')
  }
  return frozen(result)
}

const captureFinanceProjection = (value, minimumAmount) => {
  const result = exact(value, [
    'amountGrosze', 'paidAmountGrosze', 'paymentMethod', 'settlementStatus',
  ], 'charge')
  if (!integer(result.amountGrosze, minimumAmount, 100_000_000)
    || !integer(result.paidAmountGrosze, 0, result.amountGrosze)
    || !['blik', 'card', 'cash', 'monthly', 'other', 'transfer', 'unknown']
      .includes(result.paymentMethod)
    || !['paid', 'partial', 'unknown', 'unpaid'].includes(result.settlementStatus)) {
    invalid('charge')
  }
  const settlementMatches = (result.settlementStatus === 'paid'
      && result.paidAmountGrosze === result.amountGrosze)
    || (['unpaid', 'unknown'].includes(result.settlementStatus)
      && result.paidAmountGrosze === 0)
    || (result.settlementStatus === 'partial'
      && result.paidAmountGrosze > 0
      && result.paidAmountGrosze < result.amountGrosze)
  if (!settlementMatches) invalid('charge')
  return frozen(result)
}

export function captureActivityCharge(value) {
  const result = versioned(exact(value, [
    'id', 'participantId', 'programId', 'groupId', 'membershipId', 'period',
    'lessonCount', 'responsibleSpecialistId', 'financeEntryId', 'status', 'version',
    'finance', 'createdAt', 'updatedAt',
  ], 'charge'), 'charge')
  identifier(result.id, 'charge')
  identifier(result.participantId, 'participant')
  identifier(result.programId, 'program')
  identifier(result.groupId, 'group', { nullable: true })
  identifier(result.membershipId, 'membership', { nullable: true })
  identifier(result.responsibleSpecialistId, 'specialist')
  identifier(result.financeEntryId, 'finance')
  result.period = captureActivityPeriod(result.period)
  const code = programCodeForId(result.programId)
  result.finance = captureFinanceProjection(result.finance, code === 'english' ? 0 : 1)
  const validProgramShape = (code === 'tus' && result.groupId !== null
      && result.membershipId !== null && result.lessonCount === null)
    || (code === 'english' && result.groupId === null && result.membershipId === null
      && integer(result.lessonCount, 0, 1000))
  if (!validProgramShape || !['active', 'inactive'].includes(result.status)
    || !['day', 'month'].includes(result.period.precision)) invalid('charge')
  return frozen(result)
}

export function captureActivityPayment(value) {
  const result = versioned(exact(value, [
    'id', 'chargeId', 'financeEntryId', 'status', 'version', 'createdAt', 'updatedAt',
  ], 'payment'), 'payment')
  identifier(result.id, 'payment')
  identifier(result.chargeId, 'charge')
  identifier(result.financeEntryId, 'finance')
  if (!['active', 'inactive'].includes(result.status)) invalid('payment')
  return frozen(result)
}

export function captureActivityLatestPopulatedMonths(value) {
  const result = exact(value, ['tus', 'english'], 'latest populated months')
  if (!(result.tus === null || civilMonth(result.tus))
    || !(result.english === null || civilMonth(result.english))) {
    invalid('latest populated months')
  }
  return frozen(result)
}

const plainArray = (value, maximum, kind) => {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype
      || value.length > maximum) invalid(kind)
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const keys = Reflect.ownKeys(descriptors)
    if (keys.length !== value.length + 1 || !keys.includes('length')) invalid(kind)
    const result = new Array(value.length)
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = descriptors[String(index)]
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) invalid(kind)
      result[index] = descriptor.value
    }
    if (keys.some((key) => key !== 'length'
      && !(typeof key === 'string' && /^\d+$/.test(key)
        && Number(key) < value.length && String(Number(key)) === key))) invalid(kind)
    return result
  } catch (error) {
    if (error instanceof TypeError && error.message === `Invalid activity ${kind}`) throw error
    invalid(kind)
  }
}

const LIMITS = Object.freeze({
  programs: 2, groups: 100, groupLeaders: 2000, participants: 1000,
  memberships: 2000, classes: 1000, attendance: 10000, charges: 5000,
  payments: 0,
})

const captureList = (value, capture, kind) => {
  const result = plainArray(value, LIMITS[kind], 'workspace').map(capture)
  const ids = new Set()
  let previous = null
  for (const item of result) {
    if (ids.has(item.id) || (previous !== null && item.id <= previous)) invalid('workspace')
    ids.add(item.id)
    previous = item.id
  }
  return result
}

const periodContains = (membership, period) => {
  if (membership.membershipKind === 'observation') {
    return membership.period.precision === period.precision
      && membership.period.day === period.day && membership.period.month === period.month
  }
  const firstDay = period.day ?? `${period.month}-01`
  const lastDay = period.day ?? `${period.month}-31`
  return membership.startsOn <= lastDay
    && (membership.endsOn === null || membership.endsOn >= firstDay)
}

const eligibilityKey = (participantId, groupId) => `${participantId}\n${groupId}`

const membershipEligibilityIndex = (memberships) => {
  const index = new Map()
  for (const membership of memberships) {
    const key = eligibilityKey(membership.participantId, membership.groupId)
    let entry = index.get(key)
    if (!entry) {
      entry = { days: new Set(), months: new Set(), intervals: [] }
      index.set(key, entry)
    }
    if (membership.membershipKind === 'interval') {
      entry.intervals.push([membership.startsOn, membership.endsOn ?? '9999-12-31'])
    } else if (membership.period.precision === 'day') {
      entry.days.add(membership.period.day)
    } else {
      entry.months.add(membership.period.month)
    }
  }
  for (const entry of index.values()) {
    entry.intervals.sort(([left], [right]) => left.localeCompare(right))
    const merged = []
    for (const interval of entry.intervals) {
      const previous = merged.at(-1)
      if (previous && interval[0] <= previous[1]) {
        if (interval[1] > previous[1]) previous[1] = interval[1]
      } else merged.push([...interval])
    }
    entry.intervals = merged
  }
  return index
}

const eligibleOn = (entry, day) => {
  if (!entry) return false
  if (entry.days.has(day) || entry.months.has(day.slice(0, 7))) return true
  let low = 0
  let high = entry.intervals.length - 1
  while (low <= high) {
    const middle = (low + high) >> 1
    const [startsOn, endsOn] = entry.intervals[middle]
    if (startsOn > day) high = middle - 1
    else if (endsOn < day) low = middle + 1
    else return true
  }
  return false
}

const addInterval = (index, key, startsOn, endsOn) => {
  const intervals = index.get(key) ?? []
  intervals.push([startsOn, endsOn ?? '9999-12-31'])
  index.set(key, intervals)
}

const rejectIntervalOverlaps = (index) => {
  for (const intervals of index.values()) {
    intervals.sort(([leftStart, leftEnd], [rightStart, rightEnd]) => (
      leftStart.localeCompare(rightStart) || leftEnd.localeCompare(rightEnd)
    ))
    let maximumEnd = null
    for (const [startsOn, endsOn] of intervals) {
      if (maximumEnd !== null && startsOn <= maximumEnd) invalid('workspace')
      if (maximumEnd === null || endsOn > maximumEnd) maximumEnd = endsOn
    }
  }
}

const workspaceGraph = (result, currentMonth) => {
  const byId = (values) => new Map(values.map((value) => [value.id, value]))
  const programs = byId(result.programs)
  const groups = byId(result.groups)
  const participants = byId(result.participants)
  const memberships = byId(result.memberships)
  const classes = byId(result.classes)
  const eligibility = membershipEligibilityIndex(result.memberships)
  const activeLeaderIntervals = new Map()
  const observationKeys = new Set()
  const activeMembershipIntervals = new Map()
  const attendanceKeys = new Set()
  for (const group of result.groups) {
    if (!programs.has(group.programId)) invalid('workspace')
  }
  for (const leader of result.groupLeaders) {
    if (!groups.has(leader.groupId)) invalid('workspace')
    if (leader.status === 'active') {
      addInterval(
        activeLeaderIntervals,
        `${leader.groupId}\n${leader.specialistId}`,
        leader.startsOn,
        leader.endsOn,
      )
    }
  }
  rejectIntervalOverlaps(activeLeaderIntervals)
  for (const participant of result.participants) {
    if (!programs.has(participant.programId)) invalid('workspace')
  }
  for (const membership of result.memberships) {
    const participant = participants.get(membership.participantId)
    const group = groups.get(membership.groupId)
    if (!participant || !group || participant.programId !== membership.programId
      || group.programId !== membership.programId) invalid('workspace')
    if (membership.membershipKind === 'observation') {
      const observed = membership.period.precision === 'day'
        ? membership.period.day : membership.period.month
      const key = `${membership.period.precision}\n${membership.participantId}\n${membership.groupId}\n${observed}`
      if (observationKeys.has(key)) invalid('workspace')
      observationKeys.add(key)
    } else {
      addInterval(
        activeMembershipIntervals,
        `${membership.participantId}\n${membership.programId}`,
        membership.startsOn,
        membership.endsOn,
      )
    }
  }
  rejectIntervalOverlaps(activeMembershipIntervals)
  for (const activityClass of result.classes) {
    if (!groups.has(activityClass.groupId)) invalid('workspace')
  }
  for (const attendance of result.attendance) {
    const activityClass = classes.get(attendance.classId)
    const participant = participants.get(attendance.participantId)
    const group = activityClass && groups.get(activityClass.groupId)
    const naturalKey = `${attendance.classId}\n${attendance.participantId}`
    if (!activityClass || !participant || !group
      || participant.programId !== group.programId
      || attendanceKeys.has(naturalKey)
      || !eligibleOn(
        eligibility.get(eligibilityKey(participant.id, group.id)), activityClass.date,
      )) invalid('workspace')
    attendanceKeys.add(naturalKey)
  }
  const financeIds = new Set()
  for (const charge of result.charges) {
    const participant = participants.get(charge.participantId)
    const group = charge.groupId === null ? null : groups.get(charge.groupId)
    const membership = charge.membershipId === null
      ? null : memberships.get(charge.membershipId)
    if (!programs.has(charge.programId) || !participant
      || participant.programId !== charge.programId
      || (charge.groupId !== null && (!group || group.programId !== charge.programId))
      || (charge.membershipId !== null && (!membership
        || membership.participantId !== charge.participantId
        || membership.programId !== charge.programId
        || membership.groupId !== charge.groupId
        || !periodContains(membership, charge.period)))
      || financeIds.has(charge.financeEntryId)) invalid('workspace')
    financeIds.add(charge.financeEntryId)
  }
  const visible = { tus: null, english: null }
  for (const charge of result.charges) {
    if (charge.status === 'active' && charge.period.month <= currentMonth) {
      const code = programCodeForId(charge.programId)
      visible[code] = visible[code] === null || charge.period.month > visible[code]
        ? charge.period.month : visible[code]
    }
  }
  for (const membership of result.memberships) {
    if (membership.status === 'active' && membership.membershipKind === 'observation'
      && membership.period.month <= currentMonth) {
      const code = programCodeForId(membership.programId)
      visible[code] = visible[code] === null || membership.period.month > visible[code]
        ? membership.period.month : visible[code]
    }
  }
  for (const code of ACTIVITY_PROGRAM_CODES) {
    if (result.latestPopulatedMonths[code] !== null
      && result.latestPopulatedMonths[code] > currentMonth) invalid('workspace')
    if (visible[code] !== null && (result.latestPopulatedMonths[code] === null
      || result.latestPopulatedMonths[code] < visible[code])) invalid('workspace')
  }
}

export function captureActivityWorkspace(value, options) {
  const expectedCurrentMonth = expectedWorkspaceMonth(options)
  const result = exact(value, [
    'from', 'to', 'complete', 'currentDay', 'latestPopulatedMonths', 'programs', 'groups',
    'groupLeaders', 'participants', 'memberships', 'classes', 'attendance',
    'charges', 'payments',
  ], 'workspace')
  captureActivityMonthWindow({ from: result.from, to: result.to })
  if (result.complete !== true || !civilDay(result.currentDay)) invalid('workspace')
  const currentMonth = result.currentDay.slice(0, 7)
  if (expectedCurrentMonth !== null && expectedCurrentMonth !== currentMonth) {
    invalid('workspace')
  }
  result.latestPopulatedMonths = captureActivityLatestPopulatedMonths(
    result.latestPopulatedMonths,
  )
  result.programs = captureList(result.programs, captureActivityProgram, 'programs')
  result.groups = captureList(result.groups, captureActivityGroup, 'groups')
  result.groupLeaders = captureList(
    result.groupLeaders, captureActivityGroupLeader, 'groupLeaders',
  )
  result.participants = captureList(
    result.participants, captureActivityParticipant, 'participants',
  )
  result.memberships = captureList(
    result.memberships, captureActivityMembership, 'memberships',
  )
  result.classes = captureList(result.classes, captureActivityClass, 'classes')
  result.attendance = captureList(
    result.attendance, captureActivityAttendance, 'attendance',
  )
  result.charges = captureList(result.charges, captureActivityCharge, 'charges')
  result.payments = captureList(result.payments, captureActivityPayment, 'payments')
  workspaceGraph(result, currentMonth)
  return frozen(result)
}

const specialistIds = (value) => {
  const captured = plainArray(value, 20, 'leader specialist ids')
    .map((item) => identifier(item, 'specialist'))
  if (new Set(captured).size !== captured.length) invalid('leader specialist ids')
  return Object.freeze([...captured].sort((left, right) => left.localeCompare(right)))
}

const commandVersion = (value, { zero = false } = {}) => integer(
  value, zero ? 0 : 1, Number.MAX_SAFE_INTEGER,
)

export function captureCreateActivityGroupCommand(value) {
  const result = exact(value, [
    'programId', 'label', 'details', 'leaderSpecialistIds',
  ], 'group command')
  identifier(result.programId, 'program')
  if (!programCodeForId(result.programId)
    || !safeText(result.label, { maximum: 160 })
    || !(result.details === null || safeText(result.details, { maximum: 2000 }))) {
    invalid('group command')
  }
  result.leaderSpecialistIds = specialistIds(result.leaderSpecialistIds)
  return frozen(result)
}

export function captureEditActivityGroupCommand(value) {
  const result = exact(value, [
    'expectedVersion', 'label', 'details', 'status', 'leaderSpecialistIds',
  ], 'group edit command')
  if (!commandVersion(result.expectedVersion)
    || !safeText(result.label, { maximum: 160 })
    || !(result.details === null || safeText(result.details, { maximum: 2000 }))
    || !['active', 'inactive'].includes(result.status)) invalid('group edit command')
  result.leaderSpecialistIds = specialistIds(result.leaderSpecialistIds)
  return frozen(result)
}

export function captureCreateActivityParticipantCommand(value) {
  const result = exact(value, [
    'programId', 'name', 'clientId', 'historicalClientId',
  ], 'participant command')
  identifier(result.programId, 'program')
  identifier(result.clientId, 'client', { nullable: true })
  identifier(result.historicalClientId, 'historicalClient', { nullable: true })
  if (!programCodeForId(result.programId) || !safeText(result.name, { maximum: 160 })
    || (result.clientId !== null && result.historicalClientId !== null)) {
    invalid('participant command')
  }
  return frozen(result)
}

export function captureEditActivityParticipantCommand(value) {
  const result = exact(value, [
    'expectedVersion', 'name', 'clientId', 'historicalClientId', 'status',
  ], 'participant edit command')
  identifier(result.clientId, 'client', { nullable: true })
  identifier(result.historicalClientId, 'historicalClient', { nullable: true })
  if (!commandVersion(result.expectedVersion) || !safeText(result.name, { maximum: 160 })
    || (result.clientId !== null && result.historicalClientId !== null)
    || !['active', 'inactive'].includes(result.status)) invalid('participant edit command')
  return frozen(result)
}

export function captureCreateActivityMembershipCommand(value) {
  const result = exact(value, [
    'participantId', 'groupId', 'startsOn', 'endsOn',
  ], 'membership command')
  identifier(result.participantId, 'participant')
  identifier(result.groupId, 'group')
  if (!civilDay(result.startsOn)
    || !(result.endsOn === null
      || (civilDay(result.endsOn) && result.endsOn >= result.startsOn))) {
    invalid('membership command')
  }
  return frozen(result)
}

export function captureEditActivityMembershipCommand(value) {
  const result = exact(value, [
    'expectedVersion', 'startsOn', 'endsOn', 'status',
  ], 'membership edit command')
  if (!commandVersion(result.expectedVersion) || !civilDay(result.startsOn)
    || !(result.endsOn === null
      || (civilDay(result.endsOn) && result.endsOn >= result.startsOn))
    || !['active', 'inactive'].includes(result.status)) invalid('membership edit command')
  return frozen(result)
}

const captureClassFields = (result, kind) => {
  if (!civilDay(result.date)
    || !(result.time === null
      || (typeof result.time === 'string' && WALL_TIME.test(result.time)))
    || !(result.durationMinutes === null || integer(result.durationMinutes, 1, 1440))
    || !(result.topic === null || safeText(result.topic, { maximum: 1000 }))
    || !['cancelled', 'completed', 'scheduled'].includes(result.status)) invalid(kind)
  return result
}

export function captureCreateActivityClassCommand(value) {
  const result = exact(value, [
    'groupId', 'date', 'time', 'durationMinutes', 'topic', 'status',
  ], 'class command')
  identifier(result.groupId, 'group')
  return frozen(captureClassFields(result, 'class command'))
}

export function captureEditActivityClassCommand(value) {
  const result = exact(value, [
    'expectedVersion', 'date', 'time', 'durationMinutes', 'topic', 'status',
  ], 'class edit command')
  if (!commandVersion(result.expectedVersion)) invalid('class edit command')
  return frozen(captureClassFields(result, 'class edit command'))
}

export function captureSetActivityAttendanceCommand(value) {
  const result = exact(value, [
    'participantId', 'status', 'expectedVersion',
  ], 'attendance command')
  identifier(result.participantId, 'participant')
  if (!['absent', 'excused', 'present', 'unknown'].includes(result.status)
    || !commandVersion(result.expectedVersion, { zero: true })) invalid('attendance command')
  return frozen(result)
}

export function captureActivityProjectionJob(value) {
  const result = exact(value, [
    'id', 'importId', 'status', 'afterSourceRecordId', 'totalRecords',
    'processedRecords', 'projectedRecords', 'version', 'updatedAt', 'completedAt',
  ], 'projection job')
  identifier(result.id, 'projectionJob')
  identifier(result.importId, 'import')
  identifier(result.afterSourceRecordId, 'source', { nullable: true })
  const validProgress = integer(result.totalRecords, 0, 10_000)
    && integer(result.processedRecords, 0, result.totalRecords)
    && integer(result.projectedRecords, 0, result.processedRecords)
    && result.projectedRecords === result.processedRecords
    && integer(result.version, 1, Number.MAX_SAFE_INTEGER)
    && canonicalInstant(result.updatedAt)
    && ((result.processedRecords === 0) === (result.afterSourceRecordId === null))
  const validState = (result.status === 'ready' && result.processedRecords === 0
      && result.projectedRecords === 0 && result.completedAt === null)
    || (result.status === 'running' && result.processedRecords > 0
      && result.processedRecords < result.totalRecords
      && result.completedAt === null)
    || (result.status === 'failed' && result.completedAt === null)
    || (result.status === 'complete' && result.processedRecords === result.totalRecords
      && result.projectedRecords === result.totalRecords
      && canonicalInstant(result.completedAt))
  if (!validProgress || !validState) invalid('projection job')
  return frozen(result)
}

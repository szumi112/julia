import {
  captureActivityAttendance,
  captureActivityCharge,
  captureActivityClass,
  captureActivityGroup,
  captureActivityGroupLeader,
  captureActivityLatestPopulatedMonths,
  captureActivityMembership,
  captureActivityMonthWindow,
  captureActivityParticipant,
  captureActivityPayment,
  captureActivityProgram,
  captureActivityWorkspace,
} from './activity-records.js'

const STATE_KEYS = Object.freeze([
  'loadedMonths', 'programsById', 'groupsById', 'groupLeadersById',
  'participantsById', 'membershipsById', 'classesById', 'attendanceById',
  'chargesById', 'paymentsById', 'latestPopulatedMonths', 'latestThroughMonth',
  'authorityGeneration', 'writeEpoch', 'directorySequence',
])

const ENTITY_FACTS = Object.freeze([
  ['programsById', captureActivityProgram],
  ['groupsById', captureActivityGroup],
  ['groupLeadersById', captureActivityGroupLeader],
  ['participantsById', captureActivityParticipant],
  ['membershipsById', captureActivityMembership],
  ['classesById', captureActivityClass],
  ['attendanceById', captureActivityAttendance],
  ['chargesById', captureActivityCharge],
  ['paymentsById', captureActivityPayment],
])

const PAYLOAD_FACTS = Object.freeze([
  ['programs', 'programsById'],
  ['groups', 'groupsById'],
  ['groupLeaders', 'groupLeadersById'],
  ['participants', 'participantsById'],
  ['memberships', 'membershipsById'],
  ['classes', 'classesById'],
  ['attendance', 'attendanceById'],
  ['charges', 'chargesById'],
  ['payments', 'paymentsById'],
])

const TRUSTED_STATES = new WeakSet()

const fail = (message) => { throw new TypeError(`Invalid activity ${message}`) }

const requireFrozen = (value, label) => {
  try {
    if (!Object.isFrozen(value)) fail(label)
  } catch { fail(label) }
}

const exact = (value, keys, label) => {
  let descriptors
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype) fail(label)
    descriptors = Object.getOwnPropertyDescriptors(value)
  } catch { fail(label) }
  const actual = Reflect.ownKeys(descriptors)
  if (actual.length !== keys.length
    || actual.some((key) => typeof key !== 'string' || !keys.includes(key))) fail(label)
  const result = {}
  for (const key of keys) {
    const descriptor = descriptors[key]
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) fail(label)
    result[key] = descriptor.value
  }
  return result
}

const denseFrozenArray = (value, label) => {
  let descriptors
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype
      || !Object.isFrozen(value)) fail(label)
    descriptors = Object.getOwnPropertyDescriptors(value)
  } catch { fail(label) }
  const length = descriptors.length?.value
  if (!Number.isSafeInteger(length) || length < 0
    || Reflect.ownKeys(descriptors).length !== length + 1) fail(label)
  const result = []
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)]
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) fail(label)
    result.push(descriptor.value)
  }
  return result
}

const monthOrdinal = (value) => {
  const captured = captureActivityMonthWindow({ from: value, to: value })
  const [year, month] = captured.from.split('-').map(Number)
  return year * 12 + month - 1
}

const capturedRange = (value, label = 'month range') => {
  try {
    const range = captureActivityMonthWindow(exact(value, ['from', 'to'], label))
    return Object.freeze({
      from: range.from, to: range.to,
      fromOrdinal: monthOrdinal(range.from), toOrdinal: monthOrdinal(range.to),
    })
  } catch { fail(label) }
}

const publicRange = ({ from, to }) => Object.freeze({ from, to })

const normalizeRanges = (current, added) => {
  const ranges = [...current.map((item) => capturedRange(item)), added]
    .sort((left, right) => left.fromOrdinal - right.fromOrdinal)
  const merged = []
  for (const range of ranges) {
    const previous = merged.at(-1)
    if (!previous || range.fromOrdinal > previous.toOrdinal + 1) {
      merged.push({ ...range })
      continue
    }
    if (range.toOrdinal > previous.toOrdinal) {
      previous.to = range.to
      previous.toOrdinal = range.toOrdinal
    }
  }
  return Object.freeze(merged.map(publicRange))
}

const rangeContains = (range, month) => month >= range.from && month <= range.to

const observationInRange = (value, range) => value.membershipKind === 'observation'
  && rangeContains(range, value.period.month)

const classInRange = (value, range) => rangeContains(range, value.date.slice(0, 7))
const chargeInRange = (value, range) => rangeContains(range, value.period.month)

const inAnyLoadedRange = (value, ranges, predicate) => ranges.some(
  (range) => predicate(value, range),
)

const mapFrom = (values) => {
  const result = Object.create(null)
  for (const value of values) {
    if (Object.hasOwn(result, value.id)) fail('entity identifier collision')
    result[value.id] = value
  }
  return Object.freeze(result)
}

const valuesOf = (map) => Object.values(map)

const deeplyFrozenData = (value) => {
  const pending = [value]
  const seen = new WeakSet()
  let nodes = 0
  while (pending.length) {
    const current = pending.pop()
    if (current === null || typeof current !== 'object') continue
    let descriptors
    let array
    try {
      if (seen.has(current) || !Object.isFrozen(current) || ++nodes > 64) return false
      seen.add(current)
      array = Array.isArray(current)
      descriptors = Object.getOwnPropertyDescriptors(current)
    } catch { return false }
    for (const key of Reflect.ownKeys(descriptors)) {
      if (array && key === 'length') continue
      const descriptor = descriptors[key]
      if (typeof key !== 'string' || !descriptor?.enumerable
        || !Object.hasOwn(descriptor, 'value')) return false
      pending.push(descriptor.value)
    }
  }
  return true
}

const mapCaptured = (value, capture, label) => {
  let descriptors
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.getPrototypeOf(value) !== null || !Object.isFrozen(value)) fail(label)
    descriptors = Object.getOwnPropertyDescriptors(value)
  } catch { fail(label) }
  const result = []
  for (const key of Reflect.ownKeys(descriptors)) {
    const descriptor = descriptors[key]
    if (typeof key !== 'string' || !descriptor?.enumerable
      || !Object.hasOwn(descriptor, 'value')) fail(label)
    let captured
    try { captured = capture(descriptor.value) } catch { fail(label) }
    if (captured.id !== key || !deeplyFrozenData(descriptor.value)) fail(label)
    result.push(captured)
  }
  return result
}

const membershipPairKey = (participantId, groupId) => `${participantId}|${groupId}`

const membershipEligibility = (memberships) => {
  const pending = new Map()
  for (const membership of memberships) {
    const key = membershipPairKey(membership.participantId, membership.groupId)
    let entry = pending.get(key)
    if (!entry) {
      entry = { days: new Set(), months: new Set(), intervals: [] }
      pending.set(key, entry)
    }
    if (membership.membershipKind === 'interval') {
      entry.intervals.push({
        startsOn: membership.startsOn,
        endsOn: membership.endsOn ?? '9999-12-31',
      })
    } else if (membership.period.precision === 'day') {
      entry.days.add(membership.period.day)
    } else {
      entry.months.add(membership.period.month)
    }
  }
  const result = new Map()
  for (const [key, entry] of pending) {
    entry.intervals.sort((left, right) => left.startsOn.localeCompare(right.startsOn))
    let maximumEnd = null
    const intervals = entry.intervals.map((interval) => {
      maximumEnd = maximumEnd === null || interval.endsOn > maximumEnd
        ? interval.endsOn : maximumEnd
      return Object.freeze({ startsOn: interval.startsOn, maximumEnd })
    })
    result.set(key, Object.freeze({ days: entry.days, months: entry.months, intervals }))
  }
  return result
}

const eligibleOn = (index, participantId, groupId, day) => {
  const entry = index.get(membershipPairKey(participantId, groupId))
  if (!entry) return false
  if (entry.days.has(day) || entry.months.has(day.slice(0, 7))) return true
  let low = 0
  let high = entry.intervals.length - 1
  let match = -1
  while (low <= high) {
    const middle = Math.floor((low + high) / 2)
    if (entry.intervals[middle].startsOn <= day) {
      match = middle
      low = middle + 1
    } else {
      high = middle - 1
    }
  }
  return match >= 0 && entry.intervals[match].maximumEnd >= day
}

const graph = ({
  programs, groups, groupLeaders, participants, memberships, classes, attendance,
  charges, payments,
}, ranges = null) => {
  const byId = (values) => new Map(values.map((value) => [value.id, value]))
  const programsById = byId(programs)
  const groupsById = byId(groups)
  const participantsById = byId(participants)
  const membershipsById = byId(memberships)
  const classesById = byId(classes)
  const chargesById = byId(charges)
  const eligibility = membershipEligibility(memberships)
  const financeIds = new Set()
  for (const value of groups) {
    if (!programsById.has(value.programId)) fail('group relationship')
  }
  for (const value of groupLeaders) {
    if (!groupsById.has(value.groupId)) fail('group leader relationship')
  }
  for (const value of participants) {
    if (!programsById.has(value.programId)) fail('participant relationship')
  }
  for (const value of memberships) {
    const participant = participantsById.get(value.participantId)
    const targetGroup = groupsById.get(value.groupId)
    if (!participant || !targetGroup || !programsById.has(value.programId)
      || participant.programId !== value.programId
      || targetGroup.programId !== value.programId
      || (ranges && value.membershipKind === 'observation'
        && !inAnyLoadedRange(value, ranges, observationInRange))) {
      fail('membership relationship')
    }
  }
  for (const value of classes) {
    if (!groupsById.has(value.groupId)
      || (ranges && !inAnyLoadedRange(value, ranges, classInRange))) {
      fail('class relationship')
    }
  }
  for (const value of attendance) {
    const targetClass = classesById.get(value.classId)
    const targetParticipant = participantsById.get(value.participantId)
    const targetGroup = targetClass ? groupsById.get(targetClass.groupId) : null
    if (!targetClass || !targetParticipant || !targetGroup
      || targetParticipant.programId !== targetGroup.programId
      || !eligibleOn(
        eligibility, value.participantId, targetGroup.id, targetClass.date,
      )) fail('attendance relationship')
  }
  for (const value of charges) {
    const targetParticipant = participantsById.get(value.participantId)
    const targetGroup = value.groupId === null ? null : groupsById.get(value.groupId)
    const targetMembership = value.membershipId === null
      ? null : membershipsById.get(value.membershipId)
    if (!targetParticipant || !programsById.has(value.programId)
      || targetParticipant.programId !== value.programId
      || (value.groupId !== null && (!targetGroup || targetGroup.programId !== value.programId))
      || (value.membershipId !== null && (!targetMembership
        || targetMembership.participantId !== value.participantId
        || targetMembership.programId !== value.programId
        || targetMembership.groupId !== value.groupId))
      || financeIds.has(value.financeEntryId)
      || (ranges && !inAnyLoadedRange(value, ranges, chargeInRange))) {
      fail('charge relationship')
    }
    financeIds.add(value.financeEntryId)
  }
  for (const value of payments) {
    if (!chargesById.has(value.chargeId) || financeIds.has(value.financeEntryId)) {
      fail('payment relationship')
    }
    financeIds.add(value.financeEntryId)
  }
}

const latestFor = (charges, memberships, programId, through) => [
  ...charges.map((value) => ({
    active: value.status === 'active', month: value.period.month,
    programId: value.programId,
  })),
  ...memberships.map((value) => ({
    active: value.status === 'active' && value.membershipKind === 'observation',
    month: value.period.month, programId: value.programId,
  })),
].reduce((latest, value) => {
  const month = value.active && value.programId === programId && value.month <= through
    ? value.month : null
  return month !== null && (latest === null || month > latest) ? month : latest
}, null)

const validateLatest = (latest, charges, memberships, through) => {
  for (const [kind, programId] of [['tus', 'apg_tus'], ['english', 'apg_english']]) {
    if (latest[kind] !== null && latest[kind] > through) fail('latest populated month')
    const visible = latestFor(charges, memberships, programId, through)
    if (visible !== null && (latest[kind] === null || latest[kind] < visible)) {
      fail('latest populated month')
    }
  }
}

const stateFrom = (value) => {
  const state = Object.freeze(value)
  TRUSTED_STATES.add(state)
  return state
}

const authenticateState = (state) => {
  const raw = exact(state, STATE_KEYS, 'loaded state')
  requireFrozen(state, 'loaded state')
  if (!Number.isSafeInteger(raw.authorityGeneration)
    || raw.authorityGeneration < 0 || !Number.isSafeInteger(raw.writeEpoch)
    || raw.writeEpoch < 0 || !Number.isSafeInteger(raw.directorySequence)
    || raw.directorySequence < 0) fail('loaded state')
  let latestThroughMonth
  try {
    latestThroughMonth = captureActivityMonthWindow({
      from: raw.latestThroughMonth, to: raw.latestThroughMonth,
    }).from
  } catch { fail('loaded state') }
  const loadedMonths = denseFrozenArray(raw.loadedMonths, 'loaded months')
    .map((item) => {
      requireFrozen(item, 'loaded months')
      return capturedRange(item)
    })
  for (let index = 1; index < loadedMonths.length; index += 1) {
    if (loadedMonths[index].fromOrdinal <= loadedMonths[index - 1].toOrdinal + 1) {
      fail('loaded months')
    }
  }
  const values = {}
  for (const [key, capture] of ENTITY_FACTS) {
    values[key] = mapCaptured(raw[key], capture, key)
  }
  requireFrozen(raw.latestPopulatedMonths, 'latest populated months')
  let latestPopulatedMonths
  try { latestPopulatedMonths = captureActivityLatestPopulatedMonths(raw.latestPopulatedMonths) } catch {
    fail('latest populated months')
  }
  graph({
    programs: values.programsById, groups: values.groupsById,
    groupLeaders: values.groupLeadersById, participants: values.participantsById,
    memberships: values.membershipsById, classes: values.classesById,
    attendance: values.attendanceById, charges: values.chargesById,
    payments: values.paymentsById,
  }, loadedMonths)
  validateLatest(
    latestPopulatedMonths, values.chargesById, values.membershipsById, latestThroughMonth,
  )
  const canonicalState = TRUSTED_STATES.has(state) ? state : stateFrom({
    loadedMonths: Object.freeze(loadedMonths.map(publicRange)),
    ...Object.fromEntries(ENTITY_FACTS.map(([key]) => [key, mapFrom(values[key])])),
    latestPopulatedMonths,
    latestThroughMonth,
    authorityGeneration: raw.authorityGeneration,
    writeEpoch: raw.writeEpoch,
    directorySequence: raw.directorySequence,
  })
  return Object.freeze({
    state: canonicalState,
    loadedMonths: canonicalState.loadedMonths,
    latestPopulatedMonths: canonicalState.latestPopulatedMonths,
    latestThroughMonth: canonicalState.latestThroughMonth,
    authorityGeneration: raw.authorityGeneration, writeEpoch: raw.writeEpoch,
    directorySequence: raw.directorySequence,
    ...Object.fromEntries(ENTITY_FACTS.map(([key]) => [key, canonicalState[key]])),
  })
}

const captureLoad = (value) => {
  const raw = exact(
    value, ['from', 'to', 'authorityGeneration', 'writeEpoch', 'loadSequence'], 'load capture',
  )
  const range = capturedRange({ from: raw.from, to: raw.to })
  if (!Number.isSafeInteger(raw.authorityGeneration) || raw.authorityGeneration < 0
    || !Number.isSafeInteger(raw.writeEpoch) || raw.writeEpoch < 0
    || !Number.isSafeInteger(raw.loadSequence) || raw.loadSequence < 1) fail('load capture')
  return Object.freeze({ ...range, ...raw })
}

export const captureLoadedActivitiesState = (state) => authenticateState(state).state

const capturePayload = (rawPayload, capture) => {
  let payload
  try {
    payload = captureActivityWorkspace(rawPayload)
  } catch { fail('workspace payload') }
  if (payload.from !== capture.from || payload.to !== capture.to || payload.complete !== true) {
    fail('workspace payload')
  }
  const range = publicRange(capture)
  graph(payload, [range])
  validateLatest(
    payload.latestPopulatedMonths, payload.charges, payload.memberships,
    payload.currentDay.slice(0, 7),
  )
  return payload
}

const emptyMap = () => Object.freeze(Object.create(null))
const emptyLatest = () => Object.freeze({ tus: null, english: null })

export const createLoadedActivitiesState = () => stateFrom({
  loadedMonths: Object.freeze([]),
  programsById: emptyMap(),
  groupsById: emptyMap(),
  groupLeadersById: emptyMap(),
  participantsById: emptyMap(),
  membershipsById: emptyMap(),
  classesById: emptyMap(),
  attendanceById: emptyMap(),
  chargesById: emptyMap(),
  paymentsById: emptyMap(),
  latestPopulatedMonths: emptyLatest(),
  latestThroughMonth: '0001-01',
  authorityGeneration: 0,
  writeEpoch: 0,
  directorySequence: 0,
})

export const captureLoadedActivitiesLoad = (state, requested, requestedSequence) => {
  const current = authenticateState(state)
  const range = capturedRange(requested)
  const loadSequence = requestedSequence === undefined
    ? current.directorySequence + 1 : requestedSequence
  if (!Number.isSafeInteger(loadSequence) || loadSequence < 1) fail('load sequence')
  return Object.freeze({
    from: range.from, to: range.to,
    authorityGeneration: current.authorityGeneration,
    writeEpoch: current.writeEpoch,
    loadSequence,
  })
}

export const isActivityWindowLoaded = (state, requested) => {
  const current = authenticateState(state)
  const wanted = capturedRange(requested)
  return current.loadedMonths.some((item) => item.from <= wanted.from && item.to >= wanted.to)
}

export const activityLoadRequestKey = (state, requested) => {
  const current = authenticateState(state)
  const range = capturedRange(requested)
  return `${current.authorityGeneration}|${range.from}|${range.to}`
}

export const resetLoadedActivitiesAuthority = (state) => {
  const current = authenticateState(state)
  if (current.authorityGeneration === Number.MAX_SAFE_INTEGER) {
    throw new RangeError('Activity authority generation exhausted')
  }
  return stateFrom({
    ...createLoadedActivitiesState(), authorityGeneration: current.authorityGeneration + 1,
  })
}

export const recordLoadedActivitiesWrite = (state) => {
  const current = authenticateState(state)
  if (current.writeEpoch === Number.MAX_SAFE_INTEGER) {
    throw new RangeError('Activity write epoch exhausted')
  }
  return stateFrom({
    loadedMonths: current.loadedMonths,
    ...Object.fromEntries(ENTITY_FACTS.map(([key]) => [key, current[key]])),
    latestPopulatedMonths: current.latestPopulatedMonths,
    latestThroughMonth: current.latestThroughMonth,
    authorityGeneration: current.authorityGeneration,
    writeEpoch: current.writeEpoch + 1,
    directorySequence: current.directorySequence,
  })
}

const retainedByWindow = (currentValues, payloadValues, range, coveredBy) => {
  const retained = currentValues.filter((value) => !coveredBy(value, range))
  const ids = new Set(retained.map(({ id }) => id))
  for (const value of payloadValues) {
    if (ids.has(value.id)) fail('entity collision outside replaced window')
    ids.add(value.id)
    retained.push(value)
  }
  return retained
}

const retainedIntervalsRequiredBy = ({
  currentMemberships, payloadMemberships, memberships, classes,
  retainedAttendance, retainedCharges,
}) => {
  const payloadIds = new Set(payloadMemberships.map(({ id }) => id))
  const candidates = currentMemberships.filter((value) => (
    value.membershipKind === 'interval' && !payloadIds.has(value.id)
  ))
  const candidatesById = new Map(candidates.map((value) => [value.id, value]))
  const candidatesByPair = new Map()
  for (const candidate of candidates) {
    const key = membershipPairKey(candidate.participantId, candidate.groupId)
    const values = candidatesByPair.get(key) ?? []
    values.push(candidate)
    candidatesByPair.set(key, values)
  }
  for (const values of candidatesByPair.values()) {
    values.sort((left, right) => left.startsOn.localeCompare(right.startsOn))
  }
  const requiredIds = new Set()
  for (const charge of retainedCharges) {
    if (charge.membershipId !== null && candidatesById.has(charge.membershipId)) {
      requiredIds.add(charge.membershipId)
    }
  }
  const baseEligibility = membershipEligibility(memberships)
  const classesById = new Map(classes.map((value) => [value.id, value]))
  for (const mark of retainedAttendance) {
    const activityClass = classesById.get(mark.classId)
    if (!activityClass || eligibleOn(
      baseEligibility, mark.participantId, activityClass.groupId, activityClass.date,
    )) continue
    const candidatesForPair = candidatesByPair.get(
      membershipPairKey(mark.participantId, activityClass.groupId),
    ) ?? []
    let low = 0
    let high = candidatesForPair.length - 1
    let match = null
    while (low <= high) {
      const middle = (low + high) >> 1
      const candidate = candidatesForPair[middle]
      if (candidate.startsOn <= activityClass.date) {
        match = candidate
        low = middle + 1
      } else high = middle - 1
    }
    if (match && (match.endsOn === null || match.endsOn >= activityClass.date)) {
      requiredIds.add(match.id)
    }
  }
  return candidates.filter(({ id }) => requiredIds.has(id))
}

const choose = (payloadById, currentById, id, label) => {
  const value = payloadById.get(id) ?? currentById[id]
  if (!value) fail(`${label} dependency`)
  return value
}

const payloadRegressesVersion = (current, payload) => PAYLOAD_FACTS.some(
  ([payloadKey, stateKey]) => payload[payloadKey].some((value) => {
    const existing = current[stateKey][value.id]
    if (existing === undefined) return false
    if (value.version === existing.version
      && JSON.stringify(value) !== JSON.stringify(existing)) fail('entity version equivocation')
    return value.version < existing.version
  }),
)

export const mergeLoadedActivitiesLoad = (state, rawCapture, rawPayload) => {
  const current = authenticateState(state)
  const capture = captureLoad(rawCapture)
  if (capture.authorityGeneration !== current.authorityGeneration) {
    return Object.freeze({ state: current.state, outcome: 'ignored-authority', refetch: false })
  }
  if (capture.writeEpoch !== current.writeEpoch) {
    return Object.freeze({ state: current.state, outcome: 'stale-write', refetch: true })
  }
  if (capture.loadSequence < current.directorySequence) {
    return Object.freeze({ state: current.state, outcome: 'stale-directory', refetch: true })
  }
  const payload = capturePayload(rawPayload, capture)
  const responseMonth = payload.currentDay.slice(0, 7)
  if (responseMonth < current.latestThroughMonth) {
    return Object.freeze({ state: current.state, outcome: 'stale-directory', refetch: true })
  }
  if (payloadRegressesVersion(current, payload)) {
    return Object.freeze({ state: current.state, outcome: 'stale-directory', refetch: true })
  }
  const range = publicRange(capture)
  const observations = retainedByWindow(
    valuesOf(current.membershipsById).filter(
      ({ membershipKind }) => membershipKind === 'observation',
    ),
    payload.memberships.filter(({ membershipKind }) => membershipKind === 'observation'),
    range,
    observationInRange,
  )
  const payloadIntervals = payload.memberships.filter(
    ({ membershipKind }) => membershipKind === 'interval',
  )
  const classes = retainedByWindow(
    valuesOf(current.classesById), payload.classes, range, classInRange,
  )
  const retainedCharges = valuesOf(current.chargesById).filter(
    (value) => !chargeInRange(value, range),
  )
  const charges = [...retainedCharges, ...payload.charges]
  const classIds = new Set(classes.map(({ id }) => id))
  const payloadClassIds = new Set(payload.classes.map(({ id }) => id))
  const retainedAttendance = valuesOf(current.attendanceById).filter(
    ({ classId }) => classIds.has(classId) && !payloadClassIds.has(classId),
  )
  const attendance = [
    ...retainedAttendance,
    ...payload.attendance,
  ]
  const baseMemberships = [...payloadIntervals, ...observations]
  const memberships = [
    ...baseMemberships,
    ...retainedIntervalsRequiredBy({
      currentMemberships: valuesOf(current.membershipsById),
      payloadMemberships: payload.memberships,
      memberships: baseMemberships,
      classes,
      retainedAttendance,
      retainedCharges,
    }),
  ]
  const payments = [...payload.payments]

  const payloadPrograms = new Map(payload.programs.map((value) => [value.id, value]))
  const payloadGroups = new Map(payload.groups.map((value) => [value.id, value]))
  const payloadParticipants = new Map(payload.participants.map((value) => [value.id, value]))
  const referencedParticipants = new Set([
    ...memberships.map(({ participantId }) => participantId),
    ...attendance.map(({ participantId }) => participantId),
    ...charges.map(({ participantId }) => participantId),
  ])
  const participants = [...payload.participants]
  const participantIds = new Set(participants.map(({ id }) => id))
  for (const id of referencedParticipants) {
    if (!participantIds.has(id)) {
      participants.push(choose(
        payloadParticipants, current.participantsById, id, 'participant',
      ))
      participantIds.add(id)
    }
  }
  const referencedGroups = new Set([
    ...memberships.map(({ groupId }) => groupId),
    ...classes.map(({ groupId }) => groupId),
    ...charges.map(({ groupId }) => groupId).filter(Boolean),
  ])
  const groups = [...payload.groups]
  const groupIds = new Set(groups.map(({ id }) => id))
  for (const id of referencedGroups) {
    if (!groupIds.has(id)) {
      groups.push(choose(payloadGroups, current.groupsById, id, 'group'))
      groupIds.add(id)
    }
  }
  const groupLeaders = [...payload.groupLeaders]
  const referencedPrograms = new Set([
    ...groups.map(({ programId }) => programId),
    ...participants.map(({ programId }) => programId),
    ...memberships.map(({ programId }) => programId),
    ...charges.map(({ programId }) => programId),
  ])
  const programs = [...payload.programs]
  const programIds = new Set(programs.map(({ id }) => id))
  for (const id of referencedPrograms) {
    if (!programIds.has(id)) {
      programs.push(choose(payloadPrograms, current.programsById, id, 'program'))
      programIds.add(id)
    }
  }
  const latestPopulatedMonths = payload.latestPopulatedMonths
  graph({
    programs, groups, groupLeaders, participants, memberships, classes, attendance,
    charges, payments,
  }, normalizeRanges(current.loadedMonths, capturedRange(range)))
  validateLatest(latestPopulatedMonths, charges, memberships, responseMonth)
  const next = stateFrom({
    loadedMonths: normalizeRanges(current.loadedMonths, capturedRange(range)),
    programsById: mapFrom(programs),
    groupsById: mapFrom(groups),
    groupLeadersById: mapFrom(groupLeaders),
    participantsById: mapFrom(participants),
    membershipsById: mapFrom(memberships),
    classesById: mapFrom(classes),
    attendanceById: mapFrom(attendance),
    chargesById: mapFrom(charges),
    paymentsById: mapFrom(payments),
    latestPopulatedMonths,
    latestThroughMonth: responseMonth,
    authorityGeneration: current.authorityGeneration,
    writeEpoch: current.writeEpoch,
    directorySequence: capture.loadSequence,
  })
  authenticateState(next)
  return Object.freeze({ state: next, outcome: 'merged', refetch: false })
}

// Mock data — deterministic, generated relative to "today" so the demo
// is always richly populated (past months + upcoming sessions).
import { toISODate, monthKey } from './format.js'

// seeded PRNG (mulberry32) — deterministic across reloads
const mulberry32 = (seed) => () => {
  seed |= 0
  seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

const rand = mulberry32(20260611)
const pick = (arr) => arr[Math.floor(rand() * arr.length)]
// separate streams so new fields never shift the original generation
const methodRand = mulberry32(20260712)
const tusRand = mulberry32(20260713)

export const PSYCHOLOGISTS = [
  {
    id: 'p1',
    name: 'Julia Wolanin',
    title: 'dr',
    spec: 'Założycielka · Terapia poznawczo-behawioralna',
    color: '#964d5f',
    soft: '#f0dcda',
    email: 'julia@aurelia.pl',
    phone: '+48 601 224 187',
    room: 'Gabinet 1',
    rate: 220,
  },
  {
    id: 'p2',
    name: 'Marta Zielińska',
    title: 'mgr',
    spec: 'Terapia par i rodzin',
    color: '#c26b4b',
    soft: '#f3e0d6',
    email: 'marta@aurelia.pl',
    phone: '+48 604 882 341',
    room: 'Gabinet 2',
    rate: 260,
  },
  {
    id: 'p3',
    name: 'Karolina Wójcik',
    title: 'mgr',
    spec: 'Psychoterapia dzieci i młodzieży',
    color: '#9d8190',
    soft: '#e9dee6',
    email: 'karolina@aurelia.pl',
    phone: '+48 503 119 906',
    room: 'Gabinet 3',
    rate: 190,
  },
  {
    id: 'p4',
    name: 'Anna Lewandowska',
    title: 'dr',
    spec: 'Terapia traumy · EMDR',
    color: '#ac8a4e',
    soft: '#ece1c8',
    email: 'anna@aurelia.pl',
    phone: '+48 698 450 233',
    room: 'Gabinet 4',
    rate: 240,
  },
]

export const DEMO_ROLES = [
  { id: 'owner', label: 'Właścicielka', name: 'Julia Wolanin', psychId: 'p1', scope: 'centre' },
  { id: 'coordinator', label: 'Koordynatorka', name: 'Maja Nowak', psychId: null, scope: 'centre' },
  { id: 'therapist', label: 'Specjalistka', name: 'Marta Zielińska', psychId: 'p2', scope: 'own' },
]

const NOTE_POOL = [
  'Kontynuujemy pracę nad technikami regulacji emocji. Zalecane ćwiczenia oddechowe 2× dziennie.',
  'Widoczny postęp w obszarze asertywności. Dzienniczek myśli automatycznych — kontynuacja.',
  'Omówiono strategie radzenia sobie ze stresem w pracy. Praktyka uważności 10 min wieczorem.',
  'Zalecona higiena snu: stałe pory, ograniczenie ekranów po 21:00. Obserwacja nastroju.',
  'Praca nad komunikacją w relacji. Ćwiczenie „aktywne słuchanie” do następnej sesji.',
  'Ekspozycja stopniowana przebiega zgodnie z planem. Utrzymujemy częstotliwość spotkań.',
  'Sesja poświęcona psychoedukacji nt. lęku. Materiały przekazane, omówienie za tydzień.',
  'Stabilizacja przed dalszą pracą z traumą. Ćwiczenie „bezpieczne miejsce” codziennie.',
  'Zauważalna poprawa frekwencji szkolnej. Kontynuacja pracy nad samooceną.',
  'Plan aktywności behawioralnej na kolejny tydzień ustalony wspólnie z klientem.',
  'Przegląd celów terapii — dwa z trzech osiągnięte. Aktualizacja kontraktu terapeutycznego.',
  'Wskazana konsultacja psychiatryczna w celu oceny farmakoterapii. Klient wyraził zgodę.',
]

const CLIENT_DEFS = [
  ['Zofia Mazur', 'p1'], ['Aleksandra Krawczyk', 'p1'], ['Tomasz Bąk', 'p1'],
  ['Michał Pawlak', 'p1'], ['Ewa Janik', 'p1'],
  ['Anna i Paweł Romanowscy', 'p2'], ['Magda i Tomasz Wielgosz', 'p2'],
  ['Joanna Madej', 'p2'], ['Marcin Duda', 'p2'],
  ['Staś Przybylski', 'p3'], ['Oliwia Mróz', 'p3'], ['Hanna Stępień', 'p3'],
  ['Kuba Kalinowski', 'p3'], ['Alicja Piątek', 'p3'],
  ['Natalia Górska', 'p4'], ['Bartosz Sikora', 'p4'], ['Kamil Wrona', 'p4'],
  ['Magdalena Sobczak', 'p4'], ['Łukasz Czarnecki', 'p4'],
]

const slug = (name) =>
  name
    .toLowerCase()
    .replace(/[ąćęłńóśźż]/g, (c) => 'acelnoszz'['ąćęłńóśźż'.indexOf(c)])
    .replace(/[^a-z]+/g, '.')
    .replace(/^\.|\.$/g, '')

const TODAY = new Date()
TODAY.setHours(0, 0, 0, 0)

export const CURRENT_MONTH = monthKey(TODAY)

const daysAgo = (n) => {
  const d = new Date(TODAY)
  d.setDate(d.getDate() - n)
  return d
}

export const CLIENTS = CLIENT_DEFS.map(([name, psychId], i) => {
  const sinceDays = 60 + Math.floor(rand() * 320)
  const noteCount = 1 + Math.floor(rand() * 3)
  const notes = Array.from({ length: noteCount }, (_, k) => ({
    date: toISODate(daysAgo(7 + k * (12 + Math.floor(rand() * 16)))),
    text: pick(NOTE_POOL),
  })).sort((a, b) => (a.date < b.date ? 1 : -1))
  return {
    id: `c${i + 1}`,
    name,
    psychId,
    email: `${slug(name)}@gmail.com`,
    phone: `+48 ${500 + Math.floor(rand() * 399)} ${100 + Math.floor(rand() * 899)} ${100 + Math.floor(rand() * 899)}`,
    since: toISODate(daysAgo(sinceDays)),
    status: rand() < 0.85 ? 'active' : 'paused',
    notes,
    familyId: null,
    familyRole: null,
  }
})

// --- session generation -------------------------------------------------
// Each client has a stable weekly slot (weekday + hour, unique per
// psychologist). Sessions span ~15 weeks back and ~3 weeks forward.

const usedSlots = new Set()
const clientSlots = CLIENTS.map((c) => {
  let wd, hour, key
  do {
    wd = 1 + Math.floor(rand() * 5) // Mon–Fri
    hour = 8 + Math.floor(rand() * 11) // 8:00–18:00
    key = `${c.psychId}|${wd}|${hour}`
  } while (usedSlots.has(key))
  usedSlots.add(key)
  return { wd, hour }
})

const sessions = []
let sid = 1

CLIENTS.forEach((client, ci) => {
  const psych = PSYCHOLOGISTS.find((p) => p.id === client.psychId)
  const { wd, hour } = clientSlots[ci]
  const isCouple = client.psychId === 'p2'
  const duration = isCouple ? 80 : rand() < 0.2 ? 60 : 50
  const amount = psych.rate + (duration === 60 ? 30 : 0)
  const cadence = rand() < 0.7 ? 7 : 14 // weekly or biweekly
  const attendRate = client.status === 'paused' ? 0.45 : 0.88

  for (let weekOffset = -15; weekOffset <= 3; weekOffset++) {
    // align to the client's weekday in that week
    const d = new Date(TODAY)
    d.setDate(d.getDate() - d.getDay() + wd + weekOffset * 7)
    if (cadence === 14 && Math.abs(weekOffset) % 2 === 1) continue
    if (rand() > attendRate) continue
    const isPast = d < TODAY || (toISODate(d) === toISODate(TODAY) && hour < new Date().getHours())

    let status, payment, paidAmount
    if (!isPast) {
      status = 'scheduled'
      payment = 'unpaid'
    } else {
      const r = rand()
      status = r < 0.84 ? 'completed' : r < 0.93 ? 'cancelled' : 'noshow'
      if (status === 'completed') {
        const pr = rand()
        payment = pr < 0.68 ? 'paid' : pr < 0.87 ? 'unpaid' : 'partial'
        if (payment === 'partial') paidAmount = Math.round(amount / 2 / 10) * 10
      } else if (status === 'noshow') {
        payment = rand() < 0.3 ? 'paid' : 'unpaid'
      } else {
        payment = 'unpaid'
      }
    }

    sessions.push({
      id: `s${sid++}`,
      clientId: client.id,
      psychId: client.psychId,
      date: toISODate(d),
      time: `${String(hour).padStart(2, '0')}:00`,
      duration,
      amount,
      status,
      payment,
      paidAmount: paidAmount || 0,
      method:
        payment === 'paid' || payment === 'partial'
          ? methodRand() < 0.45 ? 'card' : methodRand() < 0.55 ? 'cash' : 'transfer'
          : null,
      note: status === 'completed' && rand() < 0.35 ? pick(NOTE_POOL) : '',
    })
  }
})

// Family demo — a parent and a child enrolled as separate clients (different
// surnames), linked as one family. Hand-written after the generator so the
// seeded stream stays stable.
const FAMILY_CLIENTS = [
  {
    id: 'c20', name: 'Renata Gawrys', psychId: 'p3',
    email: 'renata.gawrys@gmail.com', phone: '+48 512 384 664',
    since: toISODate(daysAgo(45)), status: 'active',
    notes: [{ date: toISODate(daysAgo(38)), text: 'Konsultacja rodzicielska przed rozpoczęciem terapii syna. Omówiony wywiad rozwojowy.' }],
    familyId: 'f1', familyRole: 'rodzic',
  },
  {
    id: 'c21', name: 'Ignacy Borkowski', psychId: 'p3',
    email: 'ignacy.borkowski@gmail.com', phone: '+48 512 384 664',
    since: toISODate(daysAgo(31)), status: 'active',
    notes: [{ date: toISODate(daysAgo(10)), text: 'Praca nad regulacją emocji przez zabawę. Dobra współpraca, kontynuujemy.' }],
    familyId: 'f1', familyRole: 'dziecko',
  },
]
CLIENTS.push(...FAMILY_CLIENTS)

const FAMILY_SESSIONS = [
  { id: 'demo-family-parent', clientId: 'c20', psychId: 'p3', date: toISODate(daysAgo(38)), time: '11:00', duration: 50, amount: 190, status: 'completed', payment: 'paid', paidAmount: 190, method: 'transfer', note: '' },
  { id: 'demo-family-child-past', clientId: 'c21', psychId: 'p3', date: toISODate(daysAgo(10)), time: '15:00', duration: 50, amount: 190, status: 'completed', payment: 'paid', paidAmount: 190, method: 'cash', note: '' },
  { id: 'demo-family-child-next', clientId: 'c21', psychId: 'p3', date: toISODate(daysAgo(-4)), time: '15:00', duration: 50, amount: 190, status: 'scheduled', payment: 'unpaid', paidAmount: 0, method: null, note: '' },
]
sessions.push(...FAMILY_SESSIONS)

const scenarioDate = toISODate(TODAY)
const DEMO_SCENARIOS = [
  { id: 'demo-owner-completed', clientId: 'c1', psychId: 'p1', date: scenarioDate, time: '08:00', duration: 50, amount: 220, status: 'completed', payment: 'paid', paidAmount: 220, method: 'card', note: '' },
  { id: 'demo-therapist-next', clientId: 'c6', psychId: 'p2', date: scenarioDate, time: '10:00', duration: 80, amount: 260, status: 'scheduled', payment: 'unpaid', paidAmount: 0, method: null, note: '' },
  { id: 'demo-cancelled', clientId: 'c10', psychId: 'p3', date: scenarioDate, time: '12:00', duration: 50, amount: 190, status: 'cancelled', payment: 'unpaid', paidAmount: 0, method: null, note: '' },
  { id: 'demo-noshow', clientId: 'c15', psychId: 'p4', date: scenarioDate, time: '13:00', duration: 50, amount: 240, status: 'noshow', payment: 'unpaid', paidAmount: 0, method: null, note: '' },
  { id: 'demo-unpaid', clientId: 'c2', psychId: 'p1', date: scenarioDate, time: '14:00', duration: 50, amount: 220, status: 'completed', payment: 'unpaid', paidAmount: 0, method: null, note: '' },
  { id: 'demo-partial', clientId: 'c7', psychId: 'p2', date: scenarioDate, time: '15:00', duration: 80, amount: 260, status: 'completed', payment: 'partial', paidAmount: 130, method: 'cash', note: '' },
  { id: 'demo-overlap', clientId: 'c3', psychId: 'p1', date: scenarioDate, time: '14:00', duration: 50, amount: 220, status: 'scheduled', payment: 'unpaid', paidAmount: 0, method: null, note: '' },
]
sessions.push(...DEMO_SCENARIOS)

sessions.sort((a, b) => (a.date + a.time < b.date + b.time ? -1 : 1))

export const SESSIONS = sessions

// Team board — lightweight in-memory announcements.
export const POSTS = [
  {
    id: 'b1',
    author: 'Julia Wolanin',
    text: 'Superwizja zespołowa w piątek o 14:00 — sala konferencyjna. Przynieście opisy trudniejszych przypadków.',
    date: toISODate(daysAgo(1)),
    time: '09:12',
  },
  {
    id: 'b2',
    author: 'Marta Zielińska',
    text: 'W kuchni czeka nowa herbata z hibiskusa — częstujcie się między sesjami ☕',
    date: toISODate(daysAgo(3)),
    time: '15:40',
  },
]

// --- Grupa TUS ----------------------------------------------------------
// Group social-skills classes for kids — a category separate from the 1:1
// sessions. Kids belong to age groups; classes are weekly with per-kid
// attendance; parents pay a monthly fee (mirrors the practice's Excel tab).

export const TUS_GROUPS = [
  { id: 'g1', name: 'Grupa TUS 5–6 lat', age: '5–6 lat', leaderIds: ['p2', 'p3'], weekday: 3, time: '16:00', fee: 300 },
  { id: 'g2', name: 'Grupa TUS 4 lata', age: '4 lata', leaderIds: ['p3', 'p4'], weekday: 4, time: '17:00', fee: 300 },
]

const TUS_KID_DEFS = [
  ['Hania Malik', 5, 'g1', 'Ewa Malik', true],
  ['Staś Urban', 6, 'g1', 'Karol Urban', true],
  ['Pola Dec', 5, 'g1', 'Sylwia Nowicka', true],
  ['Ignacy Lis', 6, 'g1', 'Beata Lis', false],
  ['Maja Cichoń', 5, 'g1', 'Tomasz Cichoń', true],
  ['Antek Duda', 4, 'g2', 'Marta Duda', true],
  ['Zosia Kral', 4, 'g2', 'Piotr Kral', true],
  ['Franek Bąk', 4, 'g2', 'Aneta Wilk', false],
  ['Lena Szulc', 4, 'g2', 'Igor Szulc', true],
  ['Borys Cygan', 5, null, 'Alina Cygan', false],
  ['Tosia Wrona', 6, null, 'Jan Wrona', false],
]

export const TUS_KIDS = TUS_KID_DEFS.map(([name, age, groupId, parentName, regulationsSigned], i) => ({
  id: `k${i + 1}`,
  name,
  age,
  groupId,
  parentName,
  parentPhone: `+48 ${601 + i} ${230 + i * 11} ${402 + i * 7}`,
  regulationsSigned,
  note: '',
}))

const TUS_TOPICS = [
  'Rozpoznawanie emocji',
  'Czekanie na swoją kolej',
  'Współpraca w parze',
  'Proszenie o pomoc',
  'Przegrywanie bez złości',
  'Uważne słuchanie',
  'Rozwiązywanie konfliktów',
  'Mowa ciała',
  'Komplementy i podziękowania',
  'Wspólna zabawa — zasady',
]

export const TUS_CLASSES = []
let tcId = 1
for (const group of TUS_GROUPS) {
  const kids = TUS_KIDS.filter((k) => k.groupId === group.id)
  for (let weekOffset = -10; weekOffset <= 3; weekOffset++) {
    const d = new Date(TODAY)
    d.setDate(d.getDate() - d.getDay() + group.weekday + weekOffset * 7)
    const iso = toISODate(d)
    const past = iso <= toISODate(TODAY)
    const attendance = {}
    if (past) for (const kid of kids) attendance[kid.id] = tusRand() < 0.85
    TUS_CLASSES.push({
      id: `tc${tcId++}`,
      groupId: group.id,
      date: iso,
      time: group.time,
      topic: past ? TUS_TOPICS[(weekOffset + 10) % TUS_TOPICS.length] : '',
      attendance,
    })
  }
}
TUS_CLASSES.sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time))

export const TUS_PAYMENTS = []
let tpId = 1
const tusPaidMonths = [...new Set(TUS_CLASSES.filter((c) => c.date <= toISODate(TODAY)).map((c) => monthKey(c.date)))].sort()
for (const ym of tusPaidMonths) {
  for (const kid of TUS_KIDS.filter((k) => k.groupId)) {
    const group = TUS_GROUPS.find((g) => g.id === kid.groupId)
    const current = ym === CURRENT_MONTH
    const paid = current ? tusRand() < 0.55 : true
    TUS_PAYMENTS.push({
      id: `tp${tpId++}`,
      kidId: kid.id,
      ym,
      amount: group.fee,
      status: paid ? 'paid' : 'unpaid',
      method: paid ? (tusRand() < 0.7 ? 'transfer' : tusRand() < 0.5 ? 'cash' : 'card') : null,
      invoice: paid && tusRand() < 0.6,
      paidDate: paid ? `${ym}-05` : null,
      note: kid.id === 'k3' ? 'przelew od przedszkola (faktura na placówkę)' : '',
    })
  }
}

export const INITIAL_STATE = {
  user: { name: 'Julia Wolanin', role: 'Założycielka', email: 'julia@aurelia.pl', psychId: 'p1' },
  demoRoleId: 'owner',
  center: {
    name: 'Aurelia — Centrum Psychoterapii',
    address: 'ul. Złota 12/3, 58-500 Jelenia Góra',
    phone: '+48 22 412 80 90',
    email: 'kontakt@aurelia.pl',
  },
  psychologists: PSYCHOLOGISTS,
  clients: CLIENTS,
  sessions: SESSIONS,
  posts: POSTS,
  tusGroups: TUS_GROUPS,
  tusKids: TUS_KIDS,
  tusClasses: TUS_CLASSES,
  tusPayments: TUS_PAYMENTS,
  prefs: { reduceMotion: false, weekendsInCalendar: true, gcalConnected: false },
}

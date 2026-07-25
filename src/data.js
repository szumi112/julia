// Mock data — deterministic, generated relative to "today" so the demo
// is always richly populated (past months + upcoming sessions).
//
// The centre, team, price list and TUS offer mirror bearwithme.pl; every
// child, parent and session below is fictional.
import { toISODate, monthKey, pad2, isBillable } from './format.js'
import { STANDARD_SERVICE, amountFor, durationFor } from './services.js'

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

// The team as listed on bearwithme.pl/Specjaliści — the four who run
// sessions. Julia Wolanin coordinates the centre and appears in DEMO_ROLES
// rather than here, because she does not carry her own caseload.
export const PSYCHOLOGISTS = [
  {
    id: 'p1',
    name: 'Anna Maria Janowska',
    title: 'mgr',
    spec: 'Główna psycholożka · Diagnoza i terapia',
    color: '#b03a1c',
    soft: '#fce8e2',
    email: 'anna@bearwithme.pl',
    phone: '+48 601 224 187',
    room: 'Gabinet 1',
    rate: 180,
    weeklyCapacity: 20,
  },
  {
    id: 'p2',
    name: 'Justyna Jarosz-Jarszewska',
    title: 'mgr',
    spec: 'Psycholożka · Wczesne wspomaganie rozwoju',
    color: '#a83f66',
    soft: '#fae7ee',
    email: 'justyna@bearwithme.pl',
    phone: '+48 604 882 341',
    room: 'Gabinet 2',
    rate: 180,
    weeklyCapacity: 20,
  },
  {
    id: 'p3',
    name: 'Katarzyna Szelinger',
    title: 'mgr',
    spec: 'Pedagożka · Trenerka TUS',
    color: '#2a6a86',
    soft: '#e3f0f6',
    email: 'katarzyna@bearwithme.pl',
    phone: '+48 503 119 906',
    room: 'Gabinet 3',
    rate: 180,
    weeklyCapacity: 18,
  },
  {
    id: 'p4',
    name: 'Natasza Korneluk',
    title: 'lic.',
    spec: 'Wsparcie psychologiczne · Asystentka TUS',
    color: '#8f5a12',
    soft: '#fbeeda',
    email: 'natasza@bearwithme.pl',
    phone: '+48 698 450 233',
    room: 'Sala TUS',
    rate: 160,
    weeklyCapacity: 16,
  },
]

export const DEMO_ROLES = [
  { id: 'owner', label: 'Główna psycholożka', name: 'Anna Maria Janowska', psychId: 'p1', scope: 'centre' },
  { id: 'coordinator', label: 'Koordynatorka', name: 'Julia Wolanin', psychId: null, scope: 'centre' },
  { id: 'therapist', label: 'Specjalistka', name: 'Justyna Jarosz-Jarszewska', psychId: 'p2', scope: 'own' },
]

const NOTE_POOL = [
  'Praca nad rozpoznawaniem emocji na kartach uczuć. Do domu: „termometr nastroju” raz dziennie.',
  'Ćwiczyliśmy czekanie na swoją kolej w grze planszowej — przegrana bez wybuchu złości. Duży postęp.',
  'Zalecenia dla przedszkola: krótkie, pojedyncze polecenia, plan dnia obrazkowy, sygnał przed zmianą aktywności.',
  'Omówione trudności w relacjach z rówieśnikami. Scenki: jak poprosić o dołączenie do zabawy.',
  'Rodzice zgłaszają poprawę zasypiania. Utrzymujemy wieczorną rutynę i ograniczenie ekranów po 20:00.',
  'Trening odmawiania i wyznaczania granic. Ćwiczymy komunikat „ja” w sytuacjach szkolnych.',
  'Praca nad koncentracją — przerwy ruchowe co 10 minut. Wychowawczyni poinformowana o strategii.',
  'Wprowadzony system żetonów za poranne czynności. Nagrody ustalone wspólnie z dzieckiem.',
  'Wyciszanie po powrocie ze szkoły: kącik relaksu i słuchawki wygłuszające. Efekt widoczny po tygodniu.',
  'Konsultacja z rodzicami — jak reagować na odmowę wyjścia z domu. Plan małych kroków na dwa tygodnie.',
  'Przegląd celów z planu terapeutycznego: dwa z trzech osiągnięte. Aktualizujemy zalecenia.',
  'Wskazana konsultacja psychiatryczna w celu uzupełnienia diagnozy. Rodzice wyrażają zgodę.',
]

// [imię i nazwisko, wiek, specjalistka] — dzieci i nastolatkowie, zgodnie
// z profilem centrum. Wiek `null` oznacza dorosłego (rodzic na konsultacji).
const CLIENT_DEFS = [
  ['Zofia Mazur', 9, 'p1'], ['Antoni Krawczyk', 7, 'p1'], ['Julian Bąk', 12, 'p1'],
  ['Nadia Pawlak', 6, 'p1'], ['Ksawery Janik', 14, 'p1'],
  ['Liliana Romanowska', 4, 'p2'], ['Tymon Wielgosz', 5, 'p2'],
  ['Gabriel Madej', 3, 'p2'], ['Zuzanna Duda', 5, 'p2'],
  ['Staś Przybylski', 8, 'p3'], ['Oliwia Mróz', 10, 'p3'], ['Hanna Stępień', 11, 'p3'],
  ['Kuba Kalinowski', 8, 'p3'], ['Alicja Piątek', 13, 'p3'],
  ['Natalia Górska', 15, 'p4'], ['Bartosz Sikora', 16, 'p4'], ['Kamil Wrona', 13, 'p4'],
  ['Maja Sobczak', 17, 'p4'], ['Łukasz Czarnecki', 15, 'p4'],
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

export const CLIENTS = CLIENT_DEFS.map(([name, age, psychId], i) => {
  const sinceDays = 60 + Math.floor(rand() * 320)
  const noteCount = 1 + Math.floor(rand() * 3)
  const notes = Array.from({ length: noteCount }, (_, k) => ({
    date: toISODate(daysAgo(7 + k * (12 + Math.floor(rand() * 16)))),
    text: pick(NOTE_POOL),
  })).sort((a, b) => (a.date < b.date ? 1 : -1))
  return {
    id: `c${i + 1}`,
    name,
    age,
    psychId,
    // kontakt prowadzi rodzic/opiekun — dziecko nie ma własnej skrzynki
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
// specialist) and a recurring service — the 50-minute standard session or,
// for a few families, the 60-minute family therapy slot. Both fit inside one
// hour, so the fixed grid never produces an overlap. Longer positions from
// the cennik (konsultacje, diagnozy, obserwacje) are placed afterwards into
// verified-free slots. Sessions span ~15 weeks back and ~3 weeks forward.

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
  // one draw, in the slot the old duration roll used, so the shared stream
  // stays aligned and every downstream attendance/payment roll is unchanged
  const service = rand() < 0.2 ? 'terapia-rodzinna' : STANDARD_SERVICE
  const duration = durationFor(service)
  const amount = amountFor(service, psych)
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
      service,
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

const timeToMin = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5))

// First hour between 8:00 and 18:00 on `date` where `psychId` can fit a slot
// of `duration` minutes without touching an already-generated session.
const firstFreeHour = (psychId, date, duration) => {
  const sameDay = sessions.filter((s) => s.psychId === psychId && s.date === date)
  for (let hour = 8; hour <= 18; hour++) {
    const start = hour * 60
    const clash = sameDay.some(
      (s) => start < timeToMin(s.time) + s.duration && timeToMin(s.time) < start + duration,
    )
    if (!clash) return hour
  }
  return null
}

// The rest of the cennik, booked into free slots: how a real week at the
// centre looks — a first consultation, two diagnostics, an observation at a
// preschool and a written therapeutic plan.
const CATALOGUE_BOOKINGS = [
  { id: 'demo-konsultacja', clientId: 'c4', psychId: 'p1', service: 'konsultacja', daysAgo: 26, status: 'completed', payment: 'paid', method: 'transfer', note: 'Wywiad rozwojowy, analiza opinii z poradni. Ustalony kierunek pracy.' },
  { id: 'demo-asrs', clientId: 'c2', psychId: 'p1', service: 'asrs', daysAgo: 19, status: 'completed', payment: 'paid', method: 'transfer', note: 'Wyniki omówione z rodzicami. Zalecane pogłębienie diagnozy w poradni.' },
  { id: 'demo-conners', clientId: 'c17', psychId: 'p4', service: 'conners', daysAgo: 12, status: 'completed', payment: 'partial', method: 'cash', note: 'Kwestionariusze od rodzica i wychowawcy zebrane. Konsultacja odbyta.' },
  { id: 'demo-obserwacja', clientId: 'c7', psychId: 'p2', service: 'obserwacja-placowka', daysAgo: 8, status: 'completed', payment: 'unpaid', method: null, note: 'Obserwacja w przedszkolu — wnioski i zalecenia przekazane placówce.' },
  { id: 'demo-plan', clientId: 'c11', psychId: 'p3', service: 'plan-spotkanie', daysAgo: 5, status: 'completed', payment: 'paid', method: 'card', note: 'Plan terapeutyczny na semestr, zalecenia do pracy w szkole i w domu.' },
  { id: 'demo-warsztaty', clientId: 'c15', psychId: 'p4', service: 'warsztaty', daysAgo: -6, status: 'scheduled', payment: 'unpaid', method: null, note: '' },
  { id: 'demo-konsultacja-next', clientId: 'c9', psychId: 'p2', service: 'konsultacja', daysAgo: -9, status: 'scheduled', payment: 'unpaid', method: null, note: '' },
]

for (const booking of CATALOGUE_BOOKINGS) {
  const psych = PSYCHOLOGISTS.find((p) => p.id === booking.psychId)
  const duration = durationFor(booking.service)
  const amount = amountFor(booking.service, psych)
  const date = toISODate(daysAgo(booking.daysAgo))
  const hour = firstFreeHour(booking.psychId, date, duration)
  if (hour === null) continue
  sessions.push({
    id: booking.id,
    clientId: booking.clientId,
    psychId: booking.psychId,
    service: booking.service,
    date,
    time: `${String(hour).padStart(2, '0')}:00`,
    duration,
    amount,
    status: booking.status,
    payment: booking.payment,
    paidAmount: booking.payment === 'paid' ? amount : booking.payment === 'partial' ? Math.round(amount / 2 / 10) * 10 : 0,
    method: booking.method,
    note: booking.note,
  })
}

// Family demo — a parent and a child enrolled as separate clients (different
// surnames), linked as one family. Hand-written after the generator so the
// seeded stream stays stable.
const FAMILY_CLIENTS = [
  {
    id: 'c20', name: 'Renata Gawrys', age: null, psychId: 'p3',
    email: 'renata.gawrys@gmail.com', phone: '+48 512 384 664',
    since: toISODate(daysAgo(45)), status: 'active',
    notes: [{ date: toISODate(daysAgo(38)), text: 'Konsultacja rodzicielska przed rozpoczęciem pracy z synem. Omówiony wywiad rozwojowy.' }],
    familyId: 'f1', familyRole: 'rodzic',
  },
  {
    id: 'c21', name: 'Ignacy Borkowski', age: 6, psychId: 'p3',
    email: 'ignacy.borkowski@gmail.com', phone: '+48 512 384 664',
    since: toISODate(daysAgo(31)), status: 'active',
    notes: [{ date: toISODate(daysAgo(10)), text: 'Praca nad regulacją emocji przez zabawę. Dobra współpraca, kontynuujemy.' }],
    familyId: 'f1', familyRole: 'dziecko',
  },
]
CLIENTS.push(...FAMILY_CLIENTS)

const FAMILY_SESSIONS = [
  { id: 'demo-family-parent', clientId: 'c20', psychId: 'p3', service: 'konsultacja', date: toISODate(daysAgo(38)), time: '11:00', duration: 90, amount: 250, status: 'completed', payment: 'paid', paidAmount: 250, method: 'transfer', note: '' },
  { id: 'demo-family-child-past', clientId: 'c21', psychId: 'p3', service: STANDARD_SERVICE, date: toISODate(daysAgo(10)), time: '15:00', duration: 50, amount: 180, status: 'completed', payment: 'paid', paidAmount: 180, method: 'cash', note: '' },
  { id: 'demo-family-child-next', clientId: 'c21', psychId: 'p3', service: STANDARD_SERVICE, date: toISODate(daysAgo(-4)), time: '15:00', duration: 50, amount: 180, status: 'scheduled', payment: 'unpaid', paidAmount: 0, method: null, note: '' },
]
sessions.push(...FAMILY_SESSIONS)

const scenarioDate = toISODate(TODAY)
const DEMO_SCENARIOS = [
  { id: 'demo-owner-completed', clientId: 'c1', psychId: 'p1', service: STANDARD_SERVICE, date: scenarioDate, time: '08:00', duration: 50, amount: 180, status: 'completed', payment: 'paid', paidAmount: 180, method: 'card', note: '' },
  { id: 'demo-therapist-next', clientId: 'c6', psychId: 'p2', service: 'terapia-rodzinna', date: scenarioDate, time: '10:00', duration: 60, amount: 220, status: 'scheduled', payment: 'unpaid', paidAmount: 0, method: null, note: '' },
  { id: 'demo-cancelled', clientId: 'c10', psychId: 'p3', service: STANDARD_SERVICE, date: scenarioDate, time: '12:00', duration: 50, amount: 180, status: 'cancelled', payment: 'unpaid', paidAmount: 0, method: null, note: '' },
  { id: 'demo-noshow', clientId: 'c15', psychId: 'p4', service: STANDARD_SERVICE, date: scenarioDate, time: '13:00', duration: 50, amount: 160, status: 'noshow', payment: 'unpaid', paidAmount: 0, method: null, note: '' },
  { id: 'demo-unpaid', clientId: 'c2', psychId: 'p1', service: STANDARD_SERVICE, date: scenarioDate, time: '14:00', duration: 50, amount: 180, status: 'completed', payment: 'unpaid', paidAmount: 0, method: null, note: '' },
  { id: 'demo-partial', clientId: 'c7', psychId: 'p2', service: 'terapia-rodzinna', date: scenarioDate, time: '15:00', duration: 60, amount: 220, status: 'completed', payment: 'partial', paidAmount: 110, method: 'cash', note: '' },
  { id: 'demo-overlap', clientId: 'c3', psychId: 'p1', service: STANDARD_SERVICE, date: scenarioDate, time: '14:00', duration: 50, amount: 180, status: 'scheduled', payment: 'unpaid', paidAmount: 0, method: null, note: '' },
]
sessions.push(...DEMO_SCENARIOS)

// One of the two paused families leaves fully settled and one still owes, so
// the kartoteka shows both endings of a break — and so the "wstrzymani" and
// "z zaległościami" filters visibly narrow to different people.
for (const session of sessions) {
  if (session.clientId !== 'c6' || !isBillable(session)) continue
  session.payment = 'paid'
  session.paidAmount = session.amount
  session.method = session.method || 'transfer'
}

sessions.sort((a, b) => (a.date + a.time < b.date + b.time ? -1 : 1))

export const SESSIONS = sessions

// Team board — lightweight in-memory announcements.
export const POSTS = [
  {
    id: 'b1',
    author: 'Anna Maria Janowska',
    text: 'Superwizja zespołowa w piątek o 14:00 — sala TUS. Przynieście opisy trudniejszych przypadków.',
    date: toISODate(daysAgo(1)),
    time: '09:12',
  },
  {
    id: 'b2',
    author: 'Julia Wolanin',
    text: 'Nowe pudełka sensoryczne stoją w sali TUS — proszę o odkładanie ich na miejsce po zajęciach 🧸',
    date: toISODate(daysAgo(3)),
    time: '15:40',
  },
]

// --- Zajęcia TUS --------------------------------------------------------
// Trening Umiejętności Społecznych — zajęcia grupowe, kategoria oddzielna od
// spotkań indywidualnych. Zgodnie z cennikiem: grupa min. 4 osoby, ok. 60
// minut, 85 zł za pojedyncze zajęcia lub 340 zł opłaty miesięcznej. Dzieci
// należą do grup wiekowych, zajęcia są tygodniowe z obecnością per dziecko,
// a rodzice płacą miesięcznie (odwzorowanie arkusza z Excela).

export const TUS_FEE = 340
export const TUS_SINGLE_FEE = 85
export const TUS_MIN_GROUP = 4

export const TUS_GROUPS = [
  { id: 'g1', name: 'TUS · przedszkolaki 5–6 lat', age: '5–6 lat', ageMin: 5, ageMax: 6, capacity: 8, leaderIds: ['p3', 'p2'], weekday: 3, time: '16:00', fee: TUS_FEE },
  { id: 'g2', name: 'TUS · klasy 1–3', age: '7–9 lat', ageMin: 7, ageMax: 9, capacity: 8, leaderIds: ['p3', 'p4'], weekday: 4, time: '17:00', fee: TUS_FEE },
  { id: 'g3', name: 'TUS · nastolatki 13–16 lat', age: '13–16 lat', ageMin: 13, ageMax: 16, capacity: 6, leaderIds: ['p4', 'p1'], weekday: 2, time: '18:00', fee: TUS_FEE },
]

const TUS_KID_DEFS = [
  ['Hania Malik', 5, 'g1', 'Ewa Malik', true],
  ['Staś Urban', 6, 'g1', 'Karol Urban', true],
  ['Pola Dec', 5, 'g1', 'Sylwia Nowicka', true],
  ['Ignacy Lis', 6, 'g1', 'Beata Lis', false],
  ['Maja Cichoń', 5, 'g1', 'Tomasz Cichoń', true],
  ['Antek Duda', 8, 'g2', 'Marta Duda', true],
  ['Zosia Kral', 7, 'g2', 'Piotr Kral', true],
  ['Franek Bąk', 9, 'g2', 'Aneta Wilk', false],
  ['Lena Szulc', 8, 'g2', 'Igor Szulc', true],
  ['Wiktor Sadowski', 14, 'g3', 'Dorota Sadowska', true],
  ['Amelia Nowicka', 15, 'g3', 'Rafał Nowicki', true],
  ['Igor Pietrzak', 13, 'g3', 'Monika Pietrzak', false],
  ['Borys Cygan', 5, null, 'Alina Cygan', false],
  ['Tosia Wrona', 8, null, 'Jan Wrona', false],
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
  'Wyznaczanie granic',
  'Reagowanie na presję grupy',
]

export const TUS_CLASSES = []
let tcId = 1
const todayIso = toISODate(TODAY)
const tusNow = new Date()
const tusNowMoment = `${toISODate(tusNow)}T${pad2(tusNow.getHours())}:${pad2(tusNow.getMinutes())}`
for (const group of TUS_GROUPS) {
  const kids = TUS_KIDS.filter((k) => k.groupId === group.id)
  for (let weekOffset = -10; weekOffset <= 3; weekOffset++) {
    const d = new Date(TODAY)
    d.setDate(d.getDate() - d.getDay() + group.weekday + weekOffset * 7)
    const iso = toISODate(d)
    // time-aware like the session generator: a class later today is not held yet
    const past = `${iso}T${group.time}` <= tusNowMoment
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
const tusPaidMonths = [...new Set(TUS_CLASSES.filter((c) => c.date <= todayIso).map((c) => monthKey(c.date)))].sort()
for (const ym of tusPaidMonths) {
  for (const kid of TUS_KIDS.filter((k) => k.groupId)) {
    const group = TUS_GROUPS.find((g) => g.id === kid.groupId)
    const current = ym === CURRENT_MONTH
    const paid = current ? tusRand() < 0.55 : true
    // k3's note documents a preschool bank transfer — keep her rows consistent
    const preschoolPayer = kid.id === 'k3'
    TUS_PAYMENTS.push({
      id: `tp${tpId++}`,
      kidId: kid.id,
      ym,
      amount: group.fee,
      status: paid ? 'paid' : 'unpaid',
      method: paid ? (preschoolPayer ? 'transfer' : tusRand() < 0.7 ? 'transfer' : tusRand() < 0.5 ? 'cash' : 'card') : null,
      invoice: paid && (preschoolPayer || tusRand() < 0.6),
      // never a future date: the current month books as paid today
      paidDate: paid ? (current ? todayIso : `${ym}-05`) : null,
      note: preschoolPayer ? 'przelew od przedszkola (faktura na placówkę)' : '',
    })
  }
}

export const INITIAL_STATE = {
  user: { name: 'Anna Maria Janowska', role: 'Główna psycholożka', email: 'anna@bearwithme.pl', psychId: 'p1' },
  demoRoleId: 'owner',
  center: {
    name: 'Bear with me — Centrum Psychologiczno-Edukacyjne',
    address: 'ul. Wojska Polskiego 87/2, 58-500 Jelenia Góra',
    phone: '+48 539 363 986',
    email: 'kontakt@bearwithme.pl',
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

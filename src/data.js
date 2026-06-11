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

export const PSYCHOLOGISTS = [
  {
    id: 'p1',
    name: 'Julia Kamińska',
    title: 'dr',
    spec: 'Założycielka · Terapia poznawczo-behawioralna',
    color: '#a4596b',
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
      note: status === 'completed' && rand() < 0.35 ? pick(NOTE_POOL) : '',
    })
  }
})

sessions.sort((a, b) => (a.date + a.time < b.date + b.time ? -1 : 1))

export const SESSIONS = sessions

// Team board — lightweight in-memory announcements.
export const POSTS = [
  {
    id: 'b1',
    author: 'Julia Kamińska',
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

export const INITIAL_STATE = {
  user: { name: 'Julia Kamińska', role: 'Założycielka', email: 'julia@aurelia.pl', psychId: 'p1' },
  center: {
    name: 'Aurelia — Centrum Psychoterapii',
    address: 'ul. Złota 12/3, 00-019 Warszawa',
    phone: '+48 22 412 80 90',
    email: 'kontakt@aurelia.pl',
  },
  psychologists: PSYCHOLOGISTS,
  clients: CLIENTS,
  sessions: SESSIONS,
  posts: POSTS,
  prefs: { reduceMotion: false, weekendsInCalendar: true },
}

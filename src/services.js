// The centre's service catalogue — mirrors the published cennik on
// bearwithme.pl. Pure module (no React/DOM) so `node --test` can import it.
//
// `price` is in złoty and `duration` in minutes. Durations the cennik does not
// state (plans, diagnostics, workshops) are the slot lengths the centre books
// for them — they exist so a service can be placed in the calendar.

export const STANDARD_SERVICE = 'zajecia'

export const SERVICES = [
  {
    id: 'konsultacja',
    label: 'Pierwsza konsultacja',
    duration: 90,
    price: 250,
    note: 'Rozmowa z rodzicami/opiekunami, analiza dokumentów, pogłębiony wywiad',
  },
  {
    id: STANDARD_SERVICE,
    label: 'Zajęcia psychologiczne',
    duration: 50,
    price: 180,
    note: 'Stała praca indywidualna z dzieckiem lub nastolatkiem',
  },
  {
    id: 'terapia-rodzinna',
    label: 'Terapia rodzinna',
    duration: 60,
    price: 220,
    note: 'Spotkanie z rodziną lub rodzicami',
  },
  {
    id: 'plan',
    label: 'Plan terapeutyczny',
    duration: 60,
    price: 250,
    note: 'Rodzaj i wymiar zajęć, cele, co jest niezbędne do pracy',
  },
  {
    id: 'plan-spotkanie',
    label: 'Spotkanie z rodzicami i plan pracy',
    duration: 90,
    price: 400,
    note: 'Gotowy plan terapeutyczny z zaleceniami do przedszkola i domu',
  },
  {
    id: 'obserwacja-placowka',
    label: 'Obserwacja w placówce',
    duration: 120,
    price: 450,
    note: 'Obserwacja, spisanie wniosków, zalecenia i omówienie z rodzicem',
  },
  {
    id: 'obserwacja-dom',
    label: 'Obserwacja w domu',
    duration: 120,
    price: 450,
    note: 'Obserwacja, spisanie wniosków, zalecenia i omówienie z rodzicem',
  },
  {
    id: 'asrs',
    label: 'Diagnoza ASRS — spektrum autyzmu',
    duration: 90,
    price: 400,
    note: 'Wywiad, badanie i omówienie wyników',
  },
  {
    id: 'conners',
    label: 'Test Conners 3 — ADHD',
    duration: 90,
    price: 600,
    note: 'Kwestionariusz dla rodzica i nauczyciela + konsultacja',
  },
  {
    id: 'warsztaty',
    label: 'Warsztaty dla dzieci i nastolatków',
    duration: 120,
    price: 120,
    note: 'Zajęcia jednodniowe rozwijające umiejętności interpersonalne',
  },
  {
    id: 'superwizja',
    label: 'Superwizja w placówce',
    duration: 120,
    price: 450,
    note: 'Wsparcie zespołu przedszkola lub szkoły',
  },
]

export const SERVICE_BY_ID = Object.fromEntries(SERVICES.map((s) => [s.id, s]))

export const serviceLabel = (id) => SERVICE_BY_ID[id]?.label || 'Zajęcia psychologiczne'

/** Short label for tight rows — drops the explanatory dash clause. */
export const serviceShort = (id) => serviceLabel(id).split(' — ')[0]

/**
 * What to badge in a dense list. The standard 50-minute session is the norm
 * and stays unlabelled, so only the exceptional bookings — consultations,
 * diagnostics, observations — catch the eye.
 */
export const serviceBadge = (id) => (id && id !== STANDARD_SERVICE ? serviceShort(id) : '')

export const durationFor = (id) => SERVICE_BY_ID[id]?.duration ?? SERVICE_BY_ID[STANDARD_SERVICE].duration

/**
 * The standard 50-minute session bills at the specialist's own rate (that is
 * what the "Stawki zespołu" screen edits); every other position is a fixed
 * catalogue price.
 */
export const amountFor = (id, psych) => {
  const service = SERVICE_BY_ID[id]
  if (!service) return psych?.rate ?? SERVICE_BY_ID[STANDARD_SERVICE].price
  if (service.id === STANDARD_SERVICE && psych?.rate > 0) return psych.rate
  return service.price
}

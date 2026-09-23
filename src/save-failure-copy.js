// Shared plain-language copy for failed saves and loads. Callers keep their own
// specific messages (overlaps, last owner, …) and fall back to these.

export const UNCERTAIN_SAVE_COPY = 'Nie mamy pewności, czy zmiany się zapisały. Kliknij „Spróbuj ponownie”, niczego nie zmieniając.'
export const CHANGED_RETRY_COPY = 'Dane zmieniły się od poprzedniej próby. Zamknij okno i zacznij od nowa.'
export const RATE_LIMIT_COPY = 'Za dużo prób w krótkim czasie. Spróbuj ponownie za kilka minut.'
export const NETWORK_COPY = 'Brak połączenia z internetem. Dane zostają w formularzu - spróbuj ponownie, gdy połączenie wróci.'
export const FORBIDDEN_COPY = 'Nie masz już uprawnień do tej zmiany. Poproś właścicielkę centrum o dostęp.'

const FORBIDDEN_CODES = new Set(['FORBIDDEN', 'ACCESS_DENIED'])

export const conflictCopy = (what = 'te dane') =>
  `Ktoś w międzyczasie zmienił ${what}. Twoja zmiana nie została zapisana.`

// subject is a genitive noun phrase: 'sesji', 'danych klienta', 'wpłaty'.
export function saveFailureCopy(error, { subject = 'zmian' } = {}) {
  const code = error?.code
  const status = error?.status ?? 0
  if (code === 'NETWORK_ERROR') return NETWORK_COPY
  if (code === 'RATE_LIMITED' || status === 429) return RATE_LIMIT_COPY
  if (FORBIDDEN_CODES.has(code) || status === 403) return FORBIDDEN_COPY
  if (code === 'VERSION_CONFLICT') return conflictCopy()
  return `Nie udało się zapisać ${subject}. Spróbuj ponownie za chwilę.`
}

// subject is a genitive noun phrase: 'Grafiku', 'klientów', 'finansów'.
export const loadFailureCopy = (subject) =>
  `Nie udało się wczytać ${subject}. Spróbuj ponownie za chwilę.`

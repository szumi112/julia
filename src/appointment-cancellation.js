export const APPOINTMENT_CANCELLATION_REASONS = Object.freeze([
  Object.freeze({ value: 'client', label: 'Odwołanie przez klienta' }),
  Object.freeze({ value: 'centre', label: 'Odwołanie przez centrum' }),
  Object.freeze({ value: 'late_paid', label: 'Późne odwołanie - płatne' }),
])

export const appointmentCancellationToastKey = (appointmentId) => (
  `appointment-cancellation-${appointmentId}`
)

export const appointmentCancellationTarget = (appointment, appMode) => Object.freeze({
  id: appMode === 'app'
    ? appointment.id
    : appointment.workspaceId || `apt_demo_${appointment.id}`,
  version: appointment.version ?? 1,
})

const errorCode = (error) => error?.code || String(error?.message || '').split('/')[0]

export const appointmentCancellationError = (error) => {
  const code = errorCode(error)
  if (code === 'APPOINTMENT_PAYMENT_CONFLICT') {
    return 'Nie można odwołać sesji z zaksięgowaną wpłatą.'
  }
  if (code === 'VERSION_CONFLICT') {
    return 'Sesja została zmieniona. Odśwież Grafik i spróbuj ponownie.'
  }
  if (code === 'FORBIDDEN') return 'Nie masz uprawnień do odwołania tej sesji.'
  return 'Nie udało się odwołać sesji. Spróbuj ponownie.'
}

export const appointmentRestorationError = (error) => {
  const code = errorCode(error)
  if (code === 'APPOINTMENT_OVERLAP') {
    return 'Nie można przywrócić sesji, ponieważ ten termin jest już zajęty.'
  }
  if (code === 'APPOINTMENT_PAYMENT_CONFLICT') {
    return 'Nie można przywrócić sesji z zaksięgowaną wpłatą.'
  }
  if (code === 'VERSION_CONFLICT') {
    return 'Nie można przywrócić sesji, ponieważ została zmieniona.'
  }
  if (code === 'FORBIDDEN') return 'Nie masz uprawnień do przywrócenia tej sesji.'
  return 'Nie udało się przywrócić sesji. Spróbuj ponownie.'
}

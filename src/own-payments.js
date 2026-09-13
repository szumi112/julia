import { warsawDateFromUtc, warsawDateTimeFromUtc } from './core-records.js'

export const ownPaymentCivilDate = (startsAt) => warsawDateFromUtc(startsAt)

// The dedicated own-payments DTO intentionally has no client fields. This
// compatibility shape lets it reuse the payment-entry form without widening
// that response or loading the centre workspace.
export const ownPaymentSession = (appointment) => {
  const { date, time } = warsawDateTimeFromUtc(appointment.startsAt)
  return Object.freeze({
    id: appointment.id,
    date,
    time,
    amount: appointment.charge.expectedAmountGrosze / 100,
    paidAmount: appointment.payment.collectedGrosze / 100,
    method: appointment.payment.latestMethod,
    payment: appointment.payment.status,
    status: appointment.status,
    cancellationReason: appointment.cancellationReason,
    version: appointment.version,
  })
}

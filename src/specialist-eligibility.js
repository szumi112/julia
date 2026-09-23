// Who may take new clients and sessions in the app pickers. The server only
// accepts a specialist with active panel access; a profile that is still
// unclaimed or invited is refused. A missing accessStatus (demo data, older
// payloads) counts as active access, the same rule as in Zespół.
export const hasActivePanelAccess = (specialist) => (
  !['unclaimed', 'invited'].includes(specialist?.accessStatus)
)

export const isAssignableSpecialist = (specialist) => (
  specialist?.status === 'active' && hasActivePanelAccess(specialist)
)

export const NO_PANEL_ACCESS_COPY = 'Ta specjalistka nie ma jeszcze aktywnego dostępu do panelu.'

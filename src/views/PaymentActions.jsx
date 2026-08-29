import {
  useApp,
  useCanonicalAppointments,
  usePaymentMutationLock,
  useWorkspaceRefresh,
  useWorkspaceWindow,
} from '../store.jsx'
import { useShell } from '../shell-ctx.js'
import { canPerformAction } from '../capability-access.js'
import { monthWorkspaceRange } from '../workspace-view.js'
import { fmtMoney, fmtShortDate, METHOD_LABELS } from '../format.js'
import { warsawDateFromUtc } from '../core-records.js'
import { Pill } from '../ui.jsx'
import { AppPaymentCorrection, AppPaymentEntry } from './Payments.jsx'

export function useProtectedPaymentContext(selectedMonth, enabled, sharedWorkspaceState = null) {
  const { state, workspace } = useApp()
  const canonicalAppointments = useCanonicalAppointments()
  const { capabilities } = useShell()
  const { locked: paymentMutationLocked } = usePaymentMutationLock()
  const refreshWorkspace = useWorkspaceRefresh()
  const workspaceRange = monthWorkspaceRange(selectedMonth)
  const localWorkspaceState = useWorkspaceWindow(
    workspaceRange, enabled && sharedWorkspaceState === null,
  )
  const workspaceState = sharedWorkspaceState ?? localWorkspaceState
  return {
    canonicalAppointments, capabilities, paymentMutationLocked, refreshWorkspace,
    state, workspace, workspaceRange, workspaceState,
  }
}

function ProtectedPaymentActionInner({
  appointmentId, outstandingGrosze, fallbackFocusRef, onReconciled, paymentContext,
}) {
  const {
    canonicalAppointments, capabilities, paymentMutationLocked, refreshWorkspace,
    state, workspace, workspaceRange, workspaceState,
  } = paymentContext
  const session = state.sessions.find(({ id }) => id === appointmentId)
  const client = session ? state.clients.find(({ id }) => id === session.clientId) : null
  const enabled = outstandingGrosze > 0
    && workspaceState === 'ready'
    && workspace.status === 'ready'
    && canPerformAction(capabilities, 'payment.record')
    && session && !session.readOnly && !client?.readOnly

  const entries = canonicalAppointments[appointmentId]?.paymentEntries ?? []
  return (
    <div className="finance-window__payment-actions">
      {enabled ? <AppPaymentEntry
        session={session}
        client={client}
        fallbackFocusRef={fallbackFocusRef}
        paymentMutationLocked={paymentMutationLocked}
        refreshWorkspace={refreshWorkspace}
        workspace={workspace}
        workspaceRange={workspaceRange}
        onReconciled={onReconciled}
      /> : <span className="faint">—</span>}
      {entries.length > 0 ? <div role="region" aria-label="Historia wpłat">
        <strong>Historia wpłat</strong>
        {entries.map((entry) => <div className="finance-window__payment-entry" key={entry.id}>
          <span>{fmtMoney(entry.amountGrosze / 100)} · {METHOD_LABELS[entry.method] || 'Nie ustalono'}
            {' · '}{fmtShortDate(warsawDateFromUtc(entry.receivedAt))}</span>
          {entry.correctedAt === null && session && !session.readOnly && !client?.readOnly
            && canPerformAction(capabilities, 'payment.correct') ? <AppPaymentCorrection
              entry={entry}
              session={session}
              client={client}
              fallbackFocusRef={fallbackFocusRef}
              paymentMutationLocked={paymentMutationLocked}
              refreshWorkspace={refreshWorkspace}
              workspace={workspace}
              workspaceRange={workspaceRange}
              onReconciled={onReconciled}
            /> : entry.correctedAt !== null ? <Pill tone="ink">Skorygowana</Pill>
              : <span className="faint">—</span>}
        </div>)}
      </div> : null}
    </div>
  )
}

export function ProtectedPaymentAction(props) {
  if (!props.appointmentId) {
    return <span className="faint">—</span>
  }
  return <ProtectedPaymentActionInner {...props} />
}

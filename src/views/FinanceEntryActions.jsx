import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { apiClient } from '../api.js'
import { useShell } from '../shell-ctx.js'
import { useApp, useWorkspaceWindow } from '../store.jsx'
import { useDrawerFX } from '../anim.js'
import { Button, DiscardConfirm, Field, IconBtn, useDiscardGuard } from '../ui.jsx'
import { fmtMoney, fmtMonthYear } from '../format.js'
import { FINANCE_WINDOW_MIN_MONTH, warsawMonthKey } from '../finance-reporting.js'
import { accountingMonthOptions, activityChargeCommand, activityChargeFieldErrors, activityMembershipForParticipant, activitySettlementDraft, draftWithOccurredOn, financeEntryCommand, financeEntryDraft, financePaidAmountError, manualFinanceEntryErrors } from '../finance-entry-form.js'
import { activityGroupView } from '../activity-workspace.js'

const LABELS = Object.freeze({
  paymentMethod: { blik: 'BLIK', cash: 'Gotówka', other: 'Inna', card: 'Karta', monthly: 'Miesięcznie', unknown: 'Nie ustalono', transfer: 'Przelew' },
  settlementStatus: { partial: 'Częściowo opłacona', unknown: 'Nie ustalono', unpaid: 'Nieopłacona', paid: 'Opłacona' },
  invoiceStatus: { unknown: 'Do sprawdzenia', not_required: 'Nie wymaga', not_issued: 'Niewystawiona', action_required: 'Wymaga wystawienia', issued: 'Wystawiona' },
})
const FIELD_LABELS = { accountingMonth: 'Miesiąc rozliczenia', paidAmountGrosze: 'Kwota rozliczona',
  paymentMethod: 'Forma rozliczenia', settlementStatus: 'Status rozliczenia', invoiceStatus: 'Stan faktury' }
const valueLabel = (field, value) => value === null ? 'Okres nieustalony'
  : field === 'paidAmountGrosze' ? fmtMoney(value / 100)
    : field === 'accountingMonth' ? fmtMonthYear(value) : LABELS[field]?.[value] ?? value

function History({ detail }) {
  return <section aria-label="Historia korekt">
    <h3>Historia korekt</h3>
    {detail.adjustments.length === 0 ? <p className="muted">Brak korekt.</p> : detail.adjustments.map((item) => (
      <article className="activity-class" key={item.id}>
        <p><time dateTime={item.createdAt}>{new Date(item.createdAt).toLocaleString('pl-PL', { timeZone: 'Europe/Warsaw' })}</time></p>
        <p><strong>Powód:</strong> {item.reason}</p>
        <dl>{Object.keys(FIELD_LABELS).filter((field) => item.before[field] !== item.after[field]).map((field) => (
          <div key={field}><dt>{FIELD_LABELS[field]}</dt>
            <dd>{valueLabel(field, item.before[field])} → {valueLabel(field, item.after[field])}</dd></div>
        ))}</dl>
      </article>
    ))}
    {detail.historyTruncated && <p className="muted">Wyświetlono 50 najnowszych korekt.</p>}
  </section>
}

function FinanceEntryDrawer({ entryId = null, selectedMonth, activity = null, onChanged, onClose }) {
  const { authorityGeneration, capabilities, registerLeaveGuard } = useShell()
  const { state, toast } = useApp()
  const needsDirectory = Boolean(activity)
  const directoryRange = useMemo(() => needsDirectory
    ? { from: `${selectedMonth}-01`, to: `${selectedMonth}-01` } : null, [needsDirectory, selectedMonth])
  const directoryStatus = useWorkspaceWindow(directoryRange, Boolean(activity))
  const [detail, setDetail] = useState(null)
  const [draft, setDraft] = useState(() => activity
    ? activitySettlementDraft({
      selectedMonth, groupId: activity.groupId,
      leaderSpecialistIds: activity.leaderSpecialistIds,
      currentSpecialistId: activity.currentSpecialistId,
    })
    : financeEntryDraft(null, selectedMonth))
  const [initial, setInitial] = useState(() => JSON.stringify(draft))
  const [loading, setLoading] = useState(Boolean(entryId))
  const [saving, setSaving] = useState(false)
  const [retryLocked, setRetryLocked] = useState(false)
  const [error, setError] = useState('')
  const [errors, setErrors] = useState({})
  const [accountingMonthManuallySelected, setAccountingMonthManuallySelected] = useState(false)
  const drawerRef = useRef(null)
  const backRef = useRef(null)
  const controllerRef = useRef(null)
  const requestRef = useRef(null)
  const generationRef = useRef(authorityGeneration)
  generationRef.current = authorityGeneration
  const allowed = capabilities.includes('finance.centre.manage')
  const discard = useDiscardGuard(JSON.stringify(draft) !== initial)
  const { close, forceClose } = useDrawerFX(drawerRef, backRef, onClose,
    () => !saving && !retryLocked && discard.guard())
  const currentMonth = warsawMonthKey()
  const entry = detail?.entry ?? null
  const linkedAppointment = Boolean(entry?.appointmentId)
  const entryKind = entry?.kind ?? draft.kind
  const compactGroupSettlement = Boolean(activity?.programId === 'apg_tus' && activity.groupId && !entryId)
  const showsPaymentFields = Boolean(activity) || entryKind === 'income' || Boolean(entryId)
  const paymentAmountLabel = entryKind === 'expense' ? 'Kwota zapłacona (zł)' : 'Łącznie wpłacono (zł)'
  const paymentMethodLabel = entryKind === 'expense' ? 'Forma zapłaty' : 'Forma płatności'
  const settlementStatusLabel = entryKind === 'expense' ? 'Stan zapłaty' : 'Status płatności'
  const locked = loading || saving || retryLocked
  const selectedMembershipId = activityMembershipForParticipant(activity?.memberships, draft.participantId)
  const membershipIsFixed = Boolean(activity?.groupId && selectedMembershipId)

  useEffect(() => registerLeaveGuard(() => saving || retryLocked || discard.check()),
    [discard.check, registerLeaveGuard, retryLocked, saving])
  useEffect(() => () => controllerRef.current?.abort(), [])
  useEffect(() => { if (!allowed) onClose() }, [allowed, onClose])

  const load = useCallback(async (preserveDraft = false) => {
    if (!entryId) return
    controllerRef.current?.abort()
    const controller = new AbortController()
    const generation = generationRef.current
    controllerRef.current = controller
    setLoading(true)
    try {
      const loaded = await apiClient.loadFinanceEntry(entryId, { signal: controller.signal })
      if (controller.signal.aborted || generationRef.current !== generation) return
      setDetail(loaded)
      if (!preserveDraft) {
        const next = financeEntryDraft(loaded.entry)
        setDraft(next)
        setInitial(JSON.stringify(next))
        setAccountingMonthManuallySelected(false)
        setError('')
      }
    } catch {
      if (!controller.signal.aborted && generationRef.current === generation) {
        setError('Nie udało się wczytać pozycji. Spróbuj ponownie.')
      }
    } finally {
      if (!controller.signal.aborted && generationRef.current === generation) setLoading(false)
    }
  }, [entryId])
  useEffect(() => { load() }, [load])

  const update = (field, value) => {
    setDraft((current) => ({ ...current, [field]: value }))
    setErrors((current) => ({ ...current, [field]: null }))
    setError('')
  }
  const focusFirstError = () => requestAnimationFrame(() =>
    drawerRef.current?.querySelector('.has-error input, .has-error select, .has-error textarea')?.focus()
  )
  const save = async (event) => {
    event?.preventDefault()
    if (!allowed || saving || loading || linkedAppointment || (entryId && !entry)) return
    let request = requestRef.current
    if (!request) {
      const manualErrors = !entryId && !activity ? manualFinanceEntryErrors(draft) : {}
      const activityErrors = activity ? activityChargeFieldErrors(draft, activity.programId) : {}
      const paidAmountError = showsPaymentFields ? financePaidAmountError(draft.paidAmount) : null
      const fieldErrors = {
        ...manualErrors,
        ...activityErrors,
        ...(paidAmountError && !compactGroupSettlement ? { paidAmount: paidAmountError } : {}),
      }
      if (Object.values(fieldErrors).some(Boolean)) {
        setErrors(fieldErrors)
        focusFirstError()
        return
      }
      try { request = { body: activity ? activityChargeCommand(draft, activity.programId, currentMonth)
        : financeEntryCommand(draft, entry, currentMonth),
        key: `finance-entry-${crypto.randomUUID()}` } } catch (caught) {
        setError(caught.message)
        return
      }
      requestRef.current = request
    }
    const controller = new AbortController()
    const generation = authorityGeneration
    controllerRef.current = controller
    setSaving(true)
    setError('')
    try {
      const options = { signal: controller.signal, idempotencyKey: request.key }
      if (activity) await apiClient.createActivityCharge(request.body, options)
      else if (entryId) await apiClient.adjustFinanceEntry(entryId, request.body, options)
      else await apiClient.createFinanceEntry(request.body, options)
      if (controller.signal.aborted || generationRef.current !== generation) return
      requestRef.current = null
      setRetryLocked(false)
      toast(entryId ? 'Korekta została zapisana' : activity ? 'Rozliczenie miesiąca zostało dodane' : 'Pozycja została dodana')
      forceClose()
      onChanged?.(entry?.kind ?? draft.kind)
    } catch (caught) {
      if (controller.signal.aborted || generationRef.current !== generation) return
      if (caught.code === 'CLIENT_INPUT_INVALID') {
        requestRef.current = null
        setRetryLocked(false)
        setError('Sprawdź dane formularza i spróbuj ponownie. Nie wysłano zapisu.')
      } else if (caught.idempotencyKey === request.key || !caught.status || caught.status >= 500) {
        setRetryLocked(true)
        setError('Nie potwierdzono zapisu. Ponów ten sam zapis, aby bezpiecznie ustalić wynik.')
      } else {
        requestRef.current = null
        setRetryLocked(false)
        if (caught.code === 'VERSION_CONFLICT' && entryId) {
          setSaving(false)
          await load(true)
          setError('Pozycja zmieniła się w innym oknie. Sprawdź aktualną historię i swój szkic przed ponownym zapisem.')
        } else setError(caught.code === 'ACTIVITY_CHARGE_EXISTS'
          ? 'Rozliczenie tego uczestnika i grupy już istnieje w tym miesiącu. Otwórz je, aby poprawić płatność.'
          : 'Nie udało się zapisać pozycji. Sprawdź dane i spróbuj ponownie.')
      }
    } finally {
      if (!controller.signal.aborted && generationRef.current === generation) setSaving(false)
    }
  }

  return createPortal(<>
    <div className="drawer-backdrop" ref={backRef} onClick={close} />
    <aside className="drawer activity-drawer" ref={drawerRef} role="dialog" aria-modal="true"
      aria-label={entryId ? 'Rozliczenie i faktura' : activity ? 'Nowe rozliczenie miesiąca' : 'Nowa pozycja finansowa'}>
      <div className="drawer__head"><div>
        <h2 className="drawer__title">{entryId ? 'Rozliczenie i faktura' : activity ? 'Nowe rozliczenie miesiąca' : 'Nowa pozycja finansowa'}</h2>
        <p className="drawer__sub">{activity
          ? `Rozliczenie za ${fmtMonthYear(selectedMonth)}.`
          : 'Stan faktury służy ewidencji. Panel nie wystawia dokumentu.'}</p>
      </div><IconBtn name="close" label="Zamknij" disabled={saving || retryLocked} onClick={close} /></div>
      <form className="drawer__body" onSubmit={save} noValidate>
        {loading && <p role="status">Wczytywanie pozycji…</p>}
        {linkedAppointment ? <p>Ta pozycja jest powiązana z sesją. Wpłaty i korekty zapisz przy sesji.</p>
          : (!entryId || entry) && <fieldset className="finance-entry-fields" disabled={locked}>
            {activity && <>
              <Field label="Uczestnik" error={errors.participantId}><select className="select" value={draft.participantId} onChange={(e) => {
                const participantId = e.target.value
                setDraft((current) => ({ ...current, participantId,
                  membershipId: activity.groupId
                    ? activityMembershipForParticipant(activity.memberships, participantId) ?? ''
                    : '',
                  groupId: activity.groupId ?? '' }))
                setErrors((current) => ({ ...current, participantId: null, membershipId: null }))
              }}>
                <option value="">— wybierz uczestnika —</option>
                {activity.participants.map(({ id, name }) => <option key={id} value={id}>{name}</option>)}
              </select></Field>
              {activity.programId === 'apg_tus' && !membershipIsFixed && <Field label="Przypisanie do grupy" error={errors.membershipId}><select className="select" value={draft.membershipId} onChange={(e) => {
                const selected = activity.memberships.find(({ membership }) => membership.id === e.target.value)
                setDraft((current) => ({ ...current, membershipId: selected?.membership.id ?? '', groupId: selected?.membership.groupId ?? '' }))
                setErrors((current) => ({ ...current, membershipId: null }))
              }}>
                <option value="">— wybierz przypisanie —</option>
                {activity.memberships.filter(({ membership }) => membership.participantId === draft.participantId)
                  .map(({ membership, label }) => <option key={membership.id} value={membership.id}>{label}</option>)}
              </select></Field>}
              <Field label="Odpowiedzialny specjalista" error={errors.responsibleSpecialistId}><select className="select" value={draft.responsibleSpecialistId}
                disabled={directoryStatus !== 'ready'} onChange={(e) => update('responsibleSpecialistId', e.target.value)}>
                <option value="">— wybierz specjalistę —</option>
                {state.psychologists.toSorted((a, b) => a.name.localeCompare(b.name, 'pl') || a.id.localeCompare(b.id))
                  .map(({ id, name }) => <option key={id} value={id}>{name}</option>)}
              </select></Field>
              {activity.programId === 'apg_english' && <Field label="Liczba lekcji" error={errors.lessonCount}><input className="input" type="number" min="0" max="1000"
                value={draft.lessonCount} onChange={(e) => update('lessonCount', e.target.value)} /></Field>}
            </>}
            {!entryId && !activity && <>
              <Field label="Rodzaj"><select className="select" value={draft.kind} onChange={(e) => {
                const kind = e.target.value
                setDraft((current) => kind === 'expense' ? {
                  ...current, kind, paidAmount: '0', paymentMethod: 'unknown',
                  settlementStatus: 'unpaid', invoiceStatus: 'not_required',
                } : { ...current, kind })
                setErrors({})
                setError('')
              }}>
                <option value="income">Przychód</option><option value="expense">Wydatek</option>
              </select></Field>
              <Field label="Opis pozycji" error={errors.sourceLabel}><input className="input" value={draft.sourceLabel} maxLength={200}
                placeholder="Wpisz, za co jest ta pozycja" onChange={(e) => update('sourceLabel', e.target.value)} /></Field>
              <Field label="Kontrahent" hint="Opcjonalnie."><input className="input" value={draft.counterparty} maxLength={320} onChange={(e) => update('counterparty', e.target.value)} /></Field>
              <Field label="Data" hint="Opcjonalnie."><input className="input" type="date" value={draft.occurredOn} onChange={(e) => {
                setDraft((current) => draftWithOccurredOn(
                  current, e.target.value, accountingMonthManuallySelected,
                ))
                setErrors((current) => ({ ...current, occurredOn: null, accountingMonth: null }))
                setError('')
              }} /></Field>
            </>}
            {!entryId && <Field label="Kwota (zł)" error={errors.amount} hint={activity ? 'Wpisz ustaloną kwotę dla tej grupy.' : undefined}><input className="input" inputMode="decimal" value={draft.amount} onChange={(e) => update('amount', e.target.value)} /></Field>}
            {entry && <p><strong>{entry.counterparty || entry.sourceLabel}</strong> · {fmtMoney(entry.amountGrosze / 100)}</p>}
            {!compactGroupSettlement && <Field label="Miesiąc rozliczenia" hint={entry?.kind === 'income'
              ? 'Miesiąc przychodu pozostaje zgodny ze źródłem.'
              : 'Zwykle miesiąc z daty; zmień, jeśli pozycja ma się liczyć do innego miesiąca.'}>
              <select className="select" disabled={Boolean(activity) || entry?.kind === 'income'} value={draft.accountingMonth}
                onChange={(e) => {
                  setAccountingMonthManuallySelected(true)
                  update('accountingMonth', e.target.value)
                }}>
                {entry?.accountingMonth === null && <option value="">— okres nieustalony —</option>}
                {accountingMonthOptions(currentMonth).map((month) => <option key={month} value={month}>{fmtMonthYear(month)}</option>)}
              </select>
            </Field>}
            {showsPaymentFields && !compactGroupSettlement ? <Field label={paymentAmountLabel} error={errors.paidAmount} hint="Pełna kwota wpłat po korekcie, nie kolejna wpłata.">
              <input className="input" inputMode="decimal" value={draft.paidAmount} onChange={(e) => update('paidAmount', e.target.value)} />
            </Field> : null}
            {showsPaymentFields && !compactGroupSettlement ? [
              ['paymentMethod', paymentMethodLabel, LABELS.paymentMethod],
              ['settlementStatus', settlementStatusLabel, LABELS.settlementStatus],
            ].map(([field, label, options]) => <Field label={label} key={field}>
              <select className="select" value={draft[field]} onChange={(e) => update(field, e.target.value)}>
                {Object.entries(options).sort(([, left], [, right]) => left.localeCompare(right, 'pl'))
                  .map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </Field>) : null}
            {showsPaymentFields && !compactGroupSettlement ? <Field label={FIELD_LABELS.invoiceStatus}>
              <select className="select" value={draft.invoiceStatus} onChange={(e) => update('invoiceStatus', e.target.value)}>
                {Object.entries(LABELS.invoiceStatus).sort(([, left], [, right]) => left.localeCompare(right, 'pl'))
                  .map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </Field> : null}
            {entryId && <Field label="Powód korekty"><textarea className="textarea" value={draft.reason} maxLength={500} onChange={(e) => update('reason', e.target.value)} /></Field>}
          </fieldset>}
        {entryId && !entry && !loading && <Button variant="ghost" onClick={() => load()}>Wczytaj ponownie</Button>}
        {detail && <History detail={detail} />}
      </form>
      {error && <p className="form-warn form-warn--error" role="alert">{error}</p>}
      {discard.confirming && <DiscardConfirm onStay={discard.hide} onDiscard={forceClose} />}
      <div className="drawer__foot">
        {!linkedAppointment && <Button disabled={saving || loading || (entryId && !entry)} onClick={save}>
          {saving ? 'Zapisywanie…' : retryLocked ? 'Ponów ten sam zapis' : entryId ? 'Zapisz korektę' : 'Dodaj pozycję'}
        </Button>}
        <Button variant="ghost" disabled={saving || retryLocked} onClick={close}>Anuluj</Button>
      </div>
    </aside>
  </>, document.body)
}

function EntryLauncher({ row = null, selectedMonth, activity = null, onChanged, variant = row ? 'ghost' : 'primary' }) {
  const { capabilities } = useShell()
  const [opened, setOpened] = useState(false)
  const allowed = capabilities.includes('finance.centre.manage')
  const close = useCallback(() => setOpened(false), [])
  if (!allowed || row?.appointmentId || row?.state === 'void') return null
  return <>
    <Button variant={variant} size={row ? 'sm' : undefined}
      onClick={() => setOpened(true)}>
      {row ? 'Rozliczenie / faktura' : activity ? 'Dodaj rozliczenie miesiąca' : 'Dodaj pozycję'}
    </Button>
    {opened && <FinanceEntryDrawer
      key={row?.id ?? 'new'} entryId={row?.id}
      selectedMonth={selectedMonth} activity={activity} onChanged={onChanged} onClose={close} />}
  </>
}

export function FinanceEntryActions({ row, onChanged }) {
  return <EntryLauncher row={row} onChanged={onChanged} />
}

export function FinanceEntryToolbar({ onChanged, selectedMonth }) {
  return <EntryLauncher selectedMonth={selectedMonth ?? warsawMonthKey()} onChanged={onChanged} />
}

export function ActivityBillingAction({ month, programId, groupId = null, participants }) {
  const { workspace } = useApp()
  const { actor } = useShell()
  if (month < FINANCE_WINDOW_MIN_MONTH || month > warsawMonthKey()) return null
  const groups = Object.values(workspace.activities.state.groupsById)
    .filter((group) => group.programId === programId && (groupId === null || group.id === groupId))
  const memberships = groups.flatMap((group) => (
    activityGroupView(workspace.activities.state, { groupId: group.id, month })?.participantRows
      .map(({ membership }) => ({ membership, label: `${group.label} · ${membership.startsOn ?? membership.period.month ?? membership.period.day}` })) ?? []
  )).sort((a, b) => a.label.localeCompare(b.label, 'pl') || a.membership.id.localeCompare(b.membership.id))
  const leaderSpecialistIds = groupId === null ? []
    : activityGroupView(workspace.activities.state, { groupId, month })?.leaders
      .map(({ specialistId }) => specialistId) ?? []
  const reload = () => { workspace.activities.loadWindow({ from: month, to: month }).catch(() => {}) }
  return <EntryLauncher
    selectedMonth={month}
    activity={{
      programId, groupId, participants, memberships, leaderSpecialistIds,
      currentSpecialistId: actor?.specialistId ?? null,
    }}
    onChanged={reload}
    variant="soft"
  />
}

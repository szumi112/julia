import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { apiClient, ApiError } from '../api.js'
import { canPerformAction } from '../capability-access.js'
import { financeRepository } from '../finance-repository.js'
import { CHANGED_RETRY_COPY, conflictCopy, loadFailureCopy, saveFailureCopy, UNCERTAIN_SAVE_COPY } from '../save-failure-copy.js'
import { useShell } from '../shell-ctx.js'
import { useApp, useWorkspaceWindow } from '../store.jsx'
import { useDrawerFX } from '../anim.js'
import { Button, DiscardConfirm, Field, IconBtn, useDiscardGuard } from '../ui.jsx'
import { fmtMoney, fmtMonthYear } from '../format.js'
import { FINANCE_WINDOW_MIN_MONTH, warsawMonthKey } from '../finance-reporting.js'
import { accountingMonthOptions, activityChargeCommand, activityChargeFieldErrors, activityMembershipForParticipant, activitySettlementDraft, draftWithOccurredOn, draftWithSettlementFromPaid, financeEntryCommand, financeEntryDraft, financePaidAmountError, manualFinanceEntryErrors } from '../finance-entry-form.js'
import { activityGroupView } from '../activity-workspace.js'

const LABELS = Object.freeze({
  paymentMethod: { blik: 'BLIK', cash: 'Gotówka', other: 'Inna', card: 'Karta', monthly: 'Miesięcznie', unknown: 'Nie ustalono', transfer: 'Przelew' },
  settlementStatus: { partial: 'Częściowo opłacona', unknown: 'Nie ustalono', unpaid: 'Do zapłaty', paid: 'Opłacona' },
  invoiceStatus: { unknown: 'Do sprawdzenia', not_required: 'Nie wymaga', not_issued: 'Niewystawiona', action_required: 'Wymaga wystawienia', issued: 'Wystawiona' },
})
const FIELD_LABELS = { accountingMonth: 'Miesiąc rozliczenia', paidAmountGrosze: 'Kwota rozliczona',
  paymentMethod: 'Forma rozliczenia', settlementStatus: 'Status rozliczenia', invoiceStatus: 'Stan faktury' }
const valueLabel = (field, value) => value === null ? 'bez miesiąca'
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

const voidKey = () => `finance-void-${crypto.randomUUID()}`
const entrySummary = (entry) => [
  entry.sourceLabel,
  entry.counterparty && entry.counterparty !== entry.sourceLabel ? entry.counterparty : null,
  entry.accountingMonth ? fmtMonthYear(entry.accountingMonth) : 'bez miesiąca',
  fmtMoney(entry.amountGrosze / 100),
].filter(Boolean).join(' · ')

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
  const [statusManuallySelected, setStatusManuallySelected] = useState(false)
  const [voidOpen, setVoidOpen] = useState(false)
  const [voidReason, setVoidReason] = useState('')
  const [voidError, setVoidError] = useState('')
  const [voidFieldError, setVoidFieldError] = useState('')
  const [voiding, setVoiding] = useState(false)
  const [voidLocked, setVoidLocked] = useState(false)
  const voidRequestRef = useRef(null)
  const drawerRef = useRef(null)
  const backRef = useRef(null)
  const controllerRef = useRef(null)
  const requestRef = useRef(null)
  const generationRef = useRef(authorityGeneration)
  generationRef.current = authorityGeneration
  const allowed = capabilities.includes('finance.centre.manage')
  const canVoid = canPerformAction(capabilities, 'finance.entry.void')
  const discard = useDiscardGuard(JSON.stringify(draft) !== initial)
  const { close, forceClose } = useDrawerFX(drawerRef, backRef, onClose,
    () => !saving && !retryLocked && !voiding && !voidLocked && discard.guard())
  const currentMonth = warsawMonthKey()
  const entry = detail?.entry ?? null
  const linkedAppointment = Boolean(entry?.appointmentId)
  const entryKind = entry?.kind ?? draft.kind
  const compactGroupSettlement = Boolean(activity?.programId === 'apg_tus' && activity.groupId && !entryId)
  const showsPaymentFields = Boolean(activity) || entryKind === 'income' || Boolean(entryId)
  const manualNew = !entryId && !activity
  const paymentAmountLabel = entryKind === 'expense' ? 'Kwota zapłacona (zł)' : 'Łącznie wpłacono (zł)'
  const paymentAmountHint = !entryId ? 'Ile wpłacono w sumie. Wpisz 0, jeśli jeszcze nic.'
    : entryKind === 'expense' ? 'Wpisz całą zapłaconą kwotę, nie tylko ostatnią płatność.'
      : 'Wpisz całą wpłaconą kwotę, nie tylko nową wpłatę.'
  const paymentMethodLabel = entryKind === 'expense' ? 'Forma zapłaty' : 'Forma płatności'
  const settlementStatusLabel = entryKind === 'expense' ? 'Stan zapłaty' : 'Status płatności'
  const locked = loading || saving || retryLocked || voiding || voidLocked
  const showsVoid = canVoid && Boolean(entry) && !linkedAppointment
  const selectedMembershipId = activityMembershipForParticipant(activity?.memberships, draft.participantId)
  const membershipIsFixed = Boolean(activity?.groupId && selectedMembershipId)

  useEffect(() => registerLeaveGuard(() => saving || retryLocked || voiding || voidLocked || discard.check()),
    [discard.check, registerLeaveGuard, retryLocked, saving, voidLocked, voiding])
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
        setError(loadFailureCopy('pozycji'))
      }
    } finally {
      if (!controller.signal.aborted && generationRef.current === generation) setLoading(false)
    }
  }, [entryId])
  useEffect(() => { load() }, [load])

  const update = (field, value) => {
    setDraft((current) => {
      const next = { ...current, [field]: value }
      return manualNew && next.kind === 'income' && (field === 'amount' || field === 'paidAmount')
        ? draftWithSettlementFromPaid(next, statusManuallySelected) : next
    })
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
      toast(entryId ? `Korekta została zapisana · ${entry.sourceLabel}`
        : activity ? 'Rozliczenie miesiąca zostało dodane'
          : `${draft.kind === 'expense' ? 'Wydatek został dodany' : 'Przychód został dodany'} · ${request.body.sourceLabel}, ${fmtMoney(request.body.amountGrosze / 100)}`)
      forceClose()
      onChanged?.(entry?.kind ?? draft.kind)
    } catch (caught) {
      if (controller.signal.aborted || generationRef.current !== generation) return
      if (caught.code === 'CLIENT_INPUT_INVALID') {
        requestRef.current = null
        setRetryLocked(false)
        setError('Sprawdź dane formularza i spróbuj ponownie. Nic nie zostało zapisane.')
      } else if (caught.idempotencyKey === request.key || !caught.status || caught.status >= 500) {
        setRetryLocked(true)
        setError(`${UNCERTAIN_SAVE_COPY} Pozycja się nie zdubluje.`)
      } else {
        requestRef.current = null
        setRetryLocked(false)
        if (caught.code === 'VERSION_CONFLICT' && entryId) {
          setSaving(false)
          await load(true)
          setError(`${conflictCopy('tę pozycję')} Sprawdź historię korekt i zapisz ponownie.`)
        } else setError(caught.code === 'ACTIVITY_CHARGE_EXISTS'
          ? 'Rozliczenie tego uczestnika i grupy już istnieje w tym miesiącu. Otwórz je, aby poprawić płatność.'
          : caught.code === 'IDEMPOTENCY_CONFLICT' ? CHANGED_RETRY_COPY
            : saveFailureCopy(caught, { subject: 'pozycji' }))
      }
    } finally {
      if (!controller.signal.aborted && generationRef.current === generation) setSaving(false)
    }
  }

  const openVoid = () => {
    setVoidOpen(true)
    setVoidReason('')
    setVoidError('')
    setVoidFieldError('')
    setVoidLocked(false)
    voidRequestRef.current = null
  }
  const closeVoid = () => {
    if (voiding || voidLocked) return
    setVoidOpen(false)
    setVoidError('')
    setVoidFieldError('')
    voidRequestRef.current = null
    requestAnimationFrame(() => drawerRef.current?.querySelector('.finance-entry-void__link')?.focus())
  }
  const confirmVoid = async () => {
    if (!canVoid || !entry || linkedAppointment || voiding) return
    let request = voidRequestRef.current
    if (!request) {
      // The API refuses control characters, so line breaks become spaces.
      const reason = voidReason.replace(/\s+/g, ' ').trim().normalize('NFC')
      if (reason.length < 3) {
        setVoidFieldError('Wpisz powód, co najmniej 3 znaki.')
        requestAnimationFrame(() => drawerRef.current?.querySelector('.finance-entry-void textarea')?.focus())
        return
      }
      request = Object.freeze({ key: voidKey(), reason, version: entry.version })
      voidRequestRef.current = request
    }
    const controller = new AbortController()
    const generation = authorityGeneration
    controllerRef.current = controller
    setVoiding(true)
    setVoidError('')
    try {
      await financeRepository.voidLedgerEntry(entry.id, request.version, request.reason,
        { idempotencyKey: request.key, signal: controller.signal })
      if (controller.signal.aborted || generationRef.current !== generation) return
      voidRequestRef.current = null
      setVoidLocked(false)
      toast(`Pozycja została usunięta z rozliczeń · ${entry.sourceLabel}, ${fmtMoney(entry.amountGrosze / 100)}`)
      forceClose()
      onChanged?.()
    } catch (caught) {
      if (controller.signal.aborted || generationRef.current !== generation) return
      if (caught instanceof ApiError && caught.idempotencyKey === request.key) {
        setVoidLocked(true)
        setVoidError(UNCERTAIN_SAVE_COPY)
      } else {
        voidRequestRef.current = null
        setVoidLocked(false)
        if (caught?.code === 'VERSION_CONFLICT') {
          setVoiding(false)
          await load(true)
          setVoidError(`${conflictCopy('tę pozycję')} Sprawdź ją i spróbuj ponownie.`)
        } else setVoidError(caught?.code === 'FINANCE_ENTRY_VOIDED'
          ? 'Ta pozycja jest już usunięta z rozliczeń.'
          : caught?.code === 'IDEMPOTENCY_CONFLICT' ? CHANGED_RETRY_COPY
            : saveFailureCopy(caught, { subject: 'zmiany' }))
      }
    } finally {
      if (!controller.signal.aborted && generationRef.current === generation) setVoiding(false)
    }
  }
  const saveLabel = entryId ? 'Zapisz korektę' : activity ? 'Dodaj rozliczenie'
    : draft.kind === 'expense' ? 'Dodaj wydatek' : 'Dodaj przychód'

  return createPortal(<>
    <div className="drawer-backdrop" ref={backRef} onClick={close} />
    <aside className="drawer activity-drawer" ref={drawerRef} role="dialog" aria-modal="true"
      aria-label={entryId ? 'Rozliczenie i faktura' : activity ? 'Nowe rozliczenie miesiąca' : 'Nowa pozycja finansowa'}>
      <div className="drawer__head"><div>
        <h2 className="drawer__title">{entryId ? 'Rozliczenie i faktura' : activity ? 'Nowe rozliczenie miesiąca' : 'Nowa pozycja finansowa'}</h2>
        <p className="drawer__sub">{activity
          ? `Rozliczenie za ${fmtMonthYear(selectedMonth)}.`
          : 'Panel nie wystawia faktur - tu tylko zaznaczasz ich stan.'}</p>
      </div><IconBtn name="close" label="Zamknij" disabled={saving || retryLocked || voiding || voidLocked} onClick={close} /></div>
      <form className="drawer__body" onSubmit={save} noValidate>
        {loading && <p role="status">Wczytuję pozycję…</p>}
        {voidOpen && entry ? <section className="finance-entry-void" aria-labelledby="finance-entry-void-title">
          <h3 id="finance-entry-void-title">Usunąć tę pozycję z rozliczeń?</h3>
          <p><strong>{entrySummary(entry)}</strong></p>
          <p className="muted">Pozycja przestanie liczyć się w Finansach i Raportach. Tego nie da się cofnąć.</p>
          <Field label="Powód" error={voidFieldError} hint="np. wpisana dwa razy">
            <textarea className="textarea" value={voidReason} maxLength={500} disabled={voiding || voidLocked}
              onChange={(e) => { setVoidReason(e.target.value); setVoidFieldError(''); setVoidError('') }} />
          </Field>
          {voidError && <p className="form-warn form-warn--error" role="alert">{voidError}</p>}
        </section>
        : linkedAppointment ? <p>Ta pozycja jest powiązana z sesją. Wpłaty i korekty zapisz przy sesji.</p>
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
              <Field label="Za co?" error={errors.sourceLabel}><input className="input" value={draft.sourceLabel} maxLength={200}
                placeholder={draft.kind === 'expense' ? 'np. materiały do zajęć' : 'np. warsztaty dla rodziców'} onChange={(e) => update('sourceLabel', e.target.value)} /></Field>
              <Field label={draft.kind === 'expense' ? 'Dla kogo (opcjonalnie)' : 'Od kogo (opcjonalnie)'}><input className="input" value={draft.counterparty} maxLength={320} onChange={(e) => update('counterparty', e.target.value)} /></Field>
              <Field label="Data (opcjonalnie)"><input className="input" type="date" value={draft.occurredOn} onChange={(e) => {
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
                {entry?.accountingMonth === null && <option value="">— bez miesiąca —</option>}
                {accountingMonthOptions(currentMonth).map((month) => <option key={month} value={month}>{fmtMonthYear(month)}</option>)}
              </select>
            </Field>}
            {showsPaymentFields && !compactGroupSettlement ? <Field label={paymentAmountLabel} error={errors.paidAmount} hint={paymentAmountHint}>
              <input className="input" inputMode="decimal" value={draft.paidAmount} onChange={(e) => update('paidAmount', e.target.value)} />
            </Field> : null}
            {showsPaymentFields && !compactGroupSettlement ? [
              ['paymentMethod', paymentMethodLabel, LABELS.paymentMethod],
              ['settlementStatus', settlementStatusLabel, LABELS.settlementStatus],
            ].map(([field, label, options]) => <Field label={label} key={field}>
              <select className="select" value={draft[field]} onChange={(e) => {
                if (field === 'settlementStatus') setStatusManuallySelected(true)
                update(field, e.target.value)
              }}>
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
        {showsVoid && !voidOpen && <div className="finance-entry-void__open">
          <button type="button" className="finance-entry-void__link" disabled={locked} onClick={openVoid}>Usuń z rozliczeń</button>
        </div>}
        {entryId && !entry && !loading && <Button variant="ghost" onClick={() => load()}>Spróbuj ponownie</Button>}
        {detail && !voidOpen && <History detail={detail} />}
      </form>
      {error && <p className="form-warn form-warn--error" role="alert">{error}</p>}
      {discard.confirming && <DiscardConfirm onStay={discard.hide} onDiscard={forceClose} />}
      {voidOpen ? <div className="drawer__foot">
        <Button variant="ghost" autoFocus disabled={voiding || voidLocked} onClick={closeVoid}>Zostaw pozycję</Button>
        <Button variant="danger" disabled={voiding} onClick={confirmVoid}>
          {voiding ? 'Usuwanie…' : voidLocked ? 'Spróbuj ponownie' : 'Usuń z rozliczeń'}
        </Button>
      </div> : <div className="drawer__foot">
        {!linkedAppointment && <Button disabled={saving || loading || (entryId && !entry)} onClick={save}>
          {saving ? 'Zapisywanie…' : retryLocked ? 'Spróbuj ponownie' : saveLabel}
        </Button>}
        <Button variant="ghost" disabled={saving || retryLocked} onClick={close}>Anuluj</Button>
      </div>}
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

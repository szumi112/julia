import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { apiClient } from '../api.js'
import { useShell } from '../shell-ctx.js'
import { useApp, useWorkspaceWindow } from '../store.jsx'
import { useDrawerFX } from '../anim.js'
import { Button, DiscardConfirm, Field, IconBtn, useDiscardGuard } from '../ui.jsx'
import { fmtMoney, fmtMonthYear } from '../format.js'
import { FINANCE_WINDOW_MIN_MONTH, warsawMonthKey } from '../finance-reporting.js'
import { activityChargeCommand, financeEntryCommand, financeEntryDraft } from '../finance-entry-form.js'
import { activityGroupView } from '../activity-workspace.js'

const LABELS = Object.freeze({
  paymentMethod: { blik: 'BLIK', cash: 'Gotówka', other: 'Inna', card: 'Karta', monthly: 'Miesięcznie', unknown: 'Nie ustalono', transfer: 'Przelew' },
  settlementStatus: { partial: 'Częściowo opłacona', unknown: 'Nie ustalono', unpaid: 'Nieopłacona', paid: 'Opłacona' },
  invoiceStatus: { unknown: 'Do sprawdzenia', not_required: 'Nie wymaga', not_issued: 'Niewystawiona', action_required: 'Wymaga wystawienia', issued: 'Wystawiona' },
})
const FIELD_LABELS = { accountingMonth: 'Miesiąc księgowy', paidAmountGrosze: 'Łącznie wpłacono',
  paymentMethod: 'Forma płatności', settlementStatus: 'Status płatności', invoiceStatus: 'Stan faktury' }
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
  const [draft, setDraft] = useState(() => ({ ...financeEntryDraft(null, selectedMonth),
    ...(activity ? { participantId: '', membershipId: '', groupId: activity.groupId ?? '', responsibleSpecialistId: '', lessonCount: '' } : {}) }))
  const [initial, setInitial] = useState(() => JSON.stringify(draft))
  const [loading, setLoading] = useState(Boolean(entryId))
  const [saving, setSaving] = useState(false)
  const [retryLocked, setRetryLocked] = useState(false)
  const [error, setError] = useState('')
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
  const locked = loading || saving || retryLocked

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
    setError('')
  }
  const save = async (event) => {
    event?.preventDefault()
    if (!allowed || saving || loading || linkedAppointment || (entryId && !entry)) return
    let request = requestRef.current
    if (!request) {
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
      onChanged?.()
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
        <p className="drawer__sub">Stan faktury służy ewidencji. Panel nie wystawia dokumentu.</p>
      </div><IconBtn name="close" label="Zamknij" disabled={saving || retryLocked} onClick={close} /></div>
      <form className="drawer__body" onSubmit={save} noValidate>
        {loading && <p role="status">Wczytywanie pozycji…</p>}
        {linkedAppointment ? <p>Ta pozycja jest powiązana z wizytą. Wpłaty i korekty zapisz przy wizycie.</p>
          : (!entryId || entry) && <fieldset disabled={locked} style={{ border: 0, padding: 0, margin: 0 }}>
            {activity && <>
              <Field label="Uczestnik"><select className="select" value={draft.participantId} onChange={(e) => setDraft((current) => ({ ...current,
                participantId: e.target.value, membershipId: '', groupId: activity.groupId ?? '' }))}>
                <option value="">— wybierz uczestnika —</option>
                {activity.participants.map(({ id, name }) => <option key={id} value={id}>{name}</option>)}
              </select></Field>
              {activity.programId === 'apg_tus' && <Field label="Przypisanie do grupy"><select className="select" value={draft.membershipId} onChange={(e) => {
                const selected = activity.memberships.find(({ membership }) => membership.id === e.target.value)
                setDraft((current) => ({ ...current, membershipId: selected?.membership.id ?? '', groupId: selected?.membership.groupId ?? '' }))
              }}>
                <option value="">{activity.programId === 'apg_english' ? 'Bez grupy' : '— wybierz przypisanie —'}</option>
                {activity.memberships.filter(({ membership }) => membership.participantId === draft.participantId)
                  .map(({ membership, label }) => <option key={membership.id} value={membership.id}>{label}</option>)}
              </select></Field>}
              <Field label="Odpowiedzialny specjalista"><select className="select" value={draft.responsibleSpecialistId}
                disabled={directoryStatus !== 'ready'} onChange={(e) => update('responsibleSpecialistId', e.target.value)}>
                <option value="">— wybierz specjalistę —</option>
                {state.psychologists.toSorted((a, b) => a.name.localeCompare(b.name, 'pl') || a.id.localeCompare(b.id))
                  .map(({ id, name }) => <option key={id} value={id}>{name}</option>)}
              </select></Field>
              {activity.programId === 'apg_english' && <Field label="Liczba lekcji"><input className="input" type="number" min="0" max="1000"
                value={draft.lessonCount} onChange={(e) => update('lessonCount', e.target.value)} /></Field>}
            </>}
            {!entryId && !activity && <>
              <Field label="Rodzaj"><select className="select" value={draft.kind} onChange={(e) => update('kind', e.target.value)}>
                <option value="income">Przychód</option><option value="expense">Wydatek</option>
              </select></Field>
              <Field label="Opis pozycji"><input className="input" value={draft.sourceLabel} maxLength={200} onChange={(e) => update('sourceLabel', e.target.value)} /></Field>
              <Field label="Kontrahent" hint="Opcjonalnie."><input className="input" value={draft.counterparty} maxLength={320} onChange={(e) => update('counterparty', e.target.value)} /></Field>
              <Field label="Data" hint="Opcjonalnie."><input className="input" type="date" value={draft.occurredOn} onChange={(e) => update('occurredOn', e.target.value)} /></Field>
            </>}
            {!entryId && <Field label="Kwota (zł)"><input className="input" inputMode="decimal" value={draft.amount} onChange={(e) => update('amount', e.target.value)} /></Field>}
            {entry && <p><strong>{entry.counterparty || entry.sourceLabel}</strong> · {fmtMoney(entry.amountGrosze / 100)}</p>}
            <Field label="Miesiąc księgowy" hint={entry?.kind === 'income' ? 'Miesiąc przychodu pozostaje zgodny ze źródłem.' : undefined}>
              <input className="input" type="month" min={FINANCE_WINDOW_MIN_MONTH} max={currentMonth}
                disabled={Boolean(activity) || entry?.kind === 'income'} value={draft.accountingMonth} onChange={(e) => update('accountingMonth', e.target.value)} />
            </Field>
            <Field label="Łącznie wpłacono (zł)" hint="Pełna kwota wpłat po korekcie, nie kolejna wpłata.">
              <input className="input" inputMode="decimal" value={draft.paidAmount} onChange={(e) => update('paidAmount', e.target.value)} />
            </Field>
            {Object.entries(LABELS).map(([field, options]) => <Field label={FIELD_LABELS[field]} key={field}>
              <select className="select" value={draft[field]} onChange={(e) => update(field, e.target.value)}>
                {Object.entries(options).sort(([, left], [, right]) => left.localeCompare(right, 'pl'))
                  .map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </Field>)}
            {entryId && <Field label="Powód korekty"><textarea className="textarea" value={draft.reason} maxLength={500} onChange={(e) => update('reason', e.target.value)} /></Field>}
          </fieldset>}
        {error && <p className="form-warn form-warn--error" role="alert">{error}</p>}
        {entryId && !entry && !loading && <Button variant="ghost" onClick={() => load()}>Wczytaj ponownie</Button>}
        {detail && <History detail={detail} />}
      </form>
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

function EntryLauncher({ row = null, selectedMonth, activity = null, onChanged }) {
  const { authorityGeneration, capabilities } = useShell()
  const [openedAt, setOpenedAt] = useState(null)
  const allowed = capabilities.includes('finance.centre.manage')
  const close = useCallback(() => setOpenedAt(null), [])
  if (!allowed || row?.appointmentId || row?.state === 'void') return null
  return <>
    <Button variant={row ? 'ghost' : 'primary'} size={row ? 'sm' : undefined}
      onClick={() => setOpenedAt({ generation: authorityGeneration })}>
      {row ? 'Rozliczenie / faktura' : activity ? 'Dodaj rozliczenie miesiąca' : 'Dodaj pozycję'}
    </Button>
    {openedAt && openedAt.generation === authorityGeneration && <FinanceEntryDrawer
      key={`${authorityGeneration}:${row?.id ?? 'new'}`} entryId={row?.id}
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
  if (month < FINANCE_WINDOW_MIN_MONTH || month > warsawMonthKey()) return null
  const groups = Object.values(workspace.activities.state.groupsById)
    .filter((group) => group.programId === programId && (groupId === null || group.id === groupId))
  const memberships = groups.flatMap((group) => (
    activityGroupView(workspace.activities.state, { groupId: group.id, month })?.participantRows
      .map(({ membership }) => ({ membership, label: `${group.label} · ${membership.startsOn ?? membership.period.month ?? membership.period.day}` })) ?? []
  )).sort((a, b) => a.label.localeCompare(b.label, 'pl') || a.membership.id.localeCompare(b.membership.id))
  const reload = () => { workspace.activities.loadWindow({ from: month, to: month }).catch(() => {}) }
  return <EntryLauncher selectedMonth={month} activity={{ programId, groupId, participants, memberships }} onChanged={reload} />
}

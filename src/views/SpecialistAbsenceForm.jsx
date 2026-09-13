import { useEffect, useRef, useState } from 'react'
import { useApp } from '../store.jsx'
import { useShell } from '../shell-ctx.js'
import { Button, DiscardConfirm, Field, IconBtn, useDiscardGuard } from '../ui.jsx'
import { Icon } from '../icons.jsx'
import { useDrawerFX } from '../anim.js'
import { fmtDayMonth, parseISO, toISODate } from '../format.js'
import { canPerformAction } from '../capability-access.js'

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

const validDate = (value) => {
  if (!ISO_DATE.test(value || '')) return false
  try { return toISODate(parseISO(value)) === value } catch { return false }
}

const workspaceSpecialistId = (specialist, appMode) => (
  appMode === 'app' ? specialist.id : `sp_demo_${specialist.id}`
)

export function SpecialistAbsenceDrawer({ opts = {}, onClose }) {
  const { state, toast, workspace } = useApp()
  const { appMode, capabilities, role, registerLeaveGuard } = useShell()
  const drawerRef = useRef(null)
  const backRef = useRef(null)
  const defaultDate = opts.date || toISODate(new Date())
  const [form, setForm] = useState({
    specialistId: opts.psychId || (role.scope === 'own' ? role.psychId : ''),
    dateFrom: defaultDate,
    dateTo: opts.date || defaultDate,
  })
  const [errors, setErrors] = useState({})
  const [saving, setSaving] = useState(false)
  const [initialForm] = useState(form)
  const discardGuard = useDiscardGuard(JSON.stringify(form) !== JSON.stringify(initialForm))
  const { close, forceClose, shake } = useDrawerFX(
    drawerRef, backRef, onClose, discardGuard.guard,
  )
  useEffect(() => registerLeaveGuard(discardGuard.check), [registerLeaveGuard, discardGuard.check])

  const specialists = state.psychologists.filter((specialist) => (
    (appMode !== 'app' || specialist.status === 'active')
      && (role.scope !== 'own' || specialist.id === role.psychId)
  ))
  const set = (key, value) => {
    setForm((current) => ({ ...current, [key]: value }))
    setErrors((current) => ({ ...current, [key]: null, form: null }))
  }
  const submit = async (event) => {
    event.preventDefault()
    if (saving || (appMode === 'app' && !canPerformAction(capabilities, 'appointment.edit'))) return
    const nextErrors = {}
    if (!form.specialistId || !specialists.some(({ id }) => id === form.specialistId)) {
      nextErrors.specialistId = 'Wybierz aktywną specjalistkę'
    }
    if (!validDate(form.dateFrom)) nextErrors.dateFrom = 'Podaj poprawną datę'
    if (!validDate(form.dateTo)) nextErrors.dateTo = 'Podaj poprawną datę'
    if (!nextErrors.dateFrom && !nextErrors.dateTo && form.dateTo < form.dateFrom) {
      nextErrors.dateTo = 'Data końcowa nie może być wcześniejsza'
    }
    setErrors(nextErrors)
    if (Object.values(nextErrors).some(Boolean)) {
      shake()
      requestAnimationFrame(() => drawerRef.current?.querySelector('.has-error input, .has-error select')?.focus())
      return
    }
    setSaving(true)
    try {
      await workspace.absences.create({
        specialistId: workspaceSpecialistId(
          specialists.find(({ id }) => id === form.specialistId), appMode,
        ),
        dateFrom: form.dateFrom,
        dateTo: form.dateTo,
        allDay: true,
      })
      toast('Zaznaczono wolne w Grafiku')
      forceClose()
    } catch {
      setSaving(false)
      setErrors({ form: 'Nie udało się zapisać wolnego zakresu.' })
    }
  }

  return (
    <>
      <div className="drawer-backdrop" ref={backRef} onClick={close} />
      <aside className="drawer" ref={drawerRef} role="dialog" aria-modal="true" aria-label="Zaznacz wolne">
        <div className="drawer__head">
          <div>
            <h2 className="drawer__title">Zaznacz wolne</h2>
            <p className="drawer__sub">Całodniowy zakres w Grafiku.</p>
          </div>
          <IconBtn name="close" label="Zamknij" onClick={close} />
        </div>
        <form className="drawer__body" onSubmit={submit} noValidate>
          <Field label="Specjalistka" error={errors.specialistId}>
            <select
              name="absence-specialist"
              className="select"
              value={form.specialistId}
              onChange={(event) => set('specialistId', event.target.value)}
            >
              <option value="">- wybierz -</option>
              {specialists.map((specialist) => (
                <option key={specialist.id} value={specialist.id}>
                  {specialist.professionalTitle || specialist.title || 'Specjalistka'} {specialist.displayName || specialist.name}
                </option>
              ))}
            </select>
          </Field>
          <div className="form-grid">
            <Field label="Od" error={errors.dateFrom}>
              <input
                type="date"
                name="absence-from"
                className="input"
                value={form.dateFrom}
                onChange={(event) => set('dateFrom', event.target.value)}
              />
            </Field>
            <Field label="Do" error={errors.dateTo}>
              <input
                type="date"
                name="absence-to"
                className="input"
                value={form.dateTo}
                onChange={(event) => set('dateTo', event.target.value)}
              />
            </Field>
          </div>
          <div className="form-warn" role="status">
            <Icon name="calendar" size={15} />
            <span>Zakres dotyczy całych dni. Sesje w tym czasie pokażą żółte ostrzeżenie, ale nadal można je zapisać.</span>
          </div>
          {errors.form && <div className="form-warn form-warn--error" role="alert"><Icon name="alert" size={15} /><span>{errors.form}</span></div>}
        </form>
        {discardGuard.confirming && <DiscardConfirm onStay={discardGuard.hide} onDiscard={forceClose} />}
        <div className="drawer__foot">
          <Button variant="primary" onClick={submit} disabled={saving}>
            {saving ? 'Zapisywanie…' : 'Zapisz wolne'}
          </Button>
          <Button variant="ghost" onClick={close} disabled={saving}>Anuluj</Button>
        </div>
      </aside>
    </>
  )
}

export { workspaceSpecialistId }

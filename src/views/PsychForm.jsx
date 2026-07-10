// Add/Edit psychologist — slide-over drawer. Delete is blocked while the
// specialist still has assigned clients or upcoming sessions.
import { useRef, useState } from 'react'
import { useApp } from '../store.jsx'
import { useShell } from '../shell-ctx.js'
import { Button, Field, IconBtn } from '../ui.jsx'
import { Icon } from '../icons.jsx'
import { useDrawerFX } from '../anim.js'
import { toISODate, plural } from '../format.js'

// palette for newly added specialists (color + soft pastel pair)
const NEW_PAIRS = [
  ['#7c6373', '#e7dde4'],
  ['#5f7050', '#e2e5d5'],
  ['#b3756a', '#f3e0d6'],
  ['#8a7baa', '#e9dee6'],
]

export function PsychDrawer({ opts, onClose }) {
  const { state, dispatch, toast } = useApp()
  const { route, navigate } = useShell()
  const editing = opts.psych || null
  const drawerRef = useRef(null)
  const backRef = useRef(null)
  const { close, shake } = useDrawerFX(drawerRef, backRef, onClose)

  const [form, setForm] = useState({
    title: editing?.title || 'mgr',
    name: editing?.name || '',
    spec: editing?.spec || '',
    email: editing?.email || '',
    phone: editing?.phone || '',
    room: editing?.room || '',
    rate: editing ? editing.rate : '',
  })
  const [errors, setErrors] = useState({})
  const [confirmDel, setConfirmDel] = useState(false)

  const set = (k, v) => {
    setForm((f) => ({ ...f, [k]: v }))
    setErrors((e) => ({ ...e, [k]: null }))
  }

  const submit = (e) => {
    e.preventDefault()
    const errs = {}
    if (!form.name.trim()) errs.name = 'Podaj imię i nazwisko'
    const rate = Number(form.rate)
    if (!rate || rate <= 0) errs.rate = 'Podaj stawkę większą od zera'
    setErrors(errs)
    if (Object.keys(errs).length) {
      shake()
      requestAnimationFrame(() =>
        drawerRef.current?.querySelector('.has-error input, .has-error select, .has-error textarea')?.focus()
      )
      return
    }
    const payload = {
      title: form.title,
      name: form.name.trim(),
      spec: form.spec.trim() || 'Psychoterapia',
      email: form.email.trim() || '—',
      phone: form.phone.trim() || '—',
      room: form.room.trim() || '—',
      rate,
    }
    if (editing) {
      dispatch({ type: 'UPDATE_PSYCH', id: editing.id, patch: payload })
      toast('Profil specjalistki zapisany')
    } else {
      const [color, soft] = NEW_PAIRS[state.psychologists.length % NEW_PAIRS.length]
      dispatch({ type: 'ADD_PSYCH', psych: { ...payload, color, soft } })
      toast('Nowa specjalistka dodana do zespołu')
    }
    close()
  }

  // delete guard — assigned clients, upcoming sessions or billing history all
  // block removal (orphaned sessions would skew reports and payments)
  const today = toISODate(new Date())
  const assigned = editing ? state.clients.filter((c) => c.psychId === editing.id).length : 0
  const ownSessions = editing ? state.sessions.filter((s) => s.psychId === editing.id) : []
  const upcoming = ownSessions.filter((s) => s.status === 'scheduled' && s.date >= today).length
  const past = ownSessions.length - upcoming
  const blocked = assigned > 0 || ownSessions.length > 0

  const remove = () => {
    dispatch({ type: 'DELETE_PSYCH', id: editing.id })
    toast('Specjalistka usunięta z zespołu', 'close')
    if (route.name === 'psych' && route.params?.id === editing.id) navigate('team')
    close()
  }

  return (
    <>
      <div className="drawer-backdrop" ref={backRef} onClick={close} />
      <aside className="drawer" ref={drawerRef} role="dialog" aria-modal="true" aria-label={editing ? 'Edycja profilu specjalistki' : 'Nowa specjalistka'}>
        <div className="drawer__head">
          <div>
            <h2 className="drawer__title">{editing ? 'Edycja profilu' : 'Nowa specjalistka'}</h2>
            <p className="drawer__sub">
              {editing ? `${editing.title} ${editing.name}` : 'Dodaj specjalistkę do zespołu centrum.'}
            </p>
          </div>
          <IconBtn name="close" label="Zamknij" onClick={close} />
        </div>

        <form className="drawer__body" onSubmit={submit} noValidate>
          <div className="form-grid">
            <Field label="Tytuł">
              <select className="select" value={form.title} onChange={(e) => set('title', e.target.value)}>
                <option value="mgr">mgr</option>
                <option value="dr">dr</option>
                <option value="dr hab.">dr hab.</option>
              </select>
            </Field>
            <Field label="Stawka (zł / sesja)" error={errors.rate}>
              <input
                type="number"
                min="0"
                step="10"
                inputMode="numeric"
                className="input"
                value={form.rate}
                placeholder="np. 220"
                onChange={(e) => set('rate', e.target.value)}
              />
            </Field>
          </div>

          <Field label="Imię i nazwisko" error={errors.name}>
            <input
              className="input"
              value={form.name}
              placeholder="np. Maria Nowak"
              onChange={(e) => set('name', e.target.value)}
            />
          </Field>

          <Field label="Specjalizacja">
            <input
              className="input"
              value={form.spec}
              placeholder="np. Terapia ACT"
              onChange={(e) => set('spec', e.target.value)}
            />
          </Field>

          <div className="form-grid">
            <Field label="E-mail">
              <input
                type="email"
                className="input"
                value={form.email}
                placeholder="np. maria@aurelia.pl"
                onChange={(e) => set('email', e.target.value)}
              />
            </Field>
            <Field label="Telefon">
              <input
                type="tel"
                className="input"
                value={form.phone}
                placeholder="+48 600 000 000"
                onChange={(e) => set('phone', e.target.value)}
              />
            </Field>
          </div>

          <Field label="Gabinet">
            <input
              className="input"
              value={form.room}
              placeholder="np. Gabinet 5"
              onChange={(e) => set('room', e.target.value)}
            />
          </Field>

          {/* a permanently blocked delete is explained up front, not after a press */}
          {editing && blocked && (
            <div className="form-warn" role="note">
              <Icon name="alert" size={15} />
              <span>
                Profilu nie można usunąć — ma{' '}
                {[
                  assigned > 0 && `${assigned} ${plural(assigned, 'klienta', 'klientów', 'klientów')} pod opieką`,
                  upcoming > 0 && `${upcoming} ${plural(upcoming, 'zaplanowaną sesję', 'zaplanowane sesje', 'zaplanowanych sesji')}`,
                  past > 0 && `${past} ${plural(past, 'sesję', 'sesje', 'sesji')} w historii rozliczeń`,
                ]
                  .filter(Boolean)
                  .join(' oraz ')}
                . Profil powiązany z klientami lub sesjami musi pozostać w zespole, aby raporty i rozliczenia były spójne.
              </span>
            </div>
          )}

          {editing && !blocked && confirmDel && (
            <div className="form-warn form-warn--error" role="alert">
              <Icon name="alert" size={15} />
              <span>
                Profil <b>{editing.title} {editing.name}</b> zostanie trwale usunięty z zespołu.
                Tej operacji nie można cofnąć.
              </span>
            </div>
          )}
        </form>

        <div className="drawer__foot">
          {confirmDel && !blocked ? (
            <>
              <Button variant="danger" onClick={remove}>
                Tak, usuń profil
              </Button>
              <Button variant="ghost" onClick={() => setConfirmDel(false)}>Wróć</Button>
            </>
          ) : (
            <>
              <Button variant="primary" onClick={submit}>
                {editing ? 'Zapisz zmiany' : 'Dodaj do zespołu'}
              </Button>
              {editing && !blocked && (
                <Button variant="danger" onClick={() => setConfirmDel(true)}>
                  Usuń
                </Button>
              )}
              <Button variant="ghost" onClick={close}>Anuluj</Button>
            </>
          )}
        </div>
      </aside>
    </>
  )
}

// Add/Edit client — slide-over drawer with validation and delete-with-confirm.
import { useRef, useState } from 'react'
import { useApp, clientOutstanding } from '../store.jsx'
import { useShell } from '../shell-ctx.js'
import { clientsForRole } from '../workspace.js'
import { Button, Field, Segmented, IconBtn } from '../ui.jsx'
import { Icon } from '../icons.jsx'
import { useDrawerFX } from '../anim.js'
import { toISODate, plural, fmtMoney } from '../format.js'

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export function ClientDrawer({ opts, onClose }) {
  const { state, dispatch, toast } = useApp()
  const { route, navigate, role } = useShell()
  const editing = opts.client || null
  const drawerRef = useRef(null)
  const backRef = useRef(null)
  const { close, shake } = useDrawerFX(drawerRef, backRef, onClose)

  const [form, setForm] = useState({
    name: editing?.name || '',
    psychId: editing?.psychId || opts.psychId || '',
    email: editing?.email || '',
    phone: editing?.phone || '',
    status: editing?.status || 'active',
    familyOtherId: '',
    familyRole: editing?.familyRole || '',
    note: '',
  })
  const [errors, setErrors] = useState({})
  const [confirmDel, setConfirmDel] = useState(false)

  // the drawer may unlink while open — read the live record, not the snapshot
  const current = editing ? state.clients.find((c) => c.id === editing.id) || editing : null
  const familyMembers = current?.familyId
    ? state.clients.filter((c) => c.familyId === current.familyId && c.id !== current.id)
    : []
  // therapists may link only within their own client list
  const linkables = clientsForRole(state, role).filter(
    (c) => c.id !== editing?.id && !familyMembers.some((m) => m.id === c.id)
  )

  const set = (k, v) => {
    setForm((f) => ({ ...f, [k]: v }))
    setErrors((e) => ({ ...e, [k]: null }))
  }

  const submit = (e) => {
    e.preventDefault()
    const errs = {}
    if (!form.name.trim()) errs.name = 'Podaj imię i nazwisko'
    if (!form.psychId) errs.psychId = 'Wybierz specjalistkę'
    if (form.email.trim() && !EMAIL_SHAPE.test(form.email.trim())) errs.email = 'Podaj poprawny adres e-mail'
    setErrors(errs)
    if (Object.keys(errs).length) {
      shake()
      requestAnimationFrame(() =>
        drawerRef.current?.querySelector('.has-error input, .has-error select, .has-error textarea')?.focus()
      )
      return
    }
    const payload = {
      name: form.name.trim(),
      psychId: form.psychId,
      email: form.email.trim(),
      phone: form.phone.trim(),
      status: form.status,
    }
    if (editing) {
      const patch = { ...payload }
      if (current?.familyId && !form.familyOtherId) patch.familyRole = form.familyRole || null
      dispatch({ type: 'UPDATE_CLIENT', id: editing.id, patch })
      if (form.familyOtherId) {
        dispatch({ type: 'LINK_FAMILY', clientId: editing.id, otherId: form.familyOtherId, role: form.familyRole || null })
      }
      toast('Dane klienta zapisane')
    } else {
      const note = form.note.trim()
      dispatch({
        type: 'ADD_CLIENT',
        client: {
          ...payload,
          since: toISODate(new Date()),
          notes: note ? [{ date: toISODate(new Date()), text: note }] : [],
        },
        familyLink: form.familyOtherId
          ? { otherId: form.familyOtherId, role: form.familyRole || null }
          : undefined,
      })
      toast('Nowy klient dodany do kartoteki')
    }
    close()
  }

  const sessionCount = editing ? state.sessions.filter((s) => s.clientId === editing.id).length : 0
  const debt = editing ? clientOutstanding(state.sessions, editing.id) : 0

  const remove = () => {
    dispatch({ type: 'DELETE_CLIENT', id: editing.id })
    toast('Klient usunięty z kartoteki', 'close')
    if (route.name === 'client' && route.params?.id === editing.id) navigate('clients')
    close()
  }

  return (
    <>
      <div className="drawer-backdrop" ref={backRef} onClick={close} />
      <aside className="drawer" ref={drawerRef} role="dialog" aria-modal="true" aria-label={editing ? 'Edycja klienta' : 'Nowy klient'}>
        <div className="drawer__head">
          <div>
            <h2 className="drawer__title">{editing ? 'Edycja klienta' : 'Nowy klient'}</h2>
            <p className="drawer__sub">
              {editing ? editing.name : 'Dodaj osobę do kartoteki centrum.'}
            </p>
          </div>
          <IconBtn name="close" label="Zamknij" onClick={close} />
        </div>

        <form className="drawer__body" onSubmit={submit} noValidate>
          <Field label="Imię i nazwisko" error={errors.name}>
            <input
              className="input"
              value={form.name}
              placeholder="np. Maria Nowak"
              onChange={(e) => set('name', e.target.value)}
            />
          </Field>

          <Field label="Specjalistka prowadząca" error={errors.psychId}>
            <select className="select" value={form.psychId} onChange={(e) => set('psychId', e.target.value)}>
              <option value="">— wybierz —</option>
              {state.psychologists.map((p) => (
                <option key={p.id} value={p.id}>{p.title} {p.name}</option>
              ))}
            </select>
          </Field>

          <div className="form-grid">
            <Field label="E-mail" error={errors.email}>
              <input
                type="email"
                className="input"
                value={form.email}
                placeholder="np. maria@gmail.com"
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

          <Field
            label="Status"
            hint="Wstrzymani klienci pozostają w kartotece, ale nie planujesz im nowych sesji."
          >
            <Segmented
              ariaLabel="Status klienta"
              value={form.status}
              onChange={(v) => set('status', v)}
              options={[
                { value: 'active', label: 'Aktywny' },
                { value: 'paused', label: 'Wstrzymany' },
              ]}
            />
          </Field>

          <Field
            label="Rodzina"
            hint="Rodzic i dziecko bywają zapisani pod różnymi nazwiskami — powiązanie łączy ich karty."
          >
            <div className="stack" style={{ gap: 10, paddingTop: 2 }}>
              {familyMembers.length > 0 && (
                <div className="stack" style={{ gap: 6 }}>
                  {familyMembers.map((m) => (
                    <div key={m.id} style={{ fontSize: 14 }}>
                      {m.name}
                      {m.familyRole && <span className="faint"> · {m.familyRole}</span>}
                    </div>
                  ))}
                  <button
                    type="button"
                    className="link"
                    style={{ alignSelf: 'flex-start', fontSize: 13 }}
                    onClick={() => {
                      dispatch({ type: 'UNLINK_FAMILY', clientId: editing.id })
                      set('familyRole', '')
                      toast('Powiązanie rodzinne usunięte', 'close')
                    }}
                  >
                    Usuń powiązanie z rodziną
                  </button>
                </div>
              )}
              <select
                className="select"
                aria-label="Powiąż z klientem"
                value={form.familyOtherId}
                onChange={(e) => set('familyOtherId', e.target.value)}
              >
                <option value="">— powiąż z klientem —</option>
                {linkables.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            </div>
          </Field>

          {(current?.familyId || form.familyOtherId) && (
            <Field label="Rola w rodzinie">
              <Segmented
                ariaLabel="Rola w rodzinie"
                value={form.familyRole}
                onChange={(v) => set('familyRole', v)}
                options={[
                  { value: '', label: '—' },
                  { value: 'rodzic', label: 'Rodzic' },
                  { value: 'dziecko', label: 'Dziecko' },
                ]}
              />
            </Field>
          )}

          {!editing && (
            <Field label="Pierwsza notatka (opcjonalnie)">
              <textarea
                className="textarea"
                value={form.note}
                placeholder="Powód zgłoszenia, pierwsze obserwacje…"
                onChange={(e) => set('note', e.target.value)}
              />
            </Field>
          )}

          {editing && confirmDel && (
            <div className="form-warn form-warn--error" role="alert">
              <Icon name="alert" size={15} />
              <span>
                Usunięcie klienta <b>{editing.name}</b> jest nieodwracalne
                {sessionCount > 0 && (
                  <> i usunie też <b>{sessionCount} {plural(sessionCount, 'sesję', 'sesje', 'sesji')}</b> z historii i rozliczeń
                  {debt > 0 && <>, w tym nierozliczoną zaległość <b>{fmtMoney(debt)}</b></>}</>
                )}
                .
              </span>
            </div>
          )}
        </form>

        <div className="drawer__foot">
          {confirmDel ? (
            <>
              <Button variant="danger" onClick={remove}>
                Tak, usuń klienta
              </Button>
              <Button variant="ghost" onClick={() => setConfirmDel(false)}>Wróć</Button>
            </>
          ) : (
            <>
              <Button variant="primary" onClick={submit}>
                {editing ? 'Zapisz zmiany' : 'Dodaj klienta'}
              </Button>
              {editing && (
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

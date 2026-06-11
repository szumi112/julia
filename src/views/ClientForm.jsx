// Add/Edit client — slide-over drawer with validation and delete-with-confirm.
import { useRef, useState } from 'react'
import { useApp } from '../store.jsx'
import { useShell } from '../shell-ctx.js'
import { Button, Field, Segmented, IconBtn } from '../ui.jsx'
import { Icon } from '../icons.jsx'
import { useDrawerFX } from '../anim.js'
import { toISODate, plural } from '../format.js'

export function ClientDrawer({ opts, onClose }) {
  const { state, dispatch, toast } = useApp()
  const { route, navigate } = useShell()
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
    note: '',
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
    if (!form.psychId) errs.psychId = 'Wybierz specjalistkę'
    setErrors(errs)
    if (Object.keys(errs).length) {
      shake()
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
      dispatch({ type: 'UPDATE_CLIENT', id: editing.id, patch: payload })
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
      })
      toast('Nowy klient dodany do kartoteki')
    }
    close()
  }

  const sessionCount = editing ? state.sessions.filter((s) => s.clientId === editing.id).length : 0

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
              autoFocus
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
            <Field label="E-mail">
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
                  <> i usunie też <b>{sessionCount} {plural(sessionCount, 'sesję', 'sesje', 'sesji')}</b> z historii i rozliczeń</>
                )}
                .
              </span>
            </div>
          )}
        </form>

        <div className="drawer__foot">
          {confirmDel ? (
            <>
              <Button variant="danger" style={{ flex: 1 }} onClick={remove}>
                Tak, usuń klienta
              </Button>
              <Button variant="ghost" onClick={() => setConfirmDel(false)}>Wróć</Button>
            </>
          ) : (
            <>
              <Button variant="primary" onClick={submit} style={{ flex: 1 }}>
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

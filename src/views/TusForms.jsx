// TUS management drawers: group, kid profile, and single class (reschedule).
import { useRef, useState } from 'react'
import { useApp } from '../store.jsx'
import { Button, Field, Check, IconBtn } from '../ui.jsx'
import { Icon } from '../icons.jsx'
import { useDrawerFX } from '../anim.js'
import { toISODate, parseISO, fmtDayMonth } from '../format.js'
import { TusChildQuickCreate, TusMemberPicker } from './TusMemberPicker.jsx'

const WEEKDAY_OPTIONS = [
  { value: 1, label: 'Poniedziałek' },
  { value: 2, label: 'Wtorek' },
  { value: 3, label: 'Środa' },
  { value: 4, label: 'Czwartek' },
  { value: 5, label: 'Piątek' },
]

const focusFirstInvalid = (drawerRef) =>
  requestAnimationFrame(() =>
    drawerRef.current?.querySelector('.has-error input, .has-error select, .has-error textarea')?.focus()
  )

export function TusGroupDrawer({ opts, onClose }) {
  const { state, dispatch, toast } = useApp()
  const editing = opts.group || null
  const drawerRef = useRef(null)
  const backRef = useRef(null)
  const { close, shake } = useDrawerFX(drawerRef, backRef, onClose)

  const [form, setForm] = useState({
    name: editing?.name || '',
    age: editing?.age || '',
    leaderIds: editing?.leaderIds || [],
    weekday: editing?.weekday ?? 3,
    time: editing?.time || '16:00',
    fee: editing?.fee ?? 300,
  })
  const [errors, setErrors] = useState({})
  const [mode, setMode] = useState('group')
  const [memberKeys, setMemberKeys] = useState(() => editing
    ? state.tusKids.filter((kid) => kid.groupId === editing.id).map((kid) => `kid:${kid.id}`)
    : [])
  const [newChildren, setNewChildren] = useState([])
  const nextDraftId = useRef(1)

  const set = (k, v) => {
    setForm((f) => ({ ...f, [k]: v }))
    setErrors((e) => ({ ...e, [k]: null }))
  }
  const toggleLeader = (id) =>
    set('leaderIds', form.leaderIds.includes(id) ? form.leaderIds.filter((x) => x !== id) : [...form.leaderIds, id])
  const toggleMember = (key) => setMemberKeys((current) =>
    current.includes(key) ? current.filter((candidate) => candidate !== key) : [...current, key]
  )
  const removeMember = (key) => {
    setMemberKeys((current) => current.filter((candidate) => candidate !== key))
    if (key.startsWith('new:')) setNewChildren((current) => current.filter((draft) => draft.key !== key))
  }
  const addDraftChild = (draft) => {
    const key = `new:${nextDraftId.current++}`
    setNewChildren((current) => [...current, { ...draft, key }])
    setMemberKeys((current) => [...current, key])
    setMode('group')
  }

  const submit = (e) => {
    e.preventDefault()
    const errs = {}
    if (!form.name.trim()) errs.name = 'Podaj nazwę grupy'
    if (form.leaderIds.length === 0) errs.leaderIds = 'Wybierz co najmniej jedną prowadzącą'
    if (!(Number(form.fee) > 0)) errs.fee = 'Podaj kwotę większą od zera'
    if (!form.time) errs.time = 'Podaj godzinę zajęć'
    setErrors(errs)
    if (Object.keys(errs).length) {
      shake()
      focusFirstInvalid(drawerRef)
      return
    }
    const payload = {
      name: form.name.trim(),
      age: form.age.trim(),
      leaderIds: form.leaderIds,
      weekday: Number(form.weekday),
      time: form.time,
      fee: Number(form.fee),
    }
    if (editing) {
      dispatch({ type: 'UPDATE_TUS_GROUP', id: editing.id, patch: payload, memberKeys, newChildren })
      toast('Grupa zapisana')
    } else {
      dispatch({ type: 'ADD_TUS_GROUP', group: payload, memberKeys, newChildren })
      toast('Nowa grupa utworzona')
    }
    close()
  }

  return (
    <>
      <div className="drawer-backdrop" ref={backRef} onClick={close} />
      <aside
        className="drawer"
        ref={drawerRef}
        role="dialog"
        aria-modal="true"
        aria-label={mode === 'child' ? 'Nowe dziecko i rodzic' : editing ? 'Edycja grupy TUS' : 'Nowa grupa TUS'}
      >
        <div className="drawer__head">
          <div className="drawer__head-main">
            {mode === 'child' ? <IconBtn name="arrowL" label="Wróć do grupy" onClick={() => setMode('group')} /> : null}
            <div>
              <h2 className="drawer__title">{mode === 'child' ? 'Nowe dziecko' : editing ? 'Edycja grupy' : 'Nowa grupa'}</h2>
              <p className="drawer__sub">
                {mode === 'child'
                  ? 'Dodaj dziecko i dane rodzica lub opiekuna.'
                  : editing ? editing.name : 'Utwórz grupę wiekową zajęć TUS.'}
              </p>
            </div>
          </div>
          <IconBtn name="close" label="Zamknij" onClick={close} />
        </div>

        {mode === 'child' ? (
          <TusChildQuickCreate
            clients={state.clients}
            pendingParents={newChildren}
            onAdd={addDraftChild}
            onCancel={() => setMode('group')}
            onInvalid={() => {
              shake()
              focusFirstInvalid(drawerRef)
            }}
          />
        ) : (
          <>
            <form className="drawer__body" onSubmit={submit} noValidate>
              <Field label="Nazwa grupy" error={errors.name}>
                <input className="input" value={form.name} placeholder="np. Grupa TUS 5–6 lat" onChange={(e) => set('name', e.target.value)} />
              </Field>

              <Field label="Przedział wiekowy" hint="Dzieci dzielone są na grupy według wieku.">
                <input className="input" value={form.age} placeholder="np. 5–6 lat" onChange={(e) => set('age', e.target.value)} />
              </Field>

              <TusMemberPicker
                clients={state.clients}
                kids={state.tusKids}
                groups={state.tusGroups}
                selectedKeys={memberKeys}
                newChildren={newChildren}
                onToggle={toggleMember}
                onRemove={removeMember}
                onStartCreate={() => setMode('child')}
                targetGroupId={editing?.id || null}
              />

              <Field label="Prowadzące" error={errors.leaderIds} hint="Zwykle dwie psycholożki na grupę.">
                <div className="stack" style={{ gap: 9, paddingTop: 2 }}>
                  {state.psychologists.map((p) => (
                    <Check key={p.id} checked={form.leaderIds.includes(p.id)} onChange={() => toggleLeader(p.id)}>
                      {p.title} {p.name}
                    </Check>
                  ))}
                </div>
              </Field>

              <div className="form-grid">
                <Field label="Dzień tygodnia">
                  <select className="select" value={form.weekday} onChange={(e) => set('weekday', Number(e.target.value))}>
                    {WEEKDAY_OPTIONS.map((w) => (
                      <option key={w.value} value={w.value}>{w.label}</option>
                    ))}
                  </select>
                </Field>
                <Field label="Godzina" error={errors.time}>
                  <input type="time" className="input" value={form.time} onChange={(e) => set('time', e.target.value)} />
                </Field>
              </div>

              <Field label="Opłata miesięczna (zł)" error={errors.fee}>
                <input type="number" min="0" step="25" inputMode="numeric" className="input" value={form.fee} onChange={(e) => set('fee', e.target.value)} />
              </Field>
            </form>

            <div className="drawer__foot">
              <Button variant="primary" onClick={submit}>{editing ? 'Zapisz zmiany' : 'Utwórz grupę'}</Button>
              <Button variant="ghost" onClick={close}>Anuluj</Button>
            </div>
          </>
        )}
      </aside>
    </>
  )
}

export function TusKidDrawer({ opts, onClose }) {
  const { state, dispatch, toast } = useApp()
  const editing = opts.kid || null
  const drawerRef = useRef(null)
  const backRef = useRef(null)
  const { close, shake } = useDrawerFX(drawerRef, backRef, onClose)

  const [form, setForm] = useState({
    name: editing?.name || '',
    age: editing?.age ?? '',
    groupId: editing?.groupId ?? opts.groupId ?? '',
    parentName: editing?.parentName || '',
    parentPhone: editing?.parentPhone || '',
    regulationsSigned: editing?.regulationsSigned ?? false,
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
    if (!form.name.trim()) errs.name = 'Podaj imię i nazwisko dziecka'
    if (!form.parentName.trim()) errs.parentName = 'Podaj kontakt do rodzica'
    if (form.age !== '' && !(Number(form.age) >= 3 && Number(form.age) <= 12)) errs.age = 'Podaj wiek 3–12 lat'
    setErrors(errs)
    if (Object.keys(errs).length) {
      shake()
      focusFirstInvalid(drawerRef)
      return
    }
    const payload = {
      name: form.name.trim(),
      age: form.age === '' ? null : Number(form.age),
      groupId: form.groupId || null,
      parentName: form.parentName.trim(),
      parentPhone: form.parentPhone.trim(),
      regulationsSigned: form.regulationsSigned,
    }
    if (editing) {
      dispatch({ type: 'UPDATE_TUS_KID', id: editing.id, patch: payload })
      toast('Profil dziecka zapisany')
    } else {
      dispatch({ type: 'ADD_TUS_KID', kid: { ...payload, note: '' } })
      toast('Dziecko dodane do zajęć TUS')
    }
    close()
  }

  const remove = () => {
    dispatch({ type: 'DELETE_TUS_KID', id: editing.id })
    toast('Profil dziecka usunięty', 'close')
    close()
  }

  return (
    <>
      <div className="drawer-backdrop" ref={backRef} onClick={close} />
      <aside className="drawer" ref={drawerRef} role="dialog" aria-modal="true" aria-label={editing ? 'Edycja profilu dziecka' : 'Nowe dziecko'}>
        <div className="drawer__head">
          <div>
            <h2 className="drawer__title">{editing ? 'Profil dziecka' : 'Nowe dziecko'}</h2>
            <p className="drawer__sub">{editing ? editing.name : 'Zapisz dziecko na zajęcia TUS.'}</p>
          </div>
          <IconBtn name="close" label="Zamknij" onClick={close} />
        </div>

        <form className="drawer__body" onSubmit={submit} noValidate>
          <div className="form-grid">
            <Field label="Imię i nazwisko" error={errors.name} className="span2">
              <input className="input" value={form.name} placeholder="np. Hania Malik" onChange={(e) => set('name', e.target.value)} />
            </Field>
            <Field label="Wiek" error={errors.age}>
              <input type="number" min="3" max="12" inputMode="numeric" className="input" value={form.age} onChange={(e) => set('age', e.target.value)} />
            </Field>
            <Field label="Grupa" hint="Dziecko bez grupy czeka na przydział.">
              <select className="select" value={form.groupId} onChange={(e) => set('groupId', e.target.value)}>
                <option value="">— Bez grupy —</option>
                {state.tusGroups.map((g) => (
                  <option key={g.id} value={g.id}>{g.name}</option>
                ))}
              </select>
            </Field>
          </div>

          <div className="form-grid">
            <Field label="Rodzic / opiekun" error={errors.parentName} hint="Rodzic bywa zapisany pod innym nazwiskiem.">
              <input className="input" value={form.parentName} placeholder="np. Ewa Malik" onChange={(e) => set('parentName', e.target.value)} />
            </Field>
            <Field label="Telefon rodzica">
              <input type="tel" className="input" value={form.parentPhone} placeholder="+48 600 000 000" onChange={(e) => set('parentPhone', e.target.value)} />
            </Field>
          </div>

          <Field label="Regulamin zajęć">
            <Check checked={form.regulationsSigned} onChange={(v) => set('regulationsSigned', v)}>
              Rodzic podpisał regulamin
            </Check>
          </Field>

          {editing && confirmDel && (
            <div className="form-warn form-warn--error" role="alert">
              <Icon name="alert" size={15} />
              <span>
                Usunięcie profilu <b>{editing.name}</b> jest nieodwracalne — zniknie też historia obecności i opłat tego dziecka.
              </span>
            </div>
          )}
        </form>

        <div className="drawer__foot">
          {confirmDel ? (
            <>
              <Button variant="danger" onClick={remove}>Tak, usuń profil</Button>
              <Button variant="ghost" onClick={() => setConfirmDel(false)}>Wróć</Button>
            </>
          ) : (
            <>
              <Button variant="primary" onClick={submit}>{editing ? 'Zapisz zmiany' : 'Dodaj dziecko'}</Button>
              {editing && <Button variant="danger" onClick={() => setConfirmDel(true)}>Usuń</Button>}
              <Button variant="ghost" onClick={close}>Anuluj</Button>
            </>
          )}
        </div>
      </aside>
    </>
  )
}

export function TusClassDrawer({ opts, onClose }) {
  const { state, dispatch, toast } = useApp()
  const editing = opts.cls || null
  const drawerRef = useRef(null)
  const backRef = useRef(null)
  const { close, shake } = useDrawerFX(drawerRef, backRef, onClose)

  const group = state.tusGroups.find((g) => g.id === (editing?.groupId || opts.groupId))

  // adding: propose the next weekly slot after the group's last class
  const defaultDate = () => {
    const last = state.tusClasses.filter((c) => c.groupId === group?.id).at(-1)
    if (!last) return toISODate(new Date())
    const d = parseISO(last.date)
    d.setDate(d.getDate() + 7)
    return toISODate(d)
  }

  const [form, setForm] = useState({
    date: editing?.date || defaultDate(),
    time: editing?.time || group?.time || '16:00',
    topic: editing?.topic || '',
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
    if (!form.date) errs.date = 'Podaj datę zajęć'
    if (!form.time) errs.time = 'Podaj godzinę zajęć'
    setErrors(errs)
    if (Object.keys(errs).length) {
      shake()
      focusFirstInvalid(drawerRef)
      return
    }
    const payload = { date: form.date, time: form.time, topic: form.topic.trim() }
    if (editing) {
      dispatch({ type: 'UPDATE_TUS_CLASS', id: editing.id, patch: payload })
      toast(form.date !== editing.date ? 'Zajęcia przeniesione' : 'Zajęcia zapisane')
    } else {
      dispatch({ type: 'ADD_TUS_CLASS', cls: { ...payload, groupId: group.id, attendance: {} } })
      toast('Zajęcia dodane')
    }
    close()
  }

  const remove = () => {
    dispatch({ type: 'DELETE_TUS_CLASS', id: editing.id })
    toast('Zajęcia usunięte', 'close')
    close()
  }

  return (
    <>
      <div className="drawer-backdrop" ref={backRef} onClick={close} />
      <aside className="drawer" ref={drawerRef} role="dialog" aria-modal="true" aria-label={editing ? 'Edycja zajęć' : 'Nowe zajęcia'}>
        <div className="drawer__head">
          <div>
            <h2 className="drawer__title">{editing ? 'Edycja zajęć' : 'Nowe zajęcia'}</h2>
            <p className="drawer__sub">
              {group?.name}{editing ? ` · ${fmtDayMonth(editing.date)}` : ''}
            </p>
          </div>
          <IconBtn name="close" label="Zamknij" onClick={close} />
        </div>

        <form className="drawer__body" onSubmit={submit} noValidate>
          <div className="form-grid">
            <Field label="Data" error={errors.date} hint={editing ? 'Zmiana daty przenosi zajęcia wraz z obecnością.' : undefined}>
              <input type="date" className="input" value={form.date} onChange={(e) => set('date', e.target.value)} />
            </Field>
            <Field label="Godzina" error={errors.time}>
              <input type="time" className="input" value={form.time} onChange={(e) => set('time', e.target.value)} />
            </Field>
          </div>

          <Field label="Temat zajęć" hint="Prowadzące uzupełniają temat po zajęciach.">
            <input className="input" value={form.topic} placeholder="np. Rozpoznawanie emocji" onChange={(e) => set('topic', e.target.value)} />
          </Field>

          {editing && confirmDel && (
            <div className="form-warn form-warn--error" role="alert">
              <Icon name="alert" size={15} />
              <span>
                Usunięcie zajęć z <b>{fmtDayMonth(editing.date)}</b> jest nieodwracalne — zniknie też zapisana obecność.
              </span>
            </div>
          )}
        </form>

        <div className="drawer__foot">
          {confirmDel ? (
            <>
              <Button variant="danger" onClick={remove}>Tak, usuń zajęcia</Button>
              <Button variant="ghost" onClick={() => setConfirmDel(false)}>Wróć</Button>
            </>
          ) : (
            <>
              <Button variant="primary" onClick={submit}>{editing ? 'Zapisz zmiany' : 'Dodaj zajęcia'}</Button>
              {editing && <Button variant="danger" onClick={() => setConfirmDel(true)}>Usuń</Button>}
              <Button variant="ghost" onClick={close}>Anuluj</Button>
            </>
          )}
        </div>
      </aside>
    </>
  )
}

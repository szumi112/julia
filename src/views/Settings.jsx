import { useEffect, useState } from 'react'
import { useApp } from '../store.jsx'
import { useShell } from '../shell-ctx.js'
import { useReveal, setReduceMotion } from '../anim.js'
import { Button, Field, Avatar, Toggle, IconBtn } from '../ui.jsx'

// quick rate edit — local while typing, committed to the store on blur so a
// half-typed value never leaks into session amounts
function RateInput({ psych }) {
  const { dispatch, toast } = useApp()
  const [val, setVal] = useState(String(psych.rate))
  useEffect(() => { setVal(String(psych.rate)) }, [psych.rate])

  const commit = () => {
    const rate = Number(val)
    if (rate > 0 && rate !== psych.rate) {
      dispatch({ type: 'UPDATE_PSYCH', id: psych.id, patch: { rate } })
      toast(`Stawka zaktualizowana: ${psych.name.split(' ')[0]}`)
    } else {
      setVal(String(psych.rate))
    }
  }

  return (
    <input
      className="input"
      type="number"
      min="0"
      step="10"
      style={{ width: 96, height: 38 }}
      value={val}
      aria-label={`Stawka — ${psych.name}`}
      onChange={(e) => setVal(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }}
    />
  )
}

export function Settings() {
  const { state, dispatch, toast } = useApp()
  const { openPsychForm } = useShell()
  const ref = useReveal()

  const [profile, setProfile] = useState({ name: state.user.name, email: state.user.email })
  const [center, setCenter] = useState({ ...state.center })

  const saveProfile = () => {
    dispatch({ type: 'UPDATE_USER', patch: profile })
    toast('Profil zaktualizowany')
  }
  const saveCenter = () => {
    dispatch({ type: 'UPDATE_CENTER', patch: center })
    toast('Dane centrum zapisane')
  }

  return (
    <div ref={ref}>
      <div className="view-head" data-reveal>
        <div>
          <div className="eyebrow">Konfiguracja</div>
          <h1 className="display view-head__title">Ustawienia <em>centrum</em></h1>
        </div>
      </div>

      <div className="grid-2" style={{ alignItems: 'start' }}>
        <div className="stack">
          <div className="card card--pad" data-reveal>
            <h2 className="card-title">Twój profil</h2>
            <div className="stack" style={{ marginTop: 18 }}>
              <Field label="Imię i nazwisko">
                <input className="input" value={profile.name}
                  onChange={(e) => setProfile({ ...profile, name: e.target.value })} />
              </Field>
              <Field label="Adres e-mail">
                <input className="input" type="email" value={profile.email}
                  onChange={(e) => setProfile({ ...profile, email: e.target.value })} />
              </Field>
              <div><Button size="sm" onClick={saveProfile}>Zapisz profil</Button></div>
            </div>
          </div>

          <div className="card card--pad" data-reveal>
            <h2 className="card-title">Dane centrum</h2>
            <div className="stack" style={{ marginTop: 18 }}>
              <Field label="Nazwa">
                <input className="input" value={center.name}
                  onChange={(e) => setCenter({ ...center, name: e.target.value })} />
              </Field>
              <Field label="Adres">
                <input className="input" value={center.address}
                  onChange={(e) => setCenter({ ...center, address: e.target.value })} />
              </Field>
              <div className="form-grid">
                <Field label="Telefon">
                  <input className="input" value={center.phone}
                    onChange={(e) => setCenter({ ...center, phone: e.target.value })} />
                </Field>
                <Field label="E-mail">
                  <input className="input" value={center.email}
                    onChange={(e) => setCenter({ ...center, email: e.target.value })} />
                </Field>
              </div>
              <div><Button size="sm" onClick={saveCenter}>Zapisz dane</Button></div>
            </div>
          </div>

          <div className="card card--pad" data-reveal>
            <h2 className="card-title">Preferencje</h2>
            <div style={{ marginTop: 8 }}>
              <div className="pref-row">
                <div>
                  <div className="pref-row__title">Ogranicz animacje</div>
                  <div className="pref-row__desc">
                    Wycisza efekty ruchu w całej aplikacji — przydatne przy wrażliwości na ruch.
                  </div>
                </div>
                <Toggle
                  on={state.prefs.reduceMotion}
                  label="Ogranicz animacje"
                  onChange={(v) => {
                    dispatch({ type: 'SET_PREF', key: 'reduceMotion', value: v })
                    setReduceMotion(v)
                    toast(v ? 'Animacje ograniczone' : 'Animacje włączone')
                  }}
                />
              </div>
              <div className="pref-row">
                <div>
                  <div className="pref-row__title">Weekendy w kalendarzu</div>
                  <div className="pref-row__desc">
                    Pokazuj soboty i niedziele w widoku miesiąca.
                  </div>
                </div>
                <Toggle
                  on={state.prefs.weekendsInCalendar}
                  label="Weekendy w kalendarzu"
                  onChange={(v) => dispatch({ type: 'SET_PREF', key: 'weekendsInCalendar', value: v })}
                />
              </div>
            </div>
          </div>
        </div>

        <div className="card card--pad" data-reveal>
          <h2 className="card-title">Zespół</h2>
          <div className="stack" style={{ marginTop: 16, gap: 0 }}>
            {state.psychologists.map((p) => (
              <div className="pref-row" key={p.id}>
                <span className="row" style={{ gap: 12 }}>
                  <Avatar name={p.name} color={p.color} size={38} />
                  <span>
                    <div className="pref-row__title">{p.title} {p.name}</div>
                    <div className="pref-row__desc">{p.spec}</div>
                  </span>
                </span>
                <span className="row" style={{ gap: 10 }}>
                  <RateInput psych={p} />
                  <span className="faint" style={{ fontSize: 13 }}>zł / sesja</span>
                  <IconBtn name="edit" label={`Edytuj profil — ${p.name}`} size={16} onClick={() => openPsychForm({ psych: p })} />
                </span>
              </div>
            ))}
          </div>

          <div className="divider-soft" />
          <div className="row row--between" style={{ gap: 16 }}>
            <div>
              <h3 style={{ fontFamily: 'var(--font-display)', fontSize: 16.5, fontWeight: 500 }}>
                Dodaj specjalistkę
              </h3>
              <p className="pref-row__desc" style={{ marginTop: 4 }}>
                Pełny profil — specjalizacja, stawka, kontakt i gabinet.
              </p>
            </div>
            <Button size="sm" icon="plus" onClick={() => openPsychForm()}>Dodaj</Button>
          </div>
        </div>
      </div>
    </div>
  )
}

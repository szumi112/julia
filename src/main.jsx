import React from 'react'
import { createRoot } from 'react-dom/client'
import { APP_MODE, appSurfaceFor } from './app-mode.js'
import './runtime-vendors.js'
import App from './App.jsx'
import './styles.css'

const ProtectedAppSurface = () => (
  <main className="protected-app" aria-labelledby="protected-app-title">
    <p className="protected-app__brand">Bear with me</p>
    <h1 id="protected-app-title">Aplikacja personelu</h1>
    <p>Uruchamianie chronionego dostępu.</p>
  </main>
)

const Root = appSurfaceFor(APP_MODE) === 'demo' ? App : ProtectedAppSurface

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>
)

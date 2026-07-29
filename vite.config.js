import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { cloudflare } from '@cloudflare/vite-plugin'
import { basePathFor } from './src/app-mode.js'

export default defineConfig(({ mode }) => {
  const demo = mode === 'demo'
  return {
    plugins: [react(), ...(demo ? [] : [cloudflare()])],
    base: basePathFor(mode),
    build: { outDir: demo ? 'dist/demo' : 'dist/app', emptyOutDir: true },
    server: { host: '127.0.0.1', port: demo ? 5173 : 5174 },
  }
})

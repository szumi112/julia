import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'

const key = () => randomBytes(32).toString('base64url')
const child = spawn('npm', ['run', 'dev:app', '--', '--host', '127.0.0.1', '--port', '5174'], {
  stdio: 'inherit',
  env: {
    APP_ENV: 'development', APP_ORIGIN: 'http://127.0.0.1:5174', DATA_MODE: 'fictional',
    BWM_DATA_KEK_V1: key(), BWM_LOOKUP_HMAC_V1: key(), BWM_BACKUP_KEK_V1: key(),
    PATH: process.env.PATH,
  },
})
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal))
child.on('exit', (code) => { process.exitCode = code ?? 1 })

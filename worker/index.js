import { createApp } from './app.js'
import { loadConfig } from './config.js'
import { processOutboxBatch } from './jobs/outbox.js'
import { dispatchOutboxJob } from './jobs/handlers.js'
import { createKeyring } from './security/keyring.js'

const app = createApp()

export default {
  fetch(request, env, ctx) {
    loadConfig(env)
    return app.fetch(request, env, ctx)
  },
  scheduled(_controller, env, ctx) {
    const config = loadConfig(env)
    ctx.waitUntil((async () => {
      const keyring = await createKeyring(env, config)
      const scope = { type: 'staff_directory', id: 'centre_1', purpose: 'identity' }
      const dataKey = await env.DB.prepare(
        'SELECT id,scope_type,scope_id,purpose,dek_version,wrapped_key_b64,wrap_nonce_b64,kek_version,created_at,retired_at FROM data_keys WHERE scope_type=? AND scope_id=? AND purpose=? AND dek_version=1'
      ).bind(scope.type, scope.id, scope.purpose).first()
      if (!dataKey) return
      await processOutboxBatch({ db: env.DB, nowMs: Date.now(), config, cryptoContext: { keyring, dataKey, scope }, dispatch: dispatchOutboxJob })
    })().catch(() => undefined))
  },
}

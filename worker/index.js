import { createApp } from './app.js'
import { loadConfig } from './config.js'

const app = createApp()

export default {
  fetch(request, env, ctx) {
    loadConfig(env)
    return app.fetch(request, env, ctx)
  },
  scheduled(_controller, env) {
    loadConfig(env)
  },
}

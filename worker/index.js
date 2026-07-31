import { createApp } from './app.js'
import { loadConfig } from './config.js'
import { runScheduled } from './operations/scheduler.js'

const app = createApp()

export default {
  fetch(request, env, ctx) {
    loadConfig(env)
    return app.fetch(request, env, ctx)
  },
  scheduled(controller, env, ctx) {
    loadConfig(env)
    ctx.waitUntil(runScheduled({
      scheduledTime: controller.scheduledTime,
      env,
    }))
  },
}

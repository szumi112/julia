import { createApp } from './app.js'
import { loadConfig } from './config.js'
import { runOutboxDrain } from './operations/outbox-drain.js'
import { runScheduled } from './operations/scheduler.js'

const OPERATIONS_CRON = '*/5 * * * *'
const OUTBOX_CRON = '* * * * *'
const app = createApp()

export default {
  fetch(request, env, ctx) {
    loadConfig(env)
    return app.fetch(request, env, ctx)
  },
  scheduled(controller, env, ctx) {
    loadConfig(env)
    const cron = controller?.cron
    if (cron !== OPERATIONS_CRON && cron !== OUTBOX_CRON) {
      throw new Error('SCHEDULED_CRON_INVALID')
    }
    const run = cron === OUTBOX_CRON ? runOutboxDrain : runScheduled
    ctx.waitUntil(run({
      scheduledTime: controller.scheduledTime,
      env,
    }))
  },
}

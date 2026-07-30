const production = process.env.APP_ENV === 'production' || process.env.BOOTSTRAP_TARGET === 'production'
if (production) {
  process.stdout.write('BOOTSTRAP_PRODUCTION_BLOCKED\n')
  process.exitCode = 1
} else if (process.env.DATA_MODE !== 'fictional' || !process.env.BOOTSTRAP_TARGET || !/^[^@\s]+@example\.test$/.test((process.env.BOOTSTRAP_OWNER_EMAIL ?? '').trim().toLowerCase())) {
  process.stdout.write('BOOTSTRAP_INPUT_INVALID\n')
  process.exitCode = 1
} else {
  process.stdout.write('BOOTSTRAP_REQUIRES_D1_REST_BATCH\n')
  process.exitCode = 1
}

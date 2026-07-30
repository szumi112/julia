if (process.env.APP_ENV !== 'development') {
  process.stdout.write('SEED_LOCAL_DEVELOPMENT_ONLY\n')
  process.exitCode = 1
} else {
  process.stdout.write('SEED_LOCAL_REQUIRES_D1\n')
}

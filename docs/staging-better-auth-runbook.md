# Staging Better Auth rollout

Apply migration stage F to staging only after a current verified backup exists. Configure the
staging secret `BETTER_AUTH_SECRET` through Wrangler secret management; never put its value in files
or command output. Run the repository checks and the guarded staging deploy.

Before cutting Cloudflare Access over, verify password and email OTP login, logout, session expiry,
first-password setup, and every application role with fictional accounts. Keep Access in front of staging
until these checks pass. Save the existing Access application and policy configuration privately,
then narrow that same staging application to `/api/v1/health/live` with only its existing service-token
policy. Retain its audience and verify the health monitor still authenticates; anonymous application
API requests must return 401 and the root URL must show the custom login.

For a normal rollback, first restore the full-origin Cloudflare Access policy, then redeploy the
previous known worker through the guarded staging deploy path. Leave the added tables and their data
in place, and preserve existing Cloudflare staff identities.

Database restore is a separate disaster-recovery procedure. The restore flow empties `auth_session`
and `auth_verification` when the restored migration set contains the Better Auth schema; older
backups remain compatible because that cleanup is skipped. Do not remove or alter production Access.

Local development uses the fictional accounts `owner@example.test`, `coordinator@example.test`, and
`specialist@example.test`, each with password `correctpassword`. The local seed hashes the password
with Better Auth before writing D1. These credentials are only for fictional local data.

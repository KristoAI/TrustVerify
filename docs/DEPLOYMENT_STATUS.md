# Cloud deployment status

Verified October 17, 2026 for the TrustVerify Supabase project `lecrhouejepvpdvrpjrb` and GitHub repository `KristoAI/TrustVerify`.

## Hosted database

The original foundation, launch-capability and revocation migrations were already present. The following missing repository migrations were applied, in order, through Supabase's migration API:

| Repository source | Hosted version | Hosted name |
| --- | --- | --- |
| `202609190001_continuation.sql` | `20261017104917` | `trustbunny_continuation` |
| `202609190002_document_reinforcement.sql` | `20261017104922` | `trustbunny_document_reinforcement` |
| `202609200001_email_experiment.sql` | `20261017104928` | `trustbunny_email_experiment` |

The API assigns deployment-time versions; filenames retain implementation dates. Do not apply these migrations again merely because the version strings differ. All six migrations are recorded in the hosted ledger. Existing user data was retained; local preview rows were not copied into the hosted database.

RLS is enabled on `tv_continuations`, `tv_email_checks`, `tv_email_budget` and `tv_email_catalog`. Both `anon` and `authenticated` lack direct SELECT/INSERT/UPDATE/DELETE privileges on these tables.

## Edge functions

- `trustverify-store`: version **3**, ACTIVE, JWT verification enabled. Source matches the repository after substituting the existing store credential hash into the deployment copy. The credential was preserved.
- `trustbunny-email`: version **1**, ACTIVE, JWT verification enabled. Both uploaded files match the repository exactly. A request without sending credentials returns HTTP 503; no real email was sent.

The email sender still requires its independent shared secret, verified SES sender, AWS region and AWS credentials. The Node email experiment flag remains disabled until configured. See [email setup](EMAIL_EXPERIMENT.md).

## GitHub and local-only state

Application code, migrations, edge source, tests, documentation, license records, and the vendor assets needed by the build are versioned on the repository's `main` branch. Historical AGPL material remains present as documented; this push does not change the project's licensing status.

Runtime secrets, `.env` variants, `.aws`, signing/encryption keys, database backups, Docker volumes, dependency installations and generated `dist` output are excluded from Git. This is a source/schema deployment, not a cloud backup of all local state. Preserve `.env`, `.local` and the local database volume when restarting Docker. A local pre-restart dump is saved under `.local/backups/`.

The Node/browser application and background worker are **not hosted by Supabase Edge Functions**. Their source is in GitHub and their container packaging is available, but a separately configured application host is still needed for public service. Restarting the local preview later still requires its Docker database.

## Checks

TypeScript, candidate packaging and the core dependency/vendor audit pass. The local regression suite reports 157 passing tests and one opt-in hosted integration test skipped. The hosted integration run is recorded below separately, so that skip is not treated as a local pass.

The post-deployment hosted integration suite passed all 11 journey/security subtests (12 test entries including the parent suite), with no skips. It covered authenticated bridge access, registration and tenant isolation, session creation/idempotency, completion and signed redirects, proof reuse, passkey cryptography, CORS and receipt binding, revocation, code exchange, outbox creation, recovery and key revocation. Synthetic fixtures were cleaned up by the suite. No SES delivery was exercised.

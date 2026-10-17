# TrustBunny operations

## What is running

The candidate application is `server/index.mjs`: Node.js, Express, ES modules and the independent browser verification application in `web/verification`. `npm run build` bundles the interface and copies hash-verified upstream face/OCR assets. Run `npm run typecheck` separately. Historical `app/` and `source/` code is retained as migration evidence and is not built or served. See [release acceptance status](REWORK_STATUS.md) before cutover.

The database is Supabase Postgres. Browser clients cannot directly access the `tv_*` tables: RLS is enabled and both `anon` and `authenticated` have no table grants. A private Supabase Edge Function bridges the Node server to its built-in service-role database client. Every bridge request requires both the public anon JWT and a separate 256-bit private server credential. The public anon key alone grants no application data access.

## Local development

1. Install Node.js 24 or later and run `npm ci`.
2. Copy `.env.example` to `.env`. Supply the project URL and anon JWT.
3. Generate independent 32-byte hex values for `TV_STORE_SECRET` and `TV_MASTER_KEY`. Treat the store secret as a privileged database credential.
4. Apply the SQL files in `supabase/migrations` in filename order.
5. Compute SHA-256 of `TV_STORE_SECRET`. Replace `__SERVER_KEY_HASH__` in a deployment copy of `supabase/functions/trustverify-store/index.ts` with that digest. Deploy as `trustverify-store` with JWT verification enabled. Do not commit the deployment copy or secret.
6. Run `npm run build`, then `npm run startDev`.
7. Open the exact `TV_ORIGIN` (default `http://localhost:3300`). Register a client account and save its recovery code.

The working environment has already been provisioned. Its `.env` and `.local` files are ignored by Git. Do not replace them with example values.

## Independent core migration

Apply `202609190001_continuation.sql` and deploy the updated private Edge bridge before switching the Node/browser runtime. The bridge includes `tv_continuations`, `tv_continuation` and `tv_bind_desktop`; it now pins `@supabase/supabase-js` 2.116.0. Validate these together in an isolated staging environment. These migrations and the updated bridge were deployed on October 17, 2026; see [the deployment record](DEPLOYMENT_STATUS.md). Avoid switching an in-flight legacy verification session to the new UI; finish or expire old sessions during the cutover window.

The isolated local preview keeps its own keys in the ignored `.local/<container>-preview-keys.json` file so restarting during development preserves test-session recovery. These are separate from the deployed application's keys.

## Signing keys and encryption

On first boot, the server generates an ES256 signing keypair in `.local/signing-keys.json`, mode 0600. Back up this file securely. All application instances must use the same stable keypair; ephemeral container disks are not sufficient. Public keys are served at `/.well-known/jwks.json`.

`TV_MASTER_KEY` encrypts webhook secrets and session launch capabilities using AES-256-GCM. Losing or replacing it makes existing ciphertext unreadable. A production key rotation requires decrypting/re-encrypting affected rows and publishing overlapping signing keys during the token transition period. Automatic key rotation is not implemented.

## Production deployment

- Serve the Node application behind HTTPS at a stable origin. Passkeys bind to this origin and its hostname; changing it may make existing credentials unusable.
- Mount a persistent private `.local` directory, and supply `.env` values through the host's secrets manager.
- Set `HTTP_SERVER_HOST=0.0.0.0` inside a container and `TV_ORIGIN=https://your-verification-domain`.
- Configure `TV_TRUST_PROXY` with only the reverse proxy's addresses or networks. Do not set blanket trust. Incorrect forwarded-IP trust can defeat geography decisions and IP rate limits.
- Keep database and store credentials server-only. The bridge has intentionally privileged access, so protect and rotate its secret like a service-role key.
- Configure access logs to omit query strings on `/v`, `/complete`, and client callback routes. Queries carry short-lived bearer capabilities. Application responses set `Referrer-Policy: no-referrer` and dynamic pages use `Cache-Control: no-store`.
- Redact cookies, authorization headers, recovery codes, and request bodies from logs/error reporting. Do not add recording analytics to capture screens.
- Set a strict CSP on client sites that allows the TrustBunny script origin and API connection. The gate uses inline styling in a shadow root, so a client CSP that disallows inline styles needs a nonce/style integration extension.
- Run `npm run startProd`. It includes a webhook/cleanup worker. `npm run worker` can run additional workers; Postgres leases coordinate delivery. A stable 15-second worker tick is needed—do not host this process on an environment that suspends background execution between requests.
- Local in-process rate limiting is suitable for this first instance. Multiple public instances need a shared limiter at the reverse proxy or in a shared store. Add monitoring and alerting before public launch.

The supplied Dockerfile uses a digest-pinned Node 24 base, packages only the independent core allowlist, and runs as a non-root user. Persist `/app/.local` with permissions for that user. The Supabase database and edge functions are deployed; the Node/browser service still requires a hosting deployment. See [deployment status](DEPLOYMENT_STATUS.md).

## Verification and limitations

`npm test` runs cryptographic, policy, privacy-shape, SSRF, webhook, independent reader/UI and retained historical regression checks. Build assets first. Continuation transaction tests additionally require `TV_CONTINUATION_DB_CONTAINER` to name a disposable local `trustbunny-*` PostgreSQL container. The live suite is opt-in:

```
TV_INTEGRATION_TEST=1 node --test tests/integration.test.mjs
```

It uses the configured real database and starts an isolated local server on port 3311. It creates synthetic business accounts, sites, age claims, and a cryptographically valid software passkey; cleanup removes those fixtures. A test assertion of age is synthetic and does not measure the face model's accuracy. Do not run this suite with production traffic or without authorization for fixture writes.

Human camera/ID testing and native platform passkey UX testing are separate acceptance checks. Browser-only results can be forged by a modified browser, and document OCR does not authenticate a document. `browser_asserted` remains explicit in result payloads. No regulatory certification is claimed.

## Delivery and revocation

Completion and its outbox event commit in one transaction. Workers claim rows with `FOR UPDATE SKIP LOCKED`, use a 90-second lease, and pin validated public DNS addresses. Redirect responses are not followed. A non-2xx response or connection failure retries with exponential backoff; attempts stop at 12 or after 24 hours. Receivers must deduplicate event IDs.

Site-level result revocation creates `verification.revoked` atomically. Forgetting saved visitor proofs revokes dependent session validity and enqueues revocation events. Previously signed JWTs cannot be erased from a recipient's server; clients must honor webhooks or consult the session API when immediate revocation matters. Dashboard changes to a policy affect current API/receipt validity checks. The original session policy is preserved as an audit snapshot.

## Retention and geography

Cleanup runs hourly: expired continuation records and tokens are removed; pending sessions become expired; keyed IP hashes are cleared after seven days; webhook events after 30 days; sessions after 90 days when their validity has ended; expired, unreferenced proofs after seven further days; audit records after 90 days. Saved proofs last at most 365 days and can be revoked earlier. Account/passkey records remain until deletion is implemented or handled operationally.

The local GeoIP database supplies coarse country/region. It is approximate and may be outdated; maintain the dataset as part of deployment. VPNs, relays, and unknown IPs affect accuracy. Every client selects its own unknown-location behavior. Geographic decisions are product policy, not a determination that a legal requirement is satisfied.

## Before a public commercial launch

Supply the operating company's identity/contact information, review service/privacy terms, complete real-device acceptance testing, choose hosting and domain, set operational monitoring/backups, and assess whether browser-only assurance is appropriate for the intended sites. Merchant email verification, billing, email recovery, shared rate limiting, automatic key rotation, and a self-service account deletion workflow are outside this first implementation.

## TrustBunny domain

The public domain is `trustbunny.com`. When deploying there, provision HTTPS and set `TV_ORIGIN=https://trustbunny.com`; retain `http://localhost:3300` for local development. The origin controls redirects, JWT issuer validation, and the passkey relying-party ID. Cookies and passkeys registered on another hostname do not transfer to this domain; users need to register their passkey on the new hostname. Update client issuer/origin configuration with the deployment.

The existing Supabase project, `trustverify-store` function, `TV_*` configuration, `tv_*` database and cookie identifiers, and WordPress plugin directory/options retain their names for compatibility. The GitHub repository name does not need to change.

## Optional email experiment

See [EMAIL_EXPERIMENT.md](EMAIL_EXPERIMENT.md) for the disabled-by-default,
10-year address-history experiment, Supabase SES edge setup, shared free-tier
budgets, data retention, and `npm run email:usage`. This test-session feature
checks inbox control and historical address appearance; it cannot issue an age proof.

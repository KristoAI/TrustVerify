# Email history and inbox experiment

This optional test-session flow checks whether an address appears in a qualifying breach at least **10 years old**, then offers to send a six-digit code to confirm current inbox access. The threshold is configurable. Neither fact establishes the current holder's age, continuous ownership, or identity. The flow therefore **does not complete an age-verification session, mint a proof, or emit an adult-age assertion**. The visitor can continue with Live AI Age Check or Document ID afterward. Production sessions cannot use this experiment. Existing method policies and QR continuation are unchanged; this experiment is available in the originating browser only.

## Flow and data

1. The visitor explicitly consents to sharing their email with XposedOrNot.
2. Node creates an encrypted, session-bound lookup job. The existing background worker polls every 15 seconds. Another worker can run with `npm run worker`; shared database claims prevent duplicate work.
3. The worker uses the public `/v1/check-email/{email}` endpoint and a database-cached `/v1/breaches` catalog. Eligibility uses the exact `breachedDate`, never the publication date or a year-only analytics field. Only verified, searchable, non-sensitive DataBreach records exposing email addresses qualify. Unknown metadata fails closed. No match means this method is unavailable, not that the person is underage.
4. When eligible, a separate visitor action requests the code. Node generates it cryptographically, stores a keyed hash for checking and a short-lived encrypted copy for dispatch, and binds the sender payload to the job.
5. The SES edge function authenticates the server, checks the precommitted payload, reserves a send budget, consumes the one-use dispatch claim, signs the fixed SESv2 request, and records the outcome.
6. A code expires within ten minutes and no later than session expiry. Five incorrect guesses lock it. Concurrent guesses share an atomic database counter. Successful verification clears the code hash. Delivery acceptance does not guarantee inbox delivery.

One address and one send are allowed per verification session. Network retries of create/send do not send more email. There is no automatic resend after an uncertain SES response; a fresh session is needed. An expired or unavailable experiment offers the existing methods.

The database stores only encrypted addresses/codes, keyed address/IP identifiers, states and timestamps. It does not retain per-address breach names or dates. Plaintext addresses are sent only to XposedOrNot and SES for their respective operations. The public metadata catalog contains no queried email addresses. Address/code ciphertext is cleared after delivery or terminal failure. Jobs expire with the session; cleanup removes job rows and budget identifiers after 24 hours. Cleanup runs while the enabled worker is running; run cleanup manually before disabling workers if immediate removal is needed. No addresses or codes appear in application logs or usage reports. Hosting/proxy logs also need redaction policies: XposedOrNot receives the address in a URL as required by its API.

## Database and edge setup

Apply `supabase/migrations/202609200001_email_experiment.sql` after earlier migrations. Deploy the updated `trustverify-store` bridge so `tv_email_action` and `tv_email_checks` are allowed. Retain its existing server-key configuration and JWT gate.

Deploy `supabase/functions/trustbunny-email` with JWT verification **enabled**. Set these secrets only on that edge function:

- `TV_EMAIL_EDGE_SECRET`: an independent cryptographically random secret, 32–256 characters, also supplied to Node.
- `TV_EMAIL_FROM`: a bare email address verified in SES.
- `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`; optional `AWS_SESSION_TOKEN` for temporary credentials (must be rotated before expiry).
- Optional `TV_EMAIL_SES_CONFIGURATION_SET` for SES delivery, bounce and complaint event monitoring.
- Supabase-provided `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are used for atomic dispatch claims.

AWS credentials must permit `ses:SendEmail` only for the selected sending identity and region. The code constructs the regional AWS SES endpoint (including the China suffix); the configured region must offer SES. Keep AWS credentials and the edge secret out of browsers. The edge has no public email relay or arbitrary message template. SES sandbox accounts restrict recipients and throughput; confirm the sender identity and regional account status before a real test.

Set Node environment values:

```
TV_EMAIL_EXPERIMENT=true
TV_EMAIL_HISTORY_YEARS=10
TV_EMAIL_EDGE_URL=https://YOUR_PROJECT.supabase.co/functions/v1/trustbunny-email
TV_EMAIL_EDGE_SECRET=<same independent secret>
```

The existing `TV_SUPABASE_ANON_KEY` provides the JWT gateway credential. Start the server normally; its worker starts automatically. Existing sessions opened before configuration changes may need a page refresh. The isolated `script/verification-preview.mjs` deliberately does not load deployment credentials or enable real email sending; use the normal configured service for live-provider test sessions.

## Budgets and operations

Limits are shared globally across workers in the database and checked over rolling windows. The worker uses its own egress IP; it never spoofs a visitor's IP. If other applications use the same IP, their API usage is outside these local counters; provider 429 responses stop this flow and introduce a one-hour cooldown.

| Operation | Requests/hour | Requests/day |
| --- | ---: | ---: |
| XposedOrNot address lookup | 25 | 100 |
| XposedOrNot public catalog | 50 | 100 |
| SES dispatch attempts | 25 | 100 |

Reservations also allow at most one request/second for each global endpoint. Public metadata is cached for 24 hours. Additional limits are five new checks/hour and twenty/day per keyed IP, and three/hour and five/day per keyed address. Quotas count reservations, including attempts that fail. Database restart, process restart, or adding a worker cannot reset them. A queue outage never produces a passing age result. Disabling `TV_EMAIL_EXPERIMENT` stops new API requests and worker sends.

Run `npm run email:usage` for aggregate rolling-day request counts and current job outcomes, without recipient data. Provider-limit increases require an explicit quota migration and any necessary paid-provider adapter/configuration; do not simply add worker IPs. No tier upgrades or purchases happen automatically. These initial quotas cap SES attempts at 100/day even if the SES account allows more.

Before production: arrange appropriate XposedOrNot commercial rights/plan; decide how a validated age-estimation model would use the signal; configure and monitor SES bounce/complaint events and account suppression; review retention/disclosures; and test deployed JWT/IAM/SES settings. There is **no** custom bounce webhook or recipient suppression ingestion in this prototype. SES account-level suppression should be enabled and monitored before real traffic. The local automated tests mock provider traffic, so they do not establish deliverability or deployed edge compatibility.

## Verification

`node --test tests/email-provider.test.mjs tests/email-ses.test.mjs tests/verification-email.test.mjs` exercises provider parsing, exact date cutoffs, SigV4 signing, edge authentication, one-use dispatch and UI behavior using synthetic inputs. Set `TV_PREVIEW_TEST_CONTAINER` to an isolated migrated `trustbunny-*` database and run `node --test tests/email-flow.test.mjs` for HTTP-to-worker-to-edge-to-SQL checks, including concurrent dispatch/OTP attempts. Never point these tests at a production database. No real emails are sent by these tests.

Primary references: [XposedOrNot API and free limits](https://xposedornot.com/api_doc), [XposedOrNot terms](https://xposedornot.com/terms), [AWS SESv2 SendEmail](https://docs.aws.amazon.com/ses/latest/APIReference-V2/API_SendEmail.html), [AWS SigV4 signing](https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_sigv-create-signed-request.html).

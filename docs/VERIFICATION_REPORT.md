# Verification report — September 18, 2026

## Passed

- `npm run build`: ESBuild bundle plus a clean TypeScript check and build of the browser verification engine.
- `npm test`: nine unit/security tests passed; the separate live suite is skipped by default.
- `TV_INTEGRATION_TEST=1 node --test tests/integration.test.mjs`: all eleven integration subtests passed (twelve reported tests including the parent suite), against the configured real Supabase project.
- Live coverage: denied anonymous bridge access; account/CSRF behavior; cross-account and cross-site isolation; idempotent concurrent session creation; safe HTML/JSON configuration; rejection of invalid capabilities and personal-data fields; one-time handoffs; signed redirects; reusable proofs without resetting original verification time; test/live separation; cryptographically valid discoverable passkey registration and second-client login; origin-bound browser receipts; geographic fallback; revocation; one-time code exchange; atomic completion and revocation outbox events; expiry; recovery-code rotation; and API-key revocation.
- Worker tests: exact-body HMAC, lease-qualified updates, retry scheduling, and terminal failures. SSRF tests cover private/reserved and mixed DNS answers.
- Dependency installation audit after compatible updates and removing the unused Twig renderer: zero reported vulnerabilities.
- `git diff --check`: passed.

## Browser walkthrough

Inspected the branded homepage and verification entry screen, registered a disposable business account, created a site through its dashboard, inspected the one-time credentials presentation, and loaded the embed on a separate local origin (`localhost:4401`).

For transport testing, a clearly test-environment **synthetic** age result was submitted without a camera or personal document. The browser consumed the completion handoff, displayed the saved pass, returned a signed result to the client, obtained its receipt, and cleared the gate. The saved-pass privacy control revoked that synthetic proof. The disposable browser account/site/session/proof records were removed with fixture-scoped cleanup.

A development-server restart briefly interrupted the client callback; reloading while its assertion remained valid completed the flow. Final page loads had no new application console errors. Earlier captured errors belonged to a stale pre-fix verification bundle.

## Not exercised here

- Native camera/ID accuracy or liveness behavior with a real person and document.
- Native OS passkey dialogs and synchronized-device UX. WebAuthn was tested with a software authenticator performing real P-256/CBOR/signature verification through the live API.
- Delivery to a real external HTTPS webhook receiver. The outbox is tested against Postgres and the worker transport/signature behavior uses an injected test receiver.
- WordPress runtime execution or PHP linting: no PHP/WordPress runtime was available. The included plugin is an embed integration, not server-side access enforcement.
- Public hosting/domain configuration, real traffic, shared rate limits, production monitoring, or regulatory suitability.

## Cleanup note

Known account, site, session, visitor, credential, and proof fixtures were deleted after integration runs. Cleanup was strengthened to include proof-access aliases in future runs. An automatic approval review rejected a broad deletion of orphaned proof-access tokens because it did not restrict the operation to known fixture IDs; those unscoped records were left untouched. An alias whose proof no longer exists cannot authenticate an age result. Normal expiry cleanup still applies.

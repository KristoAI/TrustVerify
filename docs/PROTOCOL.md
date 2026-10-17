# TrustBunny protocol v1

## Session lifecycle

`created → completed` (passed, inconclusive, or not_passed), or `created → expired`. Each launch capability is random, stored as a hash and encrypted for idempotent retry. The database locks the session when committing a result; a second submission cannot create another proof or completion event. Creation expires after 20 minutes.

Server API keys are scoped to one site and environment. Session creation requires a browser-bound random `state` and an `Idempotency-Key`. Neither a session ID nor a result-looking URL is itself proof of success.

```
POST /v1/verification-sessions
Authorization: Bearer tv_test_...
Idempotency-Key: unique-per-check

{"state":"at-least-22-random-base64url-characters","response_mode":"assertion"}
```

The registered return URL is an exact same-origin HTTPS path. Test sites may use HTTP localhost. User-supplied callback URLs, fragments, credentials, and query strings are rejected.

## Signed assertion

The callback includes `tv_result=JWT&state=...`. Validate ES256 with the published JWKS, issuer, audience (site ID), `typ=tv-result+jwt`, expiration, signed nonce, and the browser session's one-time state. It expires after two minutes. Require `outcome=passed`, expected environment, acceptable method/age threshold, and a future `valid_until`. Reject replay by consuming your local pending state. Do not log callback queries; remove them from the browser after processing.

Payload fields: `session_id`, `site_id`, `status`, `outcome`, `environment`, `age_over` (inclusive minimum age threshold), `method`, `assurance=browser_asserted`, `source=browser|reused`, `created_at`, `completed_at`, `verified_at`, `valid_until`, `nonce`, `policy_version`, and normal JWT claims. `age_over:18` means the browser reported meeting an 18-or-older threshold, not an exact age.

## One-time code

With `response_mode=code`, callback contains `tv_code`. Send `{code,state}` to `POST /v1/result-exchanges` using the site's server API key. The code is site/state-bound, expires in two minutes, and is consumed atomically. The response includes the public result and its current `valid` flag. After an uncertain network response, use the session API; do not assume that retrying an already-consumed code will succeed.

## Status and revocation

`GET /v1/verification-sessions/:id` requires the same site's key. `valid=true` requires a passed session, future session validity, an unexpired/unrevoked underlying proof, matching environment, and current method/threshold/freshness requirements. An old signed response remains cryptographically authentic after revocation; use current status or revocation notifications to enforce later changes.

## Browser SDK

`<script defer src="https://trustbunny.com/gate.js" data-site="SITE_ID"></script>`

The SDK sends no API key. Exact-origin CORS binds each browser endpoint to its registered site. A local random verifier and its SHA-256 challenge bind the returned assertion to the initiating browser tab. The signed site receipt is separate from the HttpOnly root TrustBunny proof cookie; the embed revalidates its receipt and geographic policy on each page load.

Events: `trustbunny:required`, `trustbunny:allowed` (`verified` can be false when no check is required), `trustbunny:denied`, and `trustbunny:error`. An error never silently grants access. Unknown geography follows the client's policy. The actual check uses top-level navigation so cross-site third-party-cookie availability is not required.

JavaScript cannot protect content already served. Use server enforcement for restricted responses. Treat an `allowed` event with `verified=false` as a policy exemption, never as an age-verification record.

## Webhooks

The body is `{id,type,created_at,data}`. Events: `verification.completed` and `verification.revoked`. Header: `TrustBunny-Signature: t=UNIX_SECONDS,v1=HEX_HMAC`. Calculate HMAC-SHA256 over `timestamp + '.' + rawBody`, compare in constant time, and reject timestamps more than five minutes from the current time. Deduplicate event IDs in durable storage. Return 2xx only after acceptance.

A completion event is a historical fact; a delayed completion webhook must not overwrite a later revocation. Store `valid_until` monotonically with event semantics, or query current status before changing access. Backoff/retry details are in OPERATIONS.md.

## Passes and passkeys

The TrustBunny cookie is opaque, HttpOnly, Secure on HTTPS, SameSite=Lax, and host-only. Test and live proof cookies are separate. Remembering a cookie does not refresh the proof's original `verified_at`. A site may require a much fresher result than the cookie's 365-day lifetime. Browsers may clear or cap cookies sooner; no lifetime-cookie promise is made.

Discoverable WebAuthn credentials require user verification and resident-key support. Challenge records expire after five minutes and are consumed before response verification. Origin/RP ID and the signature are verified by SimpleWebAuthn. The server stores public credential material, a random visitor ID, and a hashed recovery code; no visitor email or username is collected. Recovery codes rotate on use.

The same root proof can produce separate site-specific sessions. Root visitor and proof IDs are never disclosed to clients. TrustBunny can still correlate its own operational records, so the design is pseudonymous rather than anonymous.

## Brand compatibility

TrustBunny uses `trustbunny.com` as its public domain; substitute your configured `TV_ORIGIN` for local or self-hosted deployments. Existing `tv_*` cookies, database objects, token types, API parameters, and environment variables remain unchanged. The embed also emits the legacy `trustverify:*` events; subscribe to only one namespace to avoid handling an event twice. Webhooks send identical signatures in `TrustBunny-Signature` and the legacy `TrustVerify-Signature` header.

## Verification modes

The visitor chooses between Live AI Age Check and Document ID. `policy.methods: ["document"]` limits the site to Document ID; any policy containing `"selfie"` also permits document reinforcement, including legacy `["selfie"]` policies. Live AI automatically moves to document reading if the estimated age is below 25 (or below the required age when it is higher). This is a soft fail: no intermediate outcome is submitted. A visitor may also choose Document ID directly. Document reading never requires a selfie or portrait match. The result's `method` records the method that actually completed the check; no exact estimate or birth date is submitted.

`POST /api/demo/start` accepts `{ "mode": "selfie" }`, `{ "mode": "document" }` or `{ "mode": "selfie-document" }`. Both `selfie` and `selfie-document` enable Live AI with document reinforcement; `document` enables Document ID only. An empty object retains both paths. The demo UI exposes only the two visitor paths. This only affects the new demo session. Public merchant request/result shapes are unchanged.

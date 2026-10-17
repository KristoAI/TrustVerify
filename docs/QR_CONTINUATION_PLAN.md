# TrustBunny QR continuation plan

September 19, 2026. Owner-requested addition to the [core replacement plan](GPL_REPLACEMENT_PLAN.md). Implemented in the independent candidate. See [validation and remaining acceptance](REWORK_STATUS.md); hosted schema and Edge deployment have not been applied.

## Visitor experience

1. On the desktop verification page, choose **Continue on your phone**. Offer it at method selection and when a camera is unavailable, before recording a terminal result.
2. The desktop shows a QR code, expiry countdown and **Cancel / use this device** action.
3. Scan with the phone's normal camera. A TrustBunny page identifies the requesting website and explains that completing this check will authorize the original desktop session. Opening the link alone does not claim or complete verification; the visitor taps **Connect phone**.
4. Both screens show a matching short pairing phrase. The desktop visitor selects **Approve phone**. The phrase is a visual confirmation aid, not an authentication secret or alternative redeemable code.
5. The phone performs the permitted selfie or document check locally. Restart capture on the phone; do not transfer desktop images, OCR text or descriptors. The desktop displays **Verification in progress on your phone**.
6. Once the result is committed, the phone displays **Finished — return to your computer**. The desktop obtains its own completion handoff and continues through the existing result screen/merchant return flow. Only a passing result grants access; an inconclusive result follows the existing retry/failure behavior.

Use a freshly generated QR invitation for this session, not a QR of the existing page URL. If the invitation expires before claim, regenerate it. If the visitor returns to desktop capture, cancel the delegation and invalidate the phone's authority. A failed/expired verification session requires a new session under the existing rules; scanning cannot revive it.

## Implementation and licensing

Write the continuation UI, pairing, server state and completion delivery independently. Use a pinned, audited release of the MIT `qrcode` package for QR image generation; retain its license and required notices. The earlier audit links its [upstream license](https://github.com/soldair/node-qrcode/blob/master/license). No encoding library is installed by this plan.

Decision: use the existing MIT `qrcode` encoder to convert the continuation URL into a QR image. Custom QR encoding is outside the planned scope. Write only TrustBunny's continuation workflow independently, replacing the old GPL encoder and Go.Cam wrappers.

## Server responsibilities and boundaries

Maintain one original verification session, site, environment, required age, allowed-method policy, merchant return URL, state nonce and any browser code-challenge binding. Delegation changes which browser may report the result; it does not create an unrelated merchant session or loosen policy based on the phone's location. The desktop and phone can be on different networks.

Introduce separate authority for three purposes:

| Authority | Permitted action |
|---|---|
| Original desktop | Create/cancel invitation, approve the paired phone, read bounded status and retrieve its completion handoff |
| QR invitation | Request one phone pairing for one session; cannot submit outcomes, read completed results or authorize merchant access |
| Approved phone | Run the permitted check and report an outcome for that delegated session; cannot retrieve the desktop's merchant callback credentials or reusable desktop proof |

Keep desktop authority bound to a per-flow browser secret/session, distinct from the QR secret. Scope it per session so multiple tabs cannot silently exchange results. Bind the claimed invitation to the phone browser with a separate short-lived credential; a copied invitation must not become a second result-submission capability.

Require same-origin/CSRF protection for cookie-authorized mutations, secure HttpOnly cookies where used, and bounded creation/claim/status rate limits. The matching phrase must not replace cryptographic authorization. Continuation completion redemption must validate the originating desktop binding as well as the handoff token; merely delivering the current bearer completion URL only to desktop is insufficient to enforce that binding.

Suggested defaults: a random 256-bit invitation, stored as a hash, with a two-minute claim window capped by the original session expiry. Successful pairing has a separate short approval deadline. Approved verification may continue until the original session expires; expiration of the already-consumed QR invitation does not interrupt an approved scan. These are proposed configurable limits, not regulatory requirements.

Place the invitation secret in a URL fragment and exchange it in a same-origin POST after **Connect phone**, then clear the fragment with history replacement. Use no-store/no-referrer pages, first-party assets, and no analytics on the continuation flow. Avoid recording raw secrets or URL fragments in diagnostics. A fragment reduces incidental HTTP/referrer exposure; possession of the invitation still matters.

Use transactional state changes with states such as `offered → awaiting_approval → active → completed`, plus `cancelled` and `expired`. Reissuing an invitation revokes the old one and any unapproved claim. Do not silently replace an approved phone. At approval, revoke/suspend desktop capture authority and activate the phone's reporting authority atomically. Cancelling an active delegation invalidates the phone credential before restoring fresh desktop capture authority. Check the current delegation generation inside the final database transaction so late requests cannot finish a cancelled/replaced flow.

Phone result commit, session finalization and webhook/outbox creation must remain atomic and idempotent. A desktop completion racing with phone approval, two phone submissions, and a cancel racing with submission must have one deterministic winner. After commit, cancellation cannot undo the recorded result. Network retries must recover the committed result without creating another grant/event.

The desktop polls a dedicated authenticated status endpoint, initially around every two seconds with backoff when hidden or on errors, bounded by session expiry. Responses contain only pending/pairing/active/completed/expired/cancelled state and the minimum matching phrase/outcome metadata. Polling cannot submit a result or mint a reusable proof. A separate authenticated POST retrieves the desktop-bound completion handoff, with retry-safe issuance/redemption. No WebSocket or WebRTC infrastructure is needed for the first version.

On completion, only the original desktop receives the handoff into the merchant-return flow and its own proof-access cookie. The phone receives an acknowledgement, not the existing completion URL. Do not clone cookies, passkeys, recovery credentials or account sessions between devices, or attach the result to an unrelated visitor account already signed in on the phone. Automatic cross-device passkey/proof enrollment is outside this first version. Any future phone reuse enrollment needs an explicit user flow.

The desktop can reconnect or reload and recover status while its credential/session is valid. Its absence must not interrupt an already-approved phone scan. If desktop recovery expires, show a clear finished/expired state on the phone; do not send the original merchant state or code exchange to that different browser. Retain enough bounded continuation metadata for recovery and remove it after the documented expiry/cleanup window.

## Changes required in the existing service

- Add `web/verification/continuation.ts` and `qr.ts` plus a phone landing/state view, using the same verification engine for capture.
- Add a first-party server continuation module and a database migration for invitation hashes, device-role bindings, generation, state, expiry and atomic claim/approve/cancel/finish operations. Store no verification inputs.
- Proposed internal route responsibilities: create invitation, claim invitation, approve phone, read status, cancel delegation, submit phone outcome, and issue desktop completion. Final route names can be chosen during implementation; merchant APIs remain stable.
- Adapt the existing result authorization and finalization transaction to recognize the active device role/generation. The existing single `cap_hash` check alone is insufficient for revocable delegation.
- Add a completed-session status read: current `/api/verification/:id` calls `activeSession()`, which rejects finished sessions and cannot serve as the continuation poll endpoint unchanged.
- Separate outcome commit from delivery/visitor association in `complete()`. It currently returns a completion handoff to the submitting browser and can associate a proof with that browser's visitor cookie. Delegated phone completion must use the recorded originating context and issue the merchant completion only to the desktop.
- Keep signed redirects, callback allowlists, nonce/PKCE binding, webhook delivery, session API results, assurance `browser_asserted`, and WordPress's public integration contract unchanged.

## Acceptance checks

- Desktop-to-phone selfie and document journeys both complete; a passing result resumes the original desktop and produces the existing single durable result/outbox event.
- Invitation scanning without an explicit claim does not consume it. Expired/replaced invitations, second-device claims, unapproved phones and wrong-session credentials fail safely.
- Desktop/phone race, approval/capture race, cancellation, duplicate reports, dropped responses and late OCR/model callbacks cannot create competing outcomes or revive revoked authority.
- Polling and completion retrieval require original-desktop authority and work after the session is completed. Read-only status cannot obtain merchant tokens or proof aliases.
- Site, environment, allowed methods, age threshold and merchant state/code challenge remain bound to the original session. Cross-network use works without an IP-equality requirement.
- Phone and desktop with different signed-in accounts do not transfer or merge identities. No reusable cookie, passkey or recovery secret is copied between them.
- Phone failures, expiry, camera denial, desktop refresh/backgrounding and phone refresh have defined recovery or restart behavior. Desktop continues to have an explicit cancel action before result commit.
- Real iOS and Android camera scanning works; the QR renders accessibly with sufficient contrast/quiet zone and an announced status. Keyboard/screen-reader users can operate desktop controls; there is no public short-code lookup bypass.
- Browser network/storage inspection confirms that only pairing/status/result metadata crosses devices through the service. Recognition images, document pixels, OCR text and descriptors remain on the phone.

Pairing confirmation reduces accidental/wrong-device continuation but does not prove that the person on the phone is the person at the desktop. Preserve the existing browser-asserted assurance statement; the handoff does not make browser inference tamper-resistant or eliminate deliberate relay by cooperating users.

Deliver after the independent selfie flow works, then run the same continuation path through document verification before core cutover. QR rendering is small; pairing, concurrency, recovery and correct device-bound completion form a separate implementation work package.

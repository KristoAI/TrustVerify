import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from "@simplewebauthn/server";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import {
  assert,
  route,
  createToken,
  readToken,
  cookieOptions,
  cookieProof,
  proofCookie,
} from "./domain.mjs";
import { hash, random, isFuture, now } from "./security.mjs";
export function passkeyRoutes(app, { store, config }) {
  const visitorAuth = (req) =>
    readToken(store, req.cookies.tv_visitor, "visitor");
  const issue = async (res, id) => {
    const t = await createToken(store, "visitor", id, {}, 7 * 86400);
    res.cookie("tv_visitor", t, cookieOptions(config, 7 * 86400));
  };
  async function availableProof(req) {
    for (const env of ["live", "test"]) {
      const p = await cookieProof(store, req, env);
      if (p && !p.revoked_at && isFuture(p.expires_at)) return p;
    }
    return null;
  }
  async function challenge(req, kind) {
    const token = req.cookies.tv_challenge;
    assert(token, 401, "This passkey request expired. Start again.");
    const row = await store.rpc("tv_consume_token", {
      p_hash: hash(token),
      p_kind: kind,
    });
    assert(row, 401, "This passkey request expired or was already used.");
    return row;
  }
  app.get(
    "/api/visitor",
    route(async (req, res) => {
      const auth = await visitorAuth(req),
        proof = await availableProof(req);
      const proofs = auth
        ? await store.find(
            "tv_proofs",
            { visitor_id: auth.owner_id },
            { order: "verified_at" },
          )
        : proof
          ? [proof]
          : [];
      const credentials = auth
        ? await store.find("tv_passkeys", { visitor_id: auth.owner_id })
        : [];
      res.json({
        signed_in: !!auth,
        can_register: !!auth || !!proof,
        proofs: proofs.map((p) => ({
          environment: p.environment,
          age_over: p.min_age,
          method: p.method,
          verified_at: p.verified_at,
          expires_at: p.expires_at,
          revoked: !!p.revoked_at,
        })),
        passkeys: credentials.map((c) => ({
          id: c.id,
          name: c.name,
          created_at: c.created_at,
          last_used_at: c.last_used_at,
          backed_up: c.backed_up,
        })),
      });
    }),
  );
  app.post(
    "/api/passkeys/register/options",
    route(async (req, res) => {
      const auth = await visitorAuth(req),
        proof = await availableProof(req);
      assert(
        auth || proof,
        403,
        "Complete an age check before saving a passkey.",
      );
      assert(
        !proof?.visitor_id || auth?.owner_id === proof.visitor_id,
        403,
        "Sign in to the passkey account that owns this saved verification.",
      );
      const id = auth?.owner_id || randomUUID(),
        credentials = auth
          ? await store.find("tv_passkeys", { visitor_id: id })
          : [];
      assert(credentials.length < 10, 400, "You can save up to ten passkeys.");
      const options = await generateRegistrationOptions({
        rpName: "TrustBunny",
        rpID: config.rpID,
        userID: Buffer.from(id),
        userName: `TrustBunny ${id.slice(0, 8)}`,
        userDisplayName: "My TrustBunny pass",
        attestationType: "none",
        authenticatorSelection: {
          residentKey: "required",
          userVerification: "required",
        },
        excludeCredentials: credentials.map((c) => ({
          id: c.id,
          transports: c.transports,
        })),
      });
      const token = await createToken(
        store,
        "webauthn-register",
        id,
        {
          challenge: options.challenge,
          proof_id: proof?.id || null,
          existing: !!auth,
        },
        300,
      );
      res.cookie("tv_challenge", token, cookieOptions(config, 300));
      res.json(options);
    }),
  );
  app.post(
    "/api/passkeys/register/verify",
    route(async (req, res) => {
      const pending = await challenge(req, "webauthn-register");
      let result;
      try {
        result = await verifyRegistrationResponse({
          response: req.body,
          expectedChallenge: pending.data.challenge,
          expectedOrigin: config.origin,
          expectedRPID: config.rpID,
          requireUserVerification: true,
        });
      } catch {
        assert(
          false,
          400,
          "The passkey registration response did not verify. Start again.",
        );
      }
      assert(
        result.verified && result.registrationInfo,
        400,
        "The passkey could not be verified.",
      );
      const info = result.registrationInfo,
        code = random(24);
      if (!pending.data.existing)
        await store.insert("tv_visitors", {
          id: pending.owner_id,
          recovery_hash: hash(code),
        });
      await store.insert("tv_passkeys", {
        id: info.credential.id,
        visitor_id: pending.owner_id,
        public_key: Buffer.from(info.credential.publicKey).toString(
          "base64url",
        ),
        counter: info.credential.counter,
        transports: info.credential.transports || [],
        device_type: info.credentialDeviceType,
        backed_up: info.credentialBackedUp,
      });
      if (pending.data.proof_id) {
        const p = await store.one("tv_proofs", { id: pending.data.proof_id });
        if (p && !p.visitor_id)
          await store.update(
            "tv_proofs",
            { id: p.id, visitor_id: null },
            { visitor_id: pending.owner_id },
          );
      }
      await issue(res, pending.owner_id);
      res.clearCookie("tv_challenge", cookieOptions(config, 0));
      res.json({
        ok: true,
        recovery_code: pending.data.existing ? null : code,
      });
    }),
  );
  app.post(
    "/api/passkeys/login/options",
    route(async (req, res) => {
      const options = await generateAuthenticationOptions({
        rpID: config.rpID,
        userVerification: "required",
      });
      const token = await createToken(
        store,
        "webauthn-auth",
        null,
        { challenge: options.challenge },
        300,
      );
      res.cookie("tv_challenge", token, cookieOptions(config, 300));
      res.json(options);
    }),
  );
  app.post(
    "/api/passkeys/login/verify",
    route(async (req, res) => {
      const pending = await challenge(req, "webauthn-auth");
      const credential = await store.one("tv_passkeys", {
        id: z.string().max(2048).parse(req.body.id),
      });
      assert(credential, 401, "Passkey not recognized.");
      let result;
      try {
        result = await verifyAuthenticationResponse({
          response: req.body,
          expectedChallenge: pending.data.challenge,
          expectedOrigin: config.origin,
          expectedRPID: config.rpID,
          requireUserVerification: true,
          credential: {
            id: credential.id,
            publicKey: Buffer.from(credential.public_key, "base64url"),
            counter: Number(credential.counter),
            transports: credential.transports,
          },
        });
      } catch {
        assert(false, 401, "Passkey authentication failed. Start again.");
      }
      assert(result.verified, 401, "Passkey authentication failed.");
      const changed = await store.update(
        "tv_passkeys",
        { id: credential.id, counter: credential.counter },
        { counter: result.authenticationInfo.newCounter, last_used_at: now() },
      );
      assert(changed.length, 409, "Passkey changed during sign-in. Try again.");
      await issue(res, credential.visitor_id);
      res.clearCookie("tv_challenge", cookieOptions(config, 0));
      res.json({ ok: true });
    }),
  );
  app.post(
    "/api/visitor/recover",
    route(async (req, res) => {
      const code = z.string().min(20).max(100).parse(req.body.recovery_code);
      const v = await store.one("tv_visitors", { recovery_hash: hash(code) });
      assert(v, 401, "Recovery code not recognized.");
      const next = random(24);
      assert(
        (
          await store.update(
            "tv_visitors",
            { id: v.id, recovery_hash: hash(code) },
            { recovery_hash: hash(next) },
          )
        ).length,
        409,
        "Recovery code already used.",
      );
      await store.remove("tv_tokens", { kind: "visitor", owner_id: v.id });
      await issue(res, v.id);
      res.json({ ok: true, recovery_code: next });
    }),
  );
  app.post(
    "/api/visitor/logout",
    route(async (req, res) => {
      if (req.cookies.tv_visitor)
        await store.remove("tv_tokens", {
          hash: hash(req.cookies.tv_visitor),
          kind: "visitor",
        });
      res.clearCookie("tv_visitor", cookieOptions(config, 0));
      res.json({ ok: true });
    }),
  );
  app.post(
    "/api/visitor/forget",
    route(async (req, res) => {
      const auth = await visitorAuth(req);
      const ids = [];
      for (const env of ["live", "test"]) {
        const p = await cookieProof(store, req, env);
        if (p) ids.push(p.id);
      }
      await store.rpc("tv_forget_proofs", {
        p_visitor_id: auth?.owner_id || null,
        p_proof_ids: ids,
      });
      // Keep proof authority available for retry if the transaction fails.
      for (const env of ["live", "test"])
        res.clearCookie(proofCookie(env), cookieOptions(config, 0));
      res.json({ ok: true });
    }),
  );
  app.delete(
    "/api/visitor/passkeys/:id",
    route(async (req, res) => {
      const auth = await visitorAuth(req);
      assert(auth, 401, "Sign in with your passkey first.");
      const credentials = await store.find("tv_passkeys", {
        visitor_id: auth.owner_id,
      });
      assert(
        credentials.length > 1,
        400,
        "Add another passkey before removing your last one.",
      );
      assert(
        credentials.some((c) => c.id === req.params.id),
        404,
        "Passkey not found.",
      );
      await store.remove("tv_passkeys", {
        id: req.params.id,
        visitor_id: auth.owner_id,
      });
      res.json({ ok: true });
    }),
  );
}

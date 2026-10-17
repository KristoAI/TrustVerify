import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import express from "express";
import cookieParser from "cookie-parser";
import {
  continuationRoutes,
  desktopCookie,
  phoneCookie,
  assertDesktopHandoff,
} from "../server/continuation.mjs";
import { hash, random, seal, makeSigningKeys } from "../server/security.mjs";
import { createApp } from "../server/app.mjs";
const execute = promisify(execFile);

test("completion handoffs require the originating desktop cookie", () => {
  const id = randomUUID(),
    token = random();
  const handoff = { owner_id: id, data: { desktop_hash: hash(token) } };
  assert.throws(
    () => assertDesktopHandoff({ cookies: {} }, handoff),
    /original desktop/,
  );
  assert.throws(
    () =>
      assertDesktopHandoff({ cookies: { [phoneCookie(id)]: token } }, handoff),
    /original desktop/,
  );
  assert.doesNotThrow(() =>
    assertDesktopHandoff({ cookies: { [desktopCookie(id)]: token } }, handoff),
  );
  assert.doesNotThrow(() =>
    assertDesktopHandoff({ cookies: {} }, { data: {} }),
  );
});

test("continuation routes never expose phone completion or raw device secrets", async (t) => {
  const id = randomUUID(),
    invitation = random(),
    device = random(),
    phone = random(),
    calls = [];
  const store = {
    async one(table) {
      if (table === "tv_continuations") return { id };
      if (table === "tv_sessions")
        return {
          site_id: "site",
          policy: { methods: ["selfie"] },
          min_age: 18,
          environment: "test",
        };
      if (table === "tv_sites")
        return { enabled: true, name: "Example", branding: {} };
      return null;
    },
    async rpc(name, args) {
      calls.push({ name, ...args });
      return {
        id,
        state: args.p_action === "finish" ? "completed" : "awaiting_approval",
        outcome: "passed",
        pairing_phrase: "amber fern nest",
        expires_at: new Date(Date.now() + 100000).toISOString(),
        phone_hash: hash(phone),
        desktop_hash: hash(random()),
      };
    },
  };
  const app = express();
  app.use(express.json(), cookieParser());
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  t.after(() => server.close());
  const origin = `http://127.0.0.1:${server.address().port}`;
  continuationRoutes(app, {
    store,
    config: { origin, secure: false, masterKey: "a".repeat(64) },
  });
  app.use((error, req, res, next) =>
    res.status(error.status || 400).json({ error: error.message }),
  );
  async function post(path, body, headers = {}) {
    return fetch(origin + path, {
      method: "POST",
      headers: {
        Origin: origin,
        "Content-Type": "application/json",
        ...headers,
      },
      body: JSON.stringify(body),
    });
  }
  const headers = { Cookie: `tv_pairing_device=${device}` };
  const claimed = await post(
    "/api/continuation/claim",
    { invitation },
    headers,
  );
  assert.equal(claimed.status, 200);
  const data = await claimed.json();
  assert.equal(data.id, id);
  assert.equal(data.requiredAge, 18);
  assert.deepEqual(data.methods, ["selfie", "document"]);
  assert.equal(data.phone_hash, undefined);
  assert.equal(data.desktop_hash, undefined);
  assert.match(claimed.headers.get("set-cookie"), /HttpOnly/);
  assert.equal(calls[0].p_args.invitation_hash, hash(invitation));
  assert.equal(JSON.stringify(calls).includes(invitation), false);
  // Simulate dropping the entire initial response, including its phone cookie.
  // Only the cookie established by the landing page remains on retry.
  const retried = await post(
    "/api/continuation/claim",
    { invitation },
    headers,
  );
  assert.equal(retried.status, 200);
  assert.equal(calls[1].p_args.phone_hash, calls[0].p_args.phone_hash);
  assert.equal(
    retried.headers.get("set-cookie"),
    claimed.headers.get("set-cookie"),
  );
  await post("/api/continuation/claim", { invitation: random() }, headers);
  assert.notEqual(calls[2].p_args.phone_hash, calls[0].p_args.phone_hash);
  await post(
    "/api/continuation/claim",
    { invitation },
    { Cookie: `tv_pairing_device=${random()}` },
  );
  assert.notEqual(calls[3].p_args.phone_hash, calls[0].p_args.phone_hash);
  assert.equal(
    (await post("/api/continuation/claim", { invitation })).status,
    401,
  );
  const done = await post(
    `/api/continuation/${id}/finish`,
    { outcome: "success", method: "selfie" },
    { Cookie: `${phoneCookie(id)}=${phone}` },
  );
  assert.deepEqual(await done.json(), {
    state: "completed",
    outcome: "passed",
  });
  assert.equal(done.headers.get("set-cookie"), null);
  assert.equal(calls.at(-1).p_args.phone_hash, hash(phone));
  const desktop = random();
  assert.equal(
    (await post(`/api/continuation/${id}/invite`, { launch: random() })).status,
    401,
  );
  const desktopHeaders = { Cookie: `${desktopCookie(id)}=${desktop}` };
  await post(
    `/api/continuation/${id}/invite`,
    { launch: random() },
    desktopHeaders,
  );
  const firstInvite = calls.at(-1);
  // Regeneration after a lost invite response retains browser ownership.
  await post(
    `/api/continuation/${id}/invite`,
    { launch: random() },
    desktopHeaders,
  );
  assert.equal(
    calls.at(-1).p_args.desktop_hash,
    firstInvite.p_args.desktop_hash,
  );
  assert.notEqual(
    calls.at(-1).p_args.invitation_hash,
    firstInvite.p_args.invitation_hash,
  );
  assert.equal(
    (
      await post(
        `/api/continuation/${id}/approve`,
        {},
        { Origin: "https://wrong.example" },
      )
    ).status,
    403,
  );
});

// Explicit opt-in local database test; never connects to deployment credentials.
// Start an isolated postgres container and apply migrations first, then set this
// variable to its name. No production database URLs are read by these tests.
const container = process.env.TV_CONTINUATION_DB_CONTAINER;
test(
  "PostgreSQL continuation lifecycle, atomic races, policy and device boundaries",
  { skip: !container },
  async (t) => {
    assert.match(container, /^trustbunny-[a-z0-9-]+$/);
    const literal = (v) => `'${String(v).replaceAll("'", "''")}'`;
    async function sql(statement) {
      const { stdout } = await execute("docker", [
        "exec",
        container,
        "psql",
        "-U",
        "postgres",
        "-At",
        "-v",
        "ON_ERROR_STOP=1",
        "-c",
        statement,
      ]);
      return stdout.trim().split("\n")[0];
    }
    const site = randomUUID();
    await sql(
      `insert into tv_sites(id,name,origin,return_url,environment,policy,webhook_url) values('${site}','Test','https://test.example','https://test.example/callback','test','{"methods":["selfie","document"],"maxAgeHours":24}','https://test.example/hook')`,
    );
    t.after(() => sql(`delete from tv_sites where id='${site}'`));
    async function fixture(methods = ["selfie", "document"]) {
      const id = randomUUID(),
        cap_token = random(),
        desktop_token = random(),
        cap_hash = hash(cap_token),
        desktop_hash = hash(desktop_token),
        phone_hash = hash(random()),
        invitation_hash = hash(random());
      await sql(
        `insert into tv_sessions(id,site_id,environment,min_age,policy,cap_hash,state_nonce,return_url,expires_at) values('${id}','${site}','test',18,${literal(JSON.stringify({ methods, maxAgeHours: 24 }))},'${cap_hash}','test-state','https://test.example/callback',now()+interval '20 minutes')`,
      );
      const args = {
        id,
        cap_hash,
        desktop_hash,
        phone_hash,
        invitation_hash,
        pairing_phrase: "amber fern nest",
      };
      await sql(
        `select tv_bind_desktop('${id}','${cap_hash}','${desktop_hash}')`,
      );
      const rpc = async (action, extra = {}) =>
        JSON.parse(
          await sql(
            `select tv_continuation(${literal(action)},${literal(JSON.stringify({ ...args, ...extra }))}::jsonb)`,
          ),
        );
      const direct = (method = "selfie") =>
        sql(
          `select tv_finish_session('${id}','${cap_hash}','passed',${literal(method)},null,'${hash(random())}')`,
        );
      await rpc("invite");
      return { args, id, rpc, direct, cap_token, desktop_token };
    }
    const legacyDirect = await fixture(["selfie"]);
    assert.equal(JSON.parse(await legacyDirect.direct("document")).method, "document");
    assert.deepEqual(JSON.parse(await sql(`select policy->'methods' from tv_sessions where id='${legacyDirect.id}'`)), ["selfie"]);
    const legacyPhone = await fixture(["selfie"]);
    await legacyPhone.rpc("claim");
    await legacyPhone.rpc("approve");
    assert.equal((await legacyPhone.rpc("finish", {
      outcome: "passed", method: "document", proof_token_hash: hash(random()),
    })).state, "completed");
    assert.deepEqual(JSON.parse(await sql(`select policy->'methods' from tv_sessions where id='${legacyPhone.id}'`)), ["selfie"]);
    const documentOnly = await fixture(["document"]);
    await assert.rejects(documentOnly.direct("selfie"), /Method not permitted/);
    assert.equal(JSON.parse(await documentOnly.direct("document")).method, "document");
    const a = await fixture();
    await assert.rejects(
      a.rpc("status", {
        desktop_hash: hash("wrong"),
        phone_hash: hash("wrong"),
      }),
    );
    await assert.rejects(
      a.rpc("finish", {
        outcome: "passed",
        method: "selfie",
        proof_token_hash: hash(random()),
      }),
    );
    assert.equal((await a.rpc("claim")).state, "awaiting_approval");
    await assert.rejects(a.rpc("claim", { phone_hash: hash("other") }));
    assert.equal((await a.rpc("claim")).state, "awaiting_approval");
    await assert.rejects(a.rpc("approve", { desktop_hash: hash("wrong") }));
    assert.equal((await a.rpc("approve")).state, "active");
    await assert.rejects(a.direct());
    await assert.rejects(a.rpc("invite"));
    await assert.rejects(
      a.rpc("finish", {
        outcome: "passed",
        method: "unsupported",
        proof_token_hash: hash(random()),
      }),
    );
    await sql(
      `update tv_continuations set invitation_expires_at=now()-interval '1 minute' where id='${a.id}'`,
    );
    const results = await Promise.all([
      a.rpc("finish", {
        outcome: "passed",
        method: "selfie",
        proof_token_hash: hash(random()),
      }),
      a.rpc("finish", {
        outcome: "passed",
        method: "selfie",
        proof_token_hash: hash(random()),
      }),
    ]);
    assert.equal(
      results.every((r) => r.state === "completed"),
      true,
    );
    assert.equal(
      await sql(`select count(*) from tv_webhooks where session_id='${a.id}'`),
      "1",
    );
    assert.equal((await a.rpc("status")).state, "completed");
    await assert.rejects(
      a.rpc("finish", { outcome: "inconclusive", method: "selfie" }),
    );
    await assert.rejects(a.rpc("complete", { desktop_hash: hash("wrong") }));
    const handoff = {
      handoff_hash: hash(random()),
      handoff_cipher: "opaque-encrypted-token",
    };
    assert.equal(
      (await a.rpc("complete", handoff)).handoff_hash,
      handoff.handoff_hash,
    );
    assert.equal(
      (
        await a.rpc("complete", {
          handoff_hash: hash(random()),
          handoff_cipher: "new-token",
        })
      ).handoff_hash,
      handoff.handoff_hash,
    );
    assert.equal(
      JSON.parse(
        await sql(
          `select data from tv_tokens where hash='${handoff.handoff_hash}'`,
        ),
      ).desktop_hash,
      a.args.desktop_hash,
    );
    await assert.rejects(
      a.rpc("cancel", { cap_hash: hash(random()), launch_cipher: "cipher" }),
    );
    const b = await fixture();
    await b.rpc("claim");
    await b.rpc("approve");
    await b.rpc("cancel", {
      cap_hash: hash(random()),
      launch_cipher: "cipher",
    });
    await assert.rejects(
      b.rpc("finish", {
        outcome: "passed",
        method: "selfie",
        proof_token_hash: hash(random()),
      }),
    );
    await assert.rejects(b.direct());
    const c = await fixture();
    await c.rpc("claim");
    const race = await Promise.allSettled([c.rpc("approve"), c.direct()]);
    assert.equal(race.filter((r) => r.status === "fulfilled").length, 1);
    const d = await fixture();
    await d.rpc("claim");
    await d.rpc("approve");
    const cancelRace = await Promise.allSettled([
      d.rpc("cancel", { cap_hash: hash(random()), launch_cipher: "cipher" }),
      d.rpc("finish", {
        outcome: "passed",
        method: "document",
        proof_token_hash: hash(random()),
      }),
    ]);
    assert.equal(cancelRace.filter((r) => r.status === "fulfilled").length, 1);
    const e = await fixture();
    await sql(
      `update tv_continuations set invitation_expires_at=now()-interval '1 minute' where id='${e.id}'`,
    );
    await assert.rejects(e.rpc("claim"));
    assert.equal((await e.rpc("status")).state, "expired");
    const f = await fixture();
    await f.rpc("claim");
    const newInvitation = hash(random());
    await f.rpc("invite", { invitation_hash: newInvitation });
    await assert.rejects(f.rpc("claim"));
    const nextPhone = hash(random());
    await f.rpc("claim", {
      invitation_hash: newInvitation,
      phone_hash: nextPhone,
    });
    await f.rpc("approve");
    await assert.rejects(
      f.rpc("finish", {
        outcome: "passed",
        method: "selfie",
        proof_token_hash: hash(random()),
      }),
    );
    await f.rpc("finish", {
      phone_hash: nextPhone,
      outcome: "inconclusive",
      method: "document",
      proof_token_hash: hash(random()),
    });
    assert.equal(
      await sql(
        `select count(*) from tv_proofs where id=(select proof_id from tv_sessions where id='${f.id}')`,
      ),
      "0",
    );
    assert.equal(
      await sql(
        "select has_function_privilege('anon','public.tv_finish_session_core(uuid,text,text,text,uuid,text)','EXECUTE')",
      ),
      "f",
    );
    assert.equal(
      await sql(
        "select has_function_privilege('authenticated','public.tv_continuation(text,jsonb)','EXECUTE')",
      ),
      "f",
    );
    await sql(
      `update tv_continuations set expires_at=now()-interval '1 minute' where id='${a.id}'`,
    );
    await assert.rejects(a.rpc("status"));
    await sql("select tv_cleanup()");
    assert.equal(
      await sql(`select count(*) from tv_continuations where id='${a.id}'`),
      "0",
    );
    assert.equal(
      await sql(`select status from tv_sessions where id='${a.id}'`),
      "completed",
    );

    // Exercise the real Express app against local PostgreSQL, including a
    // deliberately failed handoff write AFTER the result transaction commits.
    const recovery = await fixture();
    const masterKey = "b".repeat(64);
    await sql(
      `update tv_sessions set launch_cipher=${literal(seal(recovery.cap_token, masterKey))} where id='${recovery.id}'`,
    );
    const value = (v) =>
      v === null
        ? "null"
        : typeof v === "object"
          ? `${literal(JSON.stringify(v))}::jsonb`
          : literal(v);
    const filters = (where) =>
      Object.entries(where)
        .map(([k, v]) => `${k} is not distinct from ${value(v)}`)
        .join(" and ") || "true";
    let failHandoff = true;
    const store = {
      async one(table, where) {
        return JSON.parse(
          await sql(
            `select coalesce((select to_jsonb(r) from ${table} r where ${filters(where)} limit 1),'null'::jsonb)`,
          ),
        );
      },
      async find(table, where) {
        return JSON.parse(
          await sql(
            `select coalesce(jsonb_agg(r),'[]'::jsonb) from ${table} r where ${filters(where)}`,
          ),
        );
      },
      async insert(table, row) {
        if (
          table === "tv_tokens" &&
          row.kind === "completion-handoff" &&
          failHandoff
        ) {
          failHandoff = false;
          throw new Error("Simulated lost handoff write after commit");
        }
        return JSON.parse(
          await sql(
            `with r as (insert into ${table}(${Object.keys(row).join(",")}) values(${Object.values(row).map(value).join(",")}) returning *) select to_jsonb(r) from r`,
          ),
        );
      },
      async update(table, where, row) {
        return sql(
          `update ${table} set ${Object.entries(row)
            .map(([k, v]) => `${k}=${value(v)}`)
            .join(",")} where ${filters(where)}`,
        );
      },
      async rpc(name, args) {
        try {
          return JSON.parse(
            await sql(
              `select ${name}(${Object.entries(args)
                .map(([k, v]) => `${k}=>${value(v)}`)
                .join(",")})`,
            ),
          );
        } catch (error) {
          error.code = "P0001";
          throw error;
        }
      },
    };
    const config = {
      origin: "http://127.0.0.1:0",
      secure: false,
      masterKey,
      keys: await makeSigningKeys(),
      trustProxy: false,
    };
    const app = await createApp({ store, config, geo: () => null });
    const server = app.listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    t.after(() => server.close());
    config.origin = `http://127.0.0.1:${server.address().port}`;
    const cookie = `${desktopCookie(recovery.id)}=${recovery.desktop_token}; tv_flow=${randomUUID()}.${random()}`;
    const request = (path, body, browserCookie = cookie) =>
      fetch(config.origin + path, {
        method: body ? "POST" : "GET",
        redirect: "manual",
        headers: {
          Cookie: browserCookie,
          Origin: config.origin,
          "Content-Type": "application/json",
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    const body = {
      sessionId: recovery.id,
      token: recovery.cap_token,
      stepId: 3,
    };
    assert.equal((await request(`/v/${recovery.id}?check=1`)).status, 200);
    assert.equal((await request("/result/success", body)).status, 500);
    assert.equal(
      await sql(`select status from tv_sessions where id='${recovery.id}'`),
      "completed",
    );
    const retry = await request("/result/success", body);
    assert.equal(retry.status, 200);
    const retryBody = await retry.json();
    assert.equal(
      await sql(
        `select count(*) from tv_webhooks where session_id='${recovery.id}'`,
      ),
      "1",
    );
    assert.equal((await request("/result/fail", body)).status, 409);
    assert.equal(
      (await request("/result/success", { ...body, token: random() })).status,
      401,
    );
    assert.equal((await request("/result/success", body, "")).status, 410);
    assert.equal(
      (
        await request(
          new URL(retryBody.content.completionUrl).pathname +
            new URL(retryBody.content.completionUrl).search,
          undefined,
          "",
        )
      ).status,
      401,
    );
    const reload = await request(`/v/${recovery.id}?check=1`);
    assert.equal(reload.status, 200);
    assert.match(await reload.text(), new RegExp(recovery.cap_token));
    assert.equal(
      (await request(`/api/verification/${recovery.id}/recover`, {})).status,
      200,
    );
    await sql(
      `update tv_sessions set expires_at=now()-interval '11 minutes' where id='${recovery.id}'`,
    );
    assert.equal(
      (await request(`/api/verification/${recovery.id}/recover`, {})).status,
      410,
    );

    const rotated = await fixture();
    const freshCap = random();
    await rotated.rpc("cancel", {
      cap_hash: hash(freshCap),
      launch_cipher: seal(freshCap, masterKey),
    });
    const rotatedCookie = `${desktopCookie(rotated.id)}=${rotated.desktop_token}; tv_flow=${recovery.id}.${recovery.cap_token}`;
    const rotatedReload = await request(
      `/v/${rotated.id}?check=1`,
      undefined,
      rotatedCookie,
    );
    assert.equal(rotatedReload.status, 200);
    assert.match(await rotatedReload.text(), new RegExp(freshCap));
  },
);

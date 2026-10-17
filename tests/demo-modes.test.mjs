import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createApp } from "../server/app.mjs";
import { after, hash, makeSigningKeys } from "../server/security.mjs";

test("demo paths normalize Live AI reinforcement without changing the shared site", async (t) => {
  const tables = new Map();
  const rows = (table) => {
    if (!tables.has(table)) tables.set(table, []);
    return tables.get(table);
  };
  const matches = (row, where) =>
    Object.entries(where).every(([key, value]) => row[key] === value);
  const store = {
    async one(table, where) {
      return structuredClone(
        rows(table).find((row) => matches(row, where)) || null,
      );
    },
    async find(table, where) {
      return structuredClone(rows(table).filter((row) => matches(row, where)));
    },
    async insert(table, input) {
      const row = {
        id: randomUUID(),
        ...(table === "tv_sites" ? { enabled: true } : {}),
        ...(table === "tv_sessions" ? { status: "created" } : {}),
        ...structuredClone(input),
      };
      rows(table).push(row);
      return structuredClone(row);
    },
    async rpc(name, args) {
      assert.equal(name, "tv_bind_desktop");
      const row = rows("tv_sessions").find((s) => s.id === args.p_id);
      assert.equal(row.cap_hash, args.p_cap_hash);
      row.desktop_hash = args.p_desktop_hash;
      return structuredClone(row);
    },
  };
  const config = {
    origin: "http://127.0.0.1:0",
    secure: false,
    trustProxy: false,
    masterKey: "c".repeat(64),
    keys: await makeSigningKeys(),
  };
  const app = await createApp({ store, config, geo: () => null });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => server.close());
  config.origin = `http://127.0.0.1:${server.address().port}`;
  const post = (body) =>
    fetch(config.origin + "/api/demo/start", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: config.origin },
      body: JSON.stringify(body),
    });

  for (const invalid of [
    { mode: "all" },
    { mode: "__proto__" },
    { mode: ["selfie"] },
    { mode: "document", minAge: 10 },
    { methods: ["document"] },
  ])
    assert.equal((await post(invalid)).status, 400);
  assert.equal(rows("tv_sessions").length, 0);

  // Seed one shared demo site via the backwards-compatible empty request.
  const defaultResponse = await post({});
  assert.equal(defaultResponse.status, 200);
  const defaultLaunch = await defaultResponse.json();
  assert.deepEqual(rows("tv_sessions")[0].policy.methods, [
    "selfie",
    "document",
  ]);
  const sharedBefore = structuredClone(rows("tv_sites")[0]);
  const modes = ["selfie", "document", "selfie-document"];
  const launches = await Promise.all(
    modes.map(async (mode) => {
      const response = await post({ mode });
      assert.equal(response.status, 200);
      return response.json();
    }),
  );
  assert.equal(rows("tv_sites").length, 1);
  assert.deepEqual(rows("tv_sites")[0], sharedBefore);
  assert.equal(new Set(launches.map((launch) => launch.session_id)).size, 3);
  for (let i = 0; i < modes.length; i++) {
    const expected =
      modes[i] === "document" ? ["document"] : ["selfie", "document"];
    const session = rows("tv_sessions").find(
      (s) => s.id === launches[i].session_id,
    );
    assert.equal(session.site_id, sharedBefore.id);
    assert.deepEqual(session.policy.methods, expected);
    const check = await fetch(launches[i].verification_url + "&check=1");
    assert.equal(check.status, 200);
    const html = await check.text();
    const pageConfig = JSON.parse(
      html.match(
        /<script\b[^>]*id="verification-config"[^>]*>([\s\S]*?)<\/script>/,
      )[1],
    );
    assert.deepEqual(pageConfig.methods, expected);
    assert.equal(pageConfig.initialMethod, undefined);
    const cookies = check.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
    for (const method of ["selfie", "document", "unsupported"]) {
      const chosen = await fetch(launches[i].verification_url + `&check=1&method=${method}`, {
        headers: { Cookie: cookies },
      });
      assert.equal(chosen.status, 200);
      const selected = JSON.parse((await chosen.text()).match(
        /<script\b[^>]*id="verification-config"[^>]*>([\s\S]*?)<\/script>/,
      )[1]);
      assert.equal(selected.initialMethod, expected.includes(method) ? method : undefined);
    }
  }
  assert.deepEqual(
    rows("tv_sessions").find((s) => s.id === defaultLaunch.session_id).policy
      .methods,
    ["selfie", "document"],
  );

  await store.insert("tv_proofs", {
    token_hash: hash("test-document-proof"),
    method: "document",
    min_age: 18,
    environment: "test",
    expires_at: after(3600),
    verified_at: after(-60),
  });
  for (let i = 0; i < modes.length; i++) {
    const cap = new URL(launches[i].verification_url).searchParams.get(
      "launch",
    );
    const response = await fetch(
      `${config.origin}/api/verification/${launches[i].session_id}`,
      {
        headers: {
          "X-TV-Launch": cap,
          Cookie: "tv_proof_test=test-document-proof",
        },
      },
    );
    assert.equal(response.status, 200);
    const info = await response.json();
    assert.equal(info.reusable, true);
    assert.deepEqual(info.methods, modes[i] === "document" ? ["document"] : ["selfie", "document"]);
  }
  // Existing session snapshots remain untouched while their public flow and
  // reusable document proof acquire the same reinforcement behavior.
  const legacy = rows("tv_sessions").find((s) => s.id === defaultLaunch.session_id);
  legacy.policy.methods = ["selfie"];
  const legacyBefore = structuredClone(legacy.policy);
  const legacyResponse = await fetch(`${config.origin}/api/verification/${legacy.id}`, {
    headers: {
      "X-TV-Launch": new URL(defaultLaunch.verification_url).searchParams.get("launch"),
      Cookie: "tv_proof_test=test-document-proof",
    },
  });
  assert.equal(legacyResponse.status, 200);
  const legacyInfo = await legacyResponse.json();
  assert.deepEqual(legacyInfo.methods, ["selfie", "document"]);
  assert.equal(legacyInfo.reusable, true);
  const legacyCheck = await fetch(defaultLaunch.verification_url + "&check=1&method=document");
  assert.equal(legacyCheck.status, 200);
  const legacyConfig = JSON.parse((await legacyCheck.text()).match(
    /<script\b[^>]*id="verification-config"[^>]*>([\s\S]*?)<\/script>/,
  )[1]);
  assert.deepEqual(legacyConfig.methods, ["selfie", "document"]);
  assert.equal(legacyConfig.initialMethod, "document");
  assert.deepEqual(legacy.policy, legacyBefore);
});

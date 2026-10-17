import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../server/app.mjs";
import { makeSigningKeys } from "../server/security.mjs";

test("core serves only independent assets and establishes phone binding before claim", async (t) => {
  const app = await createApp({
    store: { one: async () => null },
    config: { origin: "http://127.0.0.1", secure: false, keys: await makeSigningKeys(), masterKey: "a".repeat(64), trustProxy: false },
    geo: () => null,
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  t.after(() => server.close());
  const origin = `http://127.0.0.1:${server.address().port}`;
  const phone = await fetch(`${origin}/continue-phone`);
  assert.equal(phone.status, 200);
  assert.match(phone.headers.get("set-cookie"), /tv_pairing_device=.*HttpOnly/);
  assert.match(phone.headers.get("cache-control"), /no-store/);
  const html = await phone.text();
  assert.match(html, /\/assets\/verification\.js/);
  assert.doesNotMatch(html, /AvsFactory|AvsToken|\/static\//);
  const script = await fetch(`${origin}/assets/verification.js`);
  assert.equal(script.status, 200, "Build the independent assets before the runtime test");
  assert.doesNotMatch(await script.text(), /AvsFactory|AvsToken|\/static\//);
  assert.equal((await fetch(`${origin}/assets/licenses/THIRD_PARTY_NOTICES.txt`)).status, 200);
  for (const resource of ["/static/js/app/avs.js", "/static/js/vendor/qr-code/v1ncc/qr.min.js", "/assets/check.css", "/preview/fixtures"]) {
    assert.equal((await fetch(origin + resource)).status, 404, resource);
  }
});

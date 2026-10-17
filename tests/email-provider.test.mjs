import test from "node:test";
import assert from "node:assert/strict";
import {
  EmailProviderError,
  fetchBreachCatalog,
  checkEmailHistory,
  eligibleHistory,
} from "../server/email-provider.mjs";

const incident = (overrides = {}) => ({
  breachID: "SyntheticIncident",
  breachedDate: "2010-04-01T00:00:00+00:00",
  addedDate: "2026-01-01T00:00:00+00:00",
  verified: true,
  searchable: true,
  sensitive: false,
  breachType: "DataBreach",
  exposedData: ["Email addresses"],
  ...overrides,
});
const catalog = [
  { id: "SyntheticIncident", date: "2010-04-01T00:00:00+00:00" },
];
const now = () => new Date("2026-09-20T00:00:00Z");
const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
const matched = () =>
  json({ status: "success", breaches: [["SyntheticIncident"]] });
const fails = (code) => (error) => {
  assert.ok(error instanceof EmailProviderError);
  assert.equal(error.code, code);
  assert.equal(error.cause, undefined);
  assert.equal(error.message.includes("example.com"), false);
  return true;
};

test("catalog retains incident date and only minimum public metadata", async () => {
  const result = await fetchBreachCatalog({
    fetchImpl: async (url, options) => {
      assert.equal(url, "https://api.xposedornot.com/v1/breaches");
      assert.equal(options.redirect, "error");
      assert.equal(options.method, "GET");
      assert.ok(options.signal instanceof AbortSignal);
      return json({ exposedBreaches: [incident()] });
    },
  });
  assert.deepEqual(result, catalog);
});

test("catalog excludes unverified, missing-type, sensitive and non-incident data", async () => {
  const variants = [
    { verified: false },
    { verified: "true" },
    { searchable: false },
    { sensitive: true },
    { breachType: undefined },
    { breachType: "ComboList" },
    { breachType: "Scrape" },
    { breachType: "StealerLogs" },
    { exposedData: ["Usernames"] },
    { breachedDate: "2010" },
    { breachedDate: "2010-02-30T00:00:00Z" },
    { breachedDate: "2010-01-01T25:00:00Z" },
    { breachedDate: "2010-01-01T00:00:00+25:00" },
  ].map((row, index) => incident({ breachID: "Synthetic" + index, ...row }));
  assert.deepEqual(
    await fetchBreachCatalog({
      fetchImpl: async () =>
        json({
          exposedBreaches: variants,
        }),
    }),
    [],
  );
});

test("malformed catalog and duplicate identifiers fail closed", async () => {
  for (const payload of [
    {},
    { exposedBreaches: [null] },
    { exposedBreaches: [incident(), incident()] },
  ]) {
    await assert.rejects(
      fetchBreachCatalog({ fetchImpl: async () => json(payload) }),
      fails("invalid_response"),
    );
  }
});

test("lookup encodes the whole address into one fixed-host path segment", async () => {
  const result = await checkEmailHistory(
    "name+tag/extra@example.com",
    catalog,
    13,
    {
      now,
      fetchImpl: async (url, options) => {
        assert.equal(
          url,
          "https://api.xposedornot.com/v1/check-email/name%2Btag%2Fextra%40example.com",
        );
        assert.equal(options.redirect, "error");
        return matched();
      },
    },
  );
  assert.equal(result, true);
});

test("only documented not-found payload is an ordinary negative result", async () => {
  for (const status of [200, 404]) {
    assert.equal(
      await checkEmailHistory("test@example.com", catalog, 13, {
        now,
        fetchImpl: async () =>
          json({ Error: "Not found", email: null }, status),
      }),
      false,
    );
  }
  for (const payload of [
    {},
    { Error: "Not found" },
    { error: "Not found" },
    { Error: "Internal error", email: null },
  ]) {
    await assert.rejects(
      checkEmailHistory("test@example.com", catalog, 13, {
        now,
        fetchImpl: async () => json(payload, 404),
      }),
      fails("invalid_response"),
    );
  }
});

test("unexpected lookup schemas are errors rather than no-history results", async () => {
  for (const payload of [
    {},
    { breaches: [["SyntheticIncident"]] },
    { status: "success", breaches: ["SyntheticIncident"] },
    { status: "success", breaches: [[{}]] },
    { status: "success", breaches: [["SyntheticIncident"], ["another"]] },
  ]) {
    await assert.rejects(
      checkEmailHistory("test@example.com", catalog, 13, {
        now,
        fetchImpl: async () => json(payload),
      }),
      fails("invalid_response"),
    );
  }
});

test("lookup misses and unknown incidents cannot satisfy history", async () => {
  for (const ids of [[], ["UnknownIncident"]]) {
    assert.equal(
      await checkEmailHistory("test@example.com", catalog, 13, {
        now,
        fetchImpl: async () => json({ status: "success", breaches: [ids] }),
      }),
      false,
    );
  }
});

test("cutoff uses the full incident timestamp, not addedDate or a year estimate", () => {
  const rows = [
    { id: "x", date: "2013-09-20T12:00:00Z", addedDate: "2000-01-01" },
  ];
  assert.equal(eligibleHistory(["x"], rows, 13, "2026-09-20T11:59:59Z"), false);
  assert.equal(eligibleHistory(["x"], rows, 13, "2026-09-20T12:00:00Z"), true);
  assert.equal(
    eligibleHistory(["x"], [{ id: "x", date: "2027-01-01" }], 1, now()),
    false,
  );
  assert.equal(
    eligibleHistory(["x"], [{ id: "x", date: "2013" }], 13, now()),
    false,
  );
});

test("leap-day history reaches anniversary conservatively on March 1", () => {
  const rows = [{ id: "x", date: "2012-02-29T00:00:00Z" }];
  assert.equal(eligibleHistory(["x"], rows, 13, "2025-02-28T23:59:59Z"), false);
  assert.equal(eligibleHistory(["x"], rows, 13, "2025-03-01T00:00:00Z"), true);
});

test("invalid history settings cannot accidentally pass", () => {
  for (const years of [0, -1, NaN, Infinity, 1.5, "13", 101])
    assert.throws(
      () => eligibleHistory(["SyntheticIncident"], catalog, years, now()),
      TypeError,
    );
  assert.throws(() => eligibleHistory([], catalog, 13, "invalid"), TypeError);
});

test("rate limiting is surfaced with bounded retry delay and no automatic retry", async () => {
  let calls = 0;
  await assert.rejects(
    checkEmailHistory("test@example.com", catalog, 13, {
      now,
      fetchImpl: async () => {
        calls++;
        return json({}, 429, { "retry-after": "999999" });
      },
    }),
    (error) => {
      fails("rate_limited")(error);
      assert.equal(error.retryAfterSeconds, 86400);
      return true;
    },
  );
  assert.equal(calls, 1);
});

test("transport errors do not expose the email URL or provider bodies", async () => {
  await assert.rejects(
    checkEmailHistory("test@example.com", catalog, 13, {
      now,
      fetchImpl: async () => {
        throw new Error("https://example.com/test@example.com");
      },
    }),
    fails("unavailable"),
  );
  for (const status of [302, 403, 500]) {
    await assert.rejects(
      checkEmailHistory("test@example.com", catalog, 13, {
        now,
        fetchImpl: async () => json({ email: "test@example.com" }, status),
      }),
      fails("unavailable"),
    );
  }
});

test("non-JSON, malformed JSON and oversized streamed responses are rejected", async () => {
  const responses = [
    new Response("<html>test@example.com</html>", {
      headers: { "content-type": "text/html" },
    }),
    new Response("invalid test@example.com", {
      headers: { "content-type": "application/json" },
    }),
    json({ padding: "x".repeat(128 * 1024) }),
    json({}, 200, { "content-length": String(128 * 1024 + 1) }),
  ];
  for (const response of responses)
    await assert.rejects(
      checkEmailHistory("test@example.com", catalog, 13, {
        now,
        fetchImpl: async () => response,
      }),
      fails("invalid_response"),
    );
});

test("invalid addresses are rejected before any request", async () => {
  for (const email of ["", "x", "x@example.com\r\nx", "a@b", null]) {
    await assert.rejects(
      checkEmailHistory(email, catalog, 13, {
        fetchImpl: async () => assert.fail("must not call provider"),
      }),
      TypeError,
    );
  }
});

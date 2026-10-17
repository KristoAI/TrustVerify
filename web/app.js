import {
  startRegistration,
  startAuthentication,
  browserSupportsWebAuthn,
} from "@simplewebauthn/browser";
const $ = (s, r = document) => r.querySelector(s),
  page = document.body.dataset.page,
  workspace = $("#workspace");
const esc = (v) =>
  String(v ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const date = (v) =>
  v
    ? new Date(v).toLocaleString(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      })
    : "—";
const badge = (v) =>
  `<span class="badge ${["passed", "delivered", "live", "test", "pending", "failed", "inconclusive"].includes(v) ? v : ""}">${esc(v || "pending")}</span>`;
async function api(path, body, method) {
  const r = await fetch(path, {
    method: method || (body ? "POST" : "GET"),
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json();
  if (!r.ok) {
    const e = new Error(data.error || "The request could not be completed.");
    e.status = r.status;
    throw e;
  }
  return data;
}
function toast(message) {
  const el = $("#toast");
  el.textContent = message;
  el.style.display = "block";
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (el.style.display = "none"), 6500);
}
function modal(html) {
  $("#modal-content").innerHTML = html;
  $("#modal").showModal();
}
$("#modal .close").onclick = () => $("#modal").close();
function secrets(data, after) {
  modal(
    `<span class="eyebrow">SAVE THESE NOW</span><h2>Your credentials, just once.</h2><p>Keep these in a password manager. We only store hashes or encrypted secrets and won’t show these values again.</p>${[
      ["API key", data.api_key],
      ["Webhook signing secret", data.webhook_secret],
      ["Recovery code", data.recovery_code],
    ]
      .filter(([, v]) => v)
      .map(
        ([k, v]) => `<label>${k}<code class="secret">${esc(v)}</code></label>`,
      )
      .join(
        "",
      )}<button class="button primary full" id="saved-secrets">I’ve saved these securely →</button>`,
  );
  $("#saved-secrets").onclick = () => {
    $("#modal").close();
    after?.();
  };
}
async function busy(button, fn) {
  if (button?.disabled) return;
  const old = button?.textContent;
  if (button) {
    button.disabled = true;
    button.textContent = "Please wait…";
  }
  try {
    await fn();
  } catch (e) {
    toast(
      e.name === "NotAllowedError"
        ? "Passkey request cancelled or unavailable. Please try again."
        : e.message,
    );
  } finally {
    if (button?.isConnected) {
      button.disabled = false;
      button.textContent = old;
    }
  }
}
const verificationModes = {
  document: { label: "Document ID only", methods: ["document"] },
  "selfie-document": {
    label: "Live AI Age Check + Document ID",
    methods: ["selfie", "document"],
  },
};
const verificationMode = (methods) =>
  methods.includes("selfie") ? "selfie-document" : "document";
function modeOptions(selected = "selfie-document") {
  return Object.entries(verificationModes)
    .map(
      ([value, mode]) =>
        `<option value="${value}" ${value === selected ? "selected" : ""}>${mode.label}</option>`,
    )
    .join("");
}
function demo() {
  modal(
    `<span class="eyebrow">AGE VERIFICATION</span><h2>Choose your age check.</h2><p>Choose how you would like to confirm your age.</p><div class="panel"><h3>Live AI Age Check</h3><p>Use your camera for a live age estimate. If the estimate is below 25, continue with Document ID.</p><button class="button primary full" data-demo-path="selfie">Live AI Age Check</button></div><div class="panel"><h3>Document ID</h3><p>Use your driver’s license, passport or government ID. No selfie is needed.</p><button class="button primary full" data-demo-path="document">Document ID</button></div>`,
  );
  const choices = document.querySelectorAll('[data-demo-path]');
  choices.forEach((button) => {
    button.onclick = () => busy(button, async () => {
      choices.forEach(choice => { if (choice !== button) choice.disabled = true; });
      try {
        const method = button.dataset.demoPath;
        const result = await api("/api/demo/start", { mode: method === "selfie" ? "selfie-document" : "document" });
        const target = new URL(result.verification_url, location.origin);
        target.searchParams.set("check", "1");
        target.searchParams.set("method", method);
        location.assign(target.href);
      } finally { choices.forEach(choice => { if (choice !== button) choice.disabled = false; }); }
    });
  });
}
document.addEventListener("click", (e) => {
  const el = e.target.closest('[data-action="demo"]');
  if (el) busy(el, demo);
});
if ($("#auth-form"))
  $("#auth-form").onsubmit = async (e) => {
    e.preventDefault();
    const form = e.currentTarget,
      button = $("button", form),
      mode = form.dataset.mode,
      data = Object.fromEntries(new FormData(form));
    button.disabled = true;
    $(".form-error", form).textContent = "";
    try {
      const result = await api(
        `/api/account/${mode === "signup" ? "register" : mode}`,
        data,
      );
      if (result.recovery_code)
        secrets(result, () => location.assign("/dashboard"));
      else location.assign("/dashboard");
    } catch (error) {
      $(".form-error", form).textContent = error.message;
    } finally {
      button.disabled = false;
    }
  };
async function passkey(mode) {
  if (!browserSupportsWebAuthn())
    throw new Error(
      "This browser does not support passkeys. Use a current browser on HTTPS or localhost.",
    );
  const options = await api(`/api/passkeys/${mode}/options`, {}),
    response =
      mode === "register"
        ? await startRegistration({ optionsJSON: options })
        : await startAuthentication({ optionsJSON: options });
  return api(`/api/passkeys/${mode}/verify`, response);
}
function returnPath() {
  const value = new URLSearchParams(location.search).get("return");
  return value && /^\/v\/[a-f0-9-]+$/.test(value) ? value : null;
}
async function renderPass() {
  const data = await api("/api/visitor"),
    valid = data.proofs.filter(
      (p) => !p.revoked && new Date(p.expires_at) > new Date(),
    ),
    back = returnPath();
  workspace.innerHTML = `<span class="eyebrow">YOUR PERSONAL AGE PASS</span><h1>A little less<br>to do next time.</h1><p class="lead">Save your check. Keep your identity to yourself.</p>${valid.length ? valid.map((p) => `<div class="pass-summary"><span class="big-check">✓</span><div class="pass-status">Saved age check ${badge(p.environment)}</div><h2>${esc(p.age_over)}+ age pass</h2><dl><dt>Checked</dt><dd>${date(p.verified_at)}</dd><dt>Valid until</dt><dd>${date(p.expires_at)}</dd><dt>Method</dt><dd>${esc(p.method)}</dd></dl><p class="fine">Each site sets its own freshness and method requirements.</p></div>`).join("") : '<div class="panel"><h2>Your pass starts with a check.</h2><p>Complete verification on a participating site. Your saved result will appear here.</p><button class="button secondary" data-action="demo">Try a test check →</button></div>'}<div class="panel"><span class="eyebrow">${data.signed_in ? "YOUR PASSKEY ACCOUNT" : "NO USERNAME. NO EMAIL."}</span><h2>${data.signed_in ? "Welcome back." : "Take your pass with you."}</h2><p>${data.signed_in ? "Add a backup passkey or manage your saved keys." : "A passkey lets you sign in with your device’s fingerprint, face unlock, or screen lock. Your biometrics never reach TrustBunny."}</p><div class="actions">${data.can_register ? '<button class="button primary" id="register-passkey">' + (data.signed_in ? "Add a passkey" : "Save with a passkey") + " →</button>" : ""}${!data.signed_in ? '<button class="button secondary" id="login-passkey">Sign in with a passkey</button>' : '<button class="button secondary" id="logout-pass">Sign out</button>'}</div>${data.passkeys.map((p) => `<div class="site-card"><div><strong>${esc(p.name)}</strong><p>Added ${date(p.created_at)}${p.backed_up ? " · Backed up by your provider" : ""}</p></div>${data.passkeys.length > 1 ? `<button class="table-button" data-remove-passkey="${esc(p.id)}">Remove</button>` : ""}</div>`).join("")}<p class="fine">Passkeys protect access to a saved result. They do not verify your age independently.</p></div>${back ? `<a class="button primary full" href="${esc(back)}">Continue to your verification →</a>` : ""}<div class="panel"><h3>Recovery and privacy</h3><p>Use your saved recovery code if you’ve lost access to your passkey. Forgetting checks revokes saved age results on every device; your passkey account stays available.</p><div class="actions"><button class="button secondary small" id="recover-pass">Use recovery code</button>${valid.length ? '<button class="button danger small" id="forget-pass">Forget saved checks</button>' : ""}</div><p class="fine">Only remember a check on a device you trust. Cookies may be removed by your browser before their expiry.</p></div>`;
  $("#register-passkey")?.addEventListener("click", (e) =>
    busy(e.currentTarget, async () => {
      const r = await passkey("register");
      if (r.recovery_code) secrets(r, renderPass);
      else {
        toast("Passkey saved.");
        await renderPass();
      }
    }),
  );
  $("#login-passkey")?.addEventListener("click", (e) =>
    busy(e.currentTarget, async () => {
      await passkey("login");
      if (back) location.assign(back);
      else await renderPass();
    }),
  );
  $("#logout-pass")?.addEventListener("click", (e) =>
    busy(e.currentTarget, async () => {
      await api("/api/visitor/logout", {});
      await renderPass();
    }),
  );
  $("#recover-pass").onclick = () => {
    modal(
      '<h2>Recover your age pass.</h2><form id="pass-recover"><label>Recovery code<input name="recovery_code" required autocomplete="off"></label><p class="fine">The code is single-use. Save its replacement after signing in.</p><button class="button primary full">Recover account →</button></form>',
    );
    $("#pass-recover").onsubmit = (e) => {
      e.preventDefault();
      busy($("button", e.currentTarget), async () => {
        const r = await api(
          "/api/visitor/recover",
          Object.fromEntries(new FormData(e.currentTarget)),
        );
        $("#modal").close();
        secrets(r, renderPass);
      });
    };
  };
  $("#forget-pass")?.addEventListener("click", () => {
    modal(
      '<h2>Forget all saved age checks?</h2><p>Participating sites will see these results as revoked when they next check validity. Your passkeys remain available, but you will need a new age check.</p><button class="button danger full" id="confirm-forget">Revoke my saved checks</button>',
    );
    $("#confirm-forget").onclick = (e) =>
      busy(e.currentTarget, async () => {
        await api("/api/visitor/forget", {});
        $("#modal").close();
        await renderPass();
      });
  });
  document.querySelectorAll("[data-remove-passkey]").forEach(
    (b) =>
      (b.onclick = () =>
        busy(b, async () => {
          await api(
            "/api/visitor/passkeys/" +
              encodeURIComponent(b.dataset.removePasskey),
            {},
            "DELETE",
          );
          await renderPass();
        })),
  );
}
async function renderVerify() {
  const id = location.pathname.split("/")[2],
    data = await api(`/api/verification/${id}`);
  history.replaceState(null, "", location.pathname);
  const choices = [
    ["selfie", "Live AI Age Check", `Use your camera for a live age estimate. If the estimate is below ${Math.max(25, data.min_age)}, continue with Document ID.`],
    ["document", "Document ID", "Use your driver’s license, passport or government ID. No selfie is needed."],
  ].filter(([method]) => data.methods.includes(method)).map(([method, title, description]) =>
    `<div class="panel"><h2>${title}</h2><p>${description}</p><a class="button primary full" href="${esc(data.check_url + '&method=' + method)}">${title}</a></div>`,
  ).join("");
  workspace.innerHTML = `<span class="eyebrow">A PRIVATE CHECK FOR ${esc(data.site_name)}</span><h1>Choose your age check.</h1><p class="lead">${esc(data.site_name)} needs to confirm that you’re ${data.min_age} or older.</p>${data.environment === "test" ? '<div class="notice warning">Test environment · This check cannot grant access on live sites.</div>' : ""}${choices}${data.reusable ? '<div class="panel"><h2>Your saved check is also available.</h2><button id="reuse-pass" class="button secondary full">Use my saved age check →</button></div>' : ''}<p class="fine center">Images and document details are processed on your device.</p><a class="check-link center" href="/me?return=${encodeURIComponent(location.pathname)}">Have a passkey? Sign in to your age pass</a>`;

  $("#reuse-pass")?.addEventListener("click", (e) =>
    busy(e.currentTarget, async () => {
      const r = await api(`/api/verification/${id}/reuse`, {});
      location.assign(r.url);
    }),
  );
}
async function renderComplete() {
  const data = await api("/api/completion"),
    passed = data.outcome === "passed";
  workspace.innerHTML = `<div class="center"><span class="eyebrow">${esc(data.site_name)} · ${esc(data.environment)} ENVIRONMENT</span><div class="result-icon">${passed ? "✓" : "↻"}</div><h1>${passed ? "You’re all set." : "We couldn’t confirm your age."}</h1><p class="lead" style="margin-inline:auto">${passed ? "Your age check is saved in this browser. You can now continue back to the site." : "You can return to the site and start a new verification session."}</p></div><div class="panel"><dl class="status-detail"><dt>Result</dt><dd>${badge(data.outcome)}</dd><dt>Age threshold</dt><dd>${data.age_over}+</dd><dt>Method</dt><dd>${esc(data.method)}</dd><dt>Valid until</dt><dd>${date(data.valid_until)}</dd></dl><button class="button primary full" id="continue-site">Continue to ${esc(data.site_name)} →</button></div>${passed ? '<div class="panel"><span class="eyebrow">OPTIONAL · NO EMAIL REQUIRED</span><h2>Make your next visit easier.</h2><p>Save a passkey to reuse this check on another supported device. Keep the recovery code in your password manager.</p><button class="button secondary" id="save-complete-pass">Save with a passkey →</button><a class="check-link" href="/me">Manage my age pass</a></div>' : ""}`;
  $("#continue-site").onclick = (e) =>
    busy(e.currentTarget, async () =>
      location.assign((await api("/api/completion/continue", {})).url),
    );
  $("#save-complete-pass")?.addEventListener("click", (e) =>
    busy(e.currentTarget, async () => {
      const r = await passkey("register");
      if (r.recovery_code) secrets(r);
      else toast("Passkey saved.");
    }),
  );
}
async function renderDemo() {
  const data = await api("/api/demo/result");
  workspace.innerHTML = `<span class="eyebrow">THE HANDOFF IS COMPLETE</span><h1>That’s the whole journey.</h1><p class="lead">TrustBunny returned a signed result and matched it to the browser session that started this demo.</p><div class="notice warning">Test result · Browser-asserted age check</div><pre>${esc(JSON.stringify(data, null, 2))}</pre><div class="actions"><a class="button primary" href="/signup">Connect your own site ↗</a><a class="button secondary" href="/me">View my saved pass</a></div>`;
}
let dashboardData,
  section = "Overview";
const table = (head, rows) =>
  `<div class="table-wrap"><table><thead><tr>${head.map((h) => `<th>${h}</th>`).join("")}</tr></thead><tbody>${rows.join("")}</tbody></table></div>`;
const empty = (title, body, button = "") =>
  `<div class="empty"><div class="empty-icon">◇</div><h3>${title}</h3><p>${body}</p>${button}</div>`;
async function loadDashboard() {
  try {
    dashboardData = await api("/api/dashboard");
    renderDashboard();
  } catch (e) {
    if (e.status === 401) {
      location.assign("/login");
      return;
    }
    throw e;
  }
}
function renderDashboard() {
  const d = dashboardData,
    siteName = (id) => d.sites.find((s) => s.id === id)?.name || "Site";
  workspace.innerHTML = `<aside class="sidebar"><span class="eyebrow">CLIENT WORKSPACE</span>${["Overview", "Sites", "Sessions", "Webhooks", "API keys", "Account"].map((n) => `<button data-section="${n}" class="${section === n ? "active" : ""}">${n}</button>`).join("")}<div class="side-bottom"><button id="signout">Sign out ↗</button></div></aside><div class="workspace-main"><div class="workspace-head"><div><span class="eyebrow">${esc(d.account.name)}</span><h1>${section === "Overview" ? "Your verification workspace." : esc(section)}</h1><p>${section === "Overview" ? "A clear view of your sites and their age checks." : "Manage your TrustBunny integration."}</p></div><button class="button primary small" id="new-site">＋ Add site</button></div><div id="dashboard-content"></div></div>`;
  let html = "";
  const sessions = (rows = d.sessions) =>
    rows.length
      ? table(
          ["Session / site", "Result", "Environment", "Created", ""],
          rows.map(
            (s) =>
              `<tr><td><code>${esc(s.id.slice(0, 8))}…</code><small>${esc(siteName(s.site_id))}</small></td><td>${badge(s.outcome || s.status)}</td><td>${badge(s.environment)}</td><td>${date(s.created_at)}</td><td><button class="table-button" data-session="${s.id}">Details</button></td></tr>`,
          ),
        )
      : empty(
          "Your first check starts here.",
          "Connect a site and create a session. Verification activity will appear here.",
        );
  const sites = () =>
    d.sites.length
      ? d.sites
          .map(
            (s) =>
              `<div class="site-card"><div class="site-icon">↗</div><div class="site-info"><h3>${esc(s.name)} ${badge(s.environment)}</h3><p>${esc(s.origin)} · ${s.policy.minAge}+ · ${s.enabled ? "Enabled" : "Disabled"}</p></div><div class="actions"><button class="button secondary small" data-install="${s.id}">Install</button><button class="button secondary small" data-edit-site="${s.id}">Settings</button></div></div>`,
          )
          .join("")
      : empty(
          "Give your first site a private welcome.",
          "Set an age threshold, choose where checks apply, and connect your return URL.",
          '<button class="button primary small" data-add-site>Add your first site →</button>',
        );
  if (section === "Overview")
    html = `<div class="stats"><div class="stat"><small>Connected sites</small><strong>${d.sites.length}</strong></div><div class="stat"><small>Recent sessions</small><strong>${d.sessions.length}</strong></div><div class="stat"><small>Recent passed checks</small><strong>${d.sessions.filter((s) => s.outcome === "passed").length}</strong></div></div><div class="section-bar"><h2>Your sites</h2><span class="muted">Test and live</span></div>${sites()}<div class="section-bar"><h2>Recent activity</h2><span class="muted">Latest ${Math.min(d.sessions.length, 8)} sessions</span></div>${sessions(d.sessions.slice(0, 8))}`;
  if (section === "Sites")
    html = `<div class="notice">Each site has separate API keys, policies, and signed results. A saved visitor pass can be reused only when it meets that site’s requirements.</div>${sites()}`;
  if (section === "Sessions")
    html = `<p class="muted">Showing up to 100 recent sessions, capped at 50 per site.</p>${sessions()}`;
  if (section === "Webhooks")
    html = `<div class="notice">Deliveries are signed and retried automatically. Your receiver should store each event once and return a 2xx response.</div>${
      d.webhooks.length
        ? table(
            ["Event / site", "Delivery", "Attempts", "Last HTTP", ""],
            d.webhooks.map(
              (w) =>
                `<tr><td><code>${esc(w.id.slice(0, 8))}…</code><small>${esc(siteName(w.site_id))}</small></td><td>${badge(w.status)}</td><td>${w.attempts}</td><td>${w.http_status || "—"}</td><td>${w.status !== "processing" ? `<button class="table-button" data-retry="${w.id}">Retry</button>` : "Delivering…"}</td></tr>`,
            ),
          )
        : empty(
            "No deliveries yet.",
            "Add a webhook endpoint in a site’s settings. Completed checks will create delivery events here.",
          )
    }`;
  if (section === "API keys")
    html = `<div class="notice">API keys are server credentials. Never put them in browser JavaScript or public source control. Revoking a key takes effect on the next request.</div>${
      d.keys.length
        ? table(
            ["Name / site", "Prefix", "Created", "Status", ""],
            d.keys.map(
              (k) =>
                `<tr><td>${esc(k.name)}<small>${esc(siteName(k.site_id))}</small></td><td><code>${esc(k.prefix)}…</code></td><td>${date(k.created_at)}</td><td>${k.revoked_at ? "Revoked" : "Active"}</td><td>${k.revoked_at ? "" : `<button class="table-button" data-revoke-key="${k.id}">Revoke</button>`}</td></tr>`,
            ),
          )
        : empty(
            "Your keys will live here.",
            "Create a site to receive its first server API key.",
          )
    }<div class="actions">${d.sites.length ? '<button class="button secondary" id="create-key">Create an API key ＋</button>' : ""}</div>`;
  if (section === "Account")
    html = `<div class="panel"><h2>${esc(d.account.name)}</h2><dl class="status-detail"><dt>Business email</dt><dd>${esc(d.account.email)}</dd><dt>Created</dt><dd>${date(d.account.created_at)}</dd><dt>Account ID</dt><dd><code>${esc(d.account.id)}</code></dd></dl></div><div class="panel"><h3>Recovery</h3><p>Your one-time recovery code was shown when you registered. Use it to reset your password if needed. Email-based recovery is not configured.</p><a class="button secondary small" href="/recover">Recover or change password →</a></div><div class="notice warning">This release reports browser-asserted verification. A passkey authenticates a saved pass; it does not raise the assurance of the original age check.</div>`;
  $("#dashboard-content").innerHTML = html;
  document.querySelectorAll("[data-section]").forEach(
    (b) =>
      (b.onclick = () => {
        section = b.dataset.section;
        renderDashboard();
      }),
  );
  $("#new-site").onclick = () => siteForm();
  $("[data-add-site]")?.addEventListener("click", () => siteForm());
  $("#signout").onclick = (e) =>
    busy(e.currentTarget, async () => {
      await api("/api/account/logout", {});
      location.assign("/login");
    });
  document
    .querySelectorAll("[data-edit-site]")
    .forEach(
      (b) =>
        (b.onclick = () =>
          siteForm(d.sites.find((s) => s.id === b.dataset.editSite))),
    );
  document
    .querySelectorAll("[data-install]")
    .forEach(
      (b) =>
        (b.onclick = () =>
          install(d.sites.find((s) => s.id === b.dataset.install))),
    );
  document.querySelectorAll("[data-retry]").forEach(
    (b) =>
      (b.onclick = () =>
        busy(b, async () => {
          await api(`/api/dashboard/webhooks/${b.dataset.retry}/retry`, {});
          toast("Delivery queued for retry.");
          await loadDashboard();
        })),
  );
  document.querySelectorAll("[data-session]").forEach(
    (b) =>
      (b.onclick = () => {
        const s = d.sessions.find((s) => s.id === b.dataset.session);
        modal(
          `<h2>Verification session</h2><pre>${esc(JSON.stringify({ session_id: s.id, site: siteName(s.site_id), status: s.status, outcome: s.outcome, environment: s.environment, age_over: s.min_age, method: s.method, assurance: s.assurance, source: s.source, country: s.country, region: s.region, created_at: s.created_at, valid_until: s.valid_until }, null, 2))}</pre>${s.outcome === "passed" && new Date(s.valid_until) > new Date() ? '<button class="button danger" id="revoke-session">Revoke this site’s result</button>' : ""}`,
        );
        $("#revoke-session")?.addEventListener("click", (e) =>
          busy(e.currentTarget, async () => {
            await api(`/api/dashboard/sessions/${s.id}/revoke`, {});
            $("#modal").close();
            toast("Result revoked. API and receipt checks now reject it.");
            await loadDashboard();
          }),
        );
      }),
  );
  document.querySelectorAll("[data-revoke-key]").forEach(
    (b) =>
      (b.onclick = () => {
        modal(
          '<h2>Revoke this API key?</h2><p>Integrations using this key will stop working immediately. Create and install a replacement first if needed.</p><button class="button danger full" id="confirm-revoke-key">Revoke key</button>',
        );
        $("#confirm-revoke-key").onclick = (e) =>
          busy(e.currentTarget, async () => {
            await api(
              `/api/dashboard/keys/${b.dataset.revokeKey}`,
              {},
              "DELETE",
            );
            $("#modal").close();
            await loadDashboard();
          });
      }),
  );
  $("#create-key")?.addEventListener("click", () => {
    modal(
      `<h2>Create a server API key</h2><form id="key-form"><label>Site<select name="site">${d.sites.map((s) => `<option value="${s.id}">${esc(s.name)} (${s.environment})</option>`).join("")}</select></label><label>Key name<input name="name" required maxlength="60" placeholder="Production backend"></label><button class="button primary full">Create key →</button></form>`,
    );
    $("#key-form").onsubmit = (e) => {
      e.preventDefault();
      const form = e.currentTarget;
      busy($("button", form), async () => {
        const f = Object.fromEntries(new FormData(form)),
          r = await api(`/api/dashboard/sites/${f.site}/keys`, {
            name: f.name,
          });
        $("#modal").close();
        secrets(r, loadDashboard);
      });
    };
  });
}
function siteForm(site) {
  const s = site || {
      name: "",
      origin: "",
      return_url: "",
      environment: "test",
      enabled: true,
      webhook_url: "",
      policy: {
        minAge: 18,
        maxAgeHours: 8760,
        mode: "everywhere",
        regions: [],
        unknown: "require",
        methods: ["selfie", "document"],
      },
      branding: { color: "#345cfa", title: "Confirm your age" },
    },
    p = s.policy;
  modal(
    `<span class="eyebrow">${site ? "SITE SETTINGS" : "CONNECT YOUR WEBSITE"}</span><h2>${site ? "Make it yours." : "A private welcome starts here."}</h2><form id="site-form"><div class="form-grid"><label>Site name<input name="name" required maxlength="80" value="${esc(s.name)}" placeholder="My website"></label><label>Environment<select name="environment" ${site ? "disabled" : ""}><option value="test" ${s.environment === "test" ? "selected" : ""}>Test</option><option value="live" ${s.environment === "live" ? "selected" : ""}>Live</option></select></label><label class="wide">Website origin<input name="origin" type="url" required value="${esc(s.origin)}" placeholder="https://example.com"><small>Exact origin, without a trailing slash or path.</small></label><label class="wide">Return URL<input name="return_url" type="url" required value="${esc(s.return_url)}" placeholder="https://example.com/age-check/callback"><small>Fixed path on your origin. No query parameters.</small></label><label>Minimum age<input name="minAge" type="number" min="18" max="99" required value="${p.minAge}"></label><label>Maximum proof age (hours)<input name="maxAgeHours" type="number" min="1" max="8760" required value="${p.maxAgeHours}"><small>8760 hours = 365 days.</small></label><label class="wide">Verification mode<select name="verificationMode">${modeOptions(verificationMode(p.methods))}</select><small>Live AI Age Check and Document ID are the two paths. A live estimate under 25 requires a document to finish. Document ID starts directly with the document.</small></label><label>Where to require a check<select name="mode"><option value="everywhere" ${p.mode === "everywhere" ? "selected" : ""}>Everywhere</option><option value="regions" ${p.mode === "regions" ? "selected" : ""}>Selected regions</option></select></label><label>When location is unknown<select name="unknown"><option value="require" ${p.unknown === "require" ? "selected" : ""}>Require verification</option><option value="allow" ${p.unknown === "allow" ? "selected" : ""}>Allow without verification</option><option value="deny" ${p.unknown === "deny" ? "selected" : ""}>Deny access</option></select></label><label class="wide">Region codes<input name="regions" value="${esc(p.regions.join(", "))}" placeholder="US-TX, US-LA, GB"><small>Comma-separated ISO country or country-region codes. Applies to selected-region mode.</small></label><label>Brand color<input name="color" type="color" value="${esc(s.branding.color)}"></label><label>Gate title<input name="title" required maxlength="80" value="${esc(s.branding.title)}"></label><label class="wide">Webhook URL (optional)<input name="webhook_url" type="url" value="${esc(s.webhook_url || "")}" placeholder="https://example.com/api/trustbunny"><small>Public HTTPS endpoint. Changing this URL rotates its signing secret.</small></label><label class="wide"><input type="checkbox" name="enabled" ${s.enabled ? "checked" : ""}>Enable this site</label></div><p class="form-error" role="alert"></p><button class="button primary full">${site ? "Save changes" : "Create site"} →</button></form>`,
  );
  $("#site-form").onsubmit = async (e) => {
    e.preventDefault();
    const f = e.currentTarget,
      v = Object.fromEntries(new FormData(f)),
      button = $("button", f);
    button.disabled = true;
    $(".form-error", f).textContent = "";
    const body = {
      name: v.name,
      origin: v.origin.trim(),
      return_url: v.return_url.trim(),
      environment: site ? s.environment : v.environment,
      enabled: v.enabled === "on",
      webhook_url: v.webhook_url.trim() || null,
      branding: { color: v.color, title: v.title },
      policy: {
        minAge: Number(v.minAge),
        maxAgeHours: Number(v.maxAgeHours),
        methods: verificationModes[v.verificationMode].methods,
        mode: v.mode,
        regions: v.regions
          .split(",")
          .map((x) => x.trim().toUpperCase())
          .filter(Boolean),
        unknown: v.unknown,
        version: p.version || 1,
      },
    };
    try {
      const r = await api(
        "/api/dashboard/sites" + (site ? "/" + site.id : ""),
        body,
        site ? "PUT" : "POST",
      );
      $("#modal").close();
      if (r.api_key || r.webhook_secret) secrets(r, loadDashboard);
      else {
        toast("Site settings saved.");
        await loadDashboard();
      }
    } catch (e) {
      $(".form-error", f).textContent = e.message;
    } finally {
      button.disabled = false;
    }
  };
}
function install(site) {
  modal(
    `<span class="eyebrow">${esc(site.name)} · ${esc(site.environment)}</span><h2>Your site, connected.</h2><p>Add this script to your site, including the registered return page.</p><pre>${esc(`<script defer src="${dashboardData.origin}/gate.js" data-site="${site.id}"></script>`)}</pre><p class="fine">The gate evaluates your regional settings and remembers site-specific receipts. Protect restricted content on your server; an overlay alone cannot secure content already downloaded.</p><label>Site ID<code class="secret">${site.id}</code></label><a class="button primary" href="/docs">Read integration guide →</a><p class="fine">For server integration, create a session with your server API key, bind state to the visitor’s browser session, then redirect to verification_url.</p>`,
  );
}
const renderers = {
  dashboard: loadDashboard,
  pass: renderPass,
  verify: renderVerify,
  complete: renderComplete,
  demo: renderDemo,
};
if (renderers[page])
  renderers[page]().catch((e) => {
    workspace.innerHTML = `<div class="panel"><h2>Let’s try that again.</h2><p>${esc(e.message)}</p><button class="button primary" id="reload-page">Reload</button><a class="check-link" href="/">Back to TrustBunny</a></div>`;
    $("#reload-page").onclick = () => location.reload();
  });

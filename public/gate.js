/* TrustBunny embed v1. No server secrets belong in this file or its attributes. */
(() => {
  "use strict";
  const script = document.currentScript,
    site = script?.dataset.site;
  if (!site) return;
  const origin = new URL(script.src).origin,
    key = "tv_gate_" + site,
    cookieName = "tv_receipt_" + site.replaceAll("-", ""),
    pendingKey = key + "_pending";
  let dialog;
  const api = async (path, body) => {
    const r = await fetch(
      origin + "/v1/browser/" + path + "?site_id=" + encodeURIComponent(site),
      {
        method: "POST",
        credentials: "omit",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    const d = await r.json();
    if (!r.ok)
      throw new Error(
        d.error || "The age check is unavailable. Please try again.",
      );
    return d;
  };
  const random = () =>
    Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) =>
      b.toString(16).padStart(2, "0"),
    ).join("");
  const hash = async (s) =>
    Array.from(
      new Uint8Array(
        await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)),
      ),
      (b) => b.toString(16).padStart(2, "0"),
    ).join("");
  const emit = (name, detail) => {
    window.dispatchEvent(new CustomEvent("trustbunny:" + name, { detail }));
    // Compatibility for sites installed before the rebrand.
    window.dispatchEvent(new CustomEvent("trustverify:" + name, { detail }));
  };
  const receipt = () =>
    document.cookie
      .split("; ")
      .find((c) => c.startsWith(cookieName + "="))
      ?.slice(cookieName.length + 1);
  function overlay(title, message, branding = {}, blocked = false) {
    if (dialog) dialog.remove();
    dialog = document.createElement("dialog");
    dialog.style.cssText =
      "border:0;padding:0;border-radius:16px;max-width:440px;width:calc(100% - 40px);box-shadow:0 25px 100px #10253b55";
    dialog.setAttribute("aria-label", "Age verification");
    const host = document.createElement("div");
    dialog.append(host);
    const root = host.attachShadow({ mode: "open" }),
      style = document.createElement("style");
    style.textContent =
      ":host{font-family:Arial,Helvetica,sans-serif;color:#15232c}section{padding:35px}small{font-size:10px;letter-spacing:1.2px;color:#657987}h2{font-size:28px;letter-spacing:-.7px;line-height:1.2;margin:20px 0 15px}p{font-size:14px;line-height:1.8;color:#61717e}button{border:0;border-radius:7px;width:100%;padding:15px;color:white;font-weight:600;font-size:14px;cursor:pointer}button:disabled{opacity:.6}a{display:block;text-align:center;font-size:11px;color:#73828f;margin-top:17px}";
    root.append(style);
    const panel = document.createElement("section");
    root.append(panel);
    const label = document.createElement("small");
    label.textContent = "PRIVATE AGE CHECK · TRUSTBUNNY";
    panel.append(label);
    const h = document.createElement("h2");
    h.textContent = title;
    panel.append(h);
    const p = document.createElement("p");
    p.textContent = message;
    panel.append(p);
    if (!blocked) {
      const b = document.createElement("button");
      b.textContent = "Verify my age →";
      b.style.background = /^#[0-9a-f]{6}$/i.test(branding.color)
        ? branding.color
        : "#345cfa";
      panel.append(b);
      b.onclick = async () => {
        b.disabled = true;
        p.textContent = "Opening your private age check…";
        try {
          const state = random(),
            verifier = random();
          sessionStorage.setItem(
            pendingKey,
            JSON.stringify({ state, verifier, created: Date.now() }),
          );
          const d = await api("bootstrap", {
            state,
            code_challenge: await hash(verifier),
          });
          if (d.decision === "not_required") {
            dialog.close();
            dialog.remove();
            emit("allowed", { reason: d.reason, verified: false });
          } else if (d.decision === "denied") {
            p.textContent =
              "This site does not allow access from an unknown location.";
            b.remove();
          } else location.assign(d.verification_url);
        } catch (e) {
          p.textContent = e.message;
          b.disabled = false;
        }
      };
    }
    const link = document.createElement("a");
    link.textContent = "Images stay on your device · Privacy";
    link.href = origin + "/privacy";
    link.target = "_blank";
    link.rel = "noopener";
    panel.append(link);
    dialog.addEventListener("cancel", (e) => e.preventDefault());
    document.body.append(dialog);
    dialog.showModal();
  }
  async function run() {
    try {
      const url = new URL(location.href),
        result = url.searchParams.get("tv_result"),
        state = url.searchParams.get("state");
      if (result) {
        let pending;
        try {
          pending = JSON.parse(sessionStorage.getItem(pendingKey) || "null");
        } catch {}
        if (
          !pending ||
          pending.state !== state ||
          Date.now() - pending.created > 25 * 60000
        )
          throw new Error(
            "The return did not match this browser session. Please start a new age check.",
          );
        const d = await api("receipt", { result, verifier: pending.verifier });
        const seconds = Math.max(
          0,
          Math.floor((new Date(d.valid_until) - Date.now()) / 1000),
        );
        document.cookie =
          cookieName +
          "=" +
          d.receipt +
          "; Path=/; SameSite=Lax; Max-Age=" +
          seconds +
          (location.protocol === "https:" ? "; Secure" : "");
        sessionStorage.removeItem(pendingKey);
        url.searchParams.delete("tv_result");
        url.searchParams.delete("state");
        history.replaceState(null, "", url.href);
      }
      const saved = receipt(),
        d = await api("status", saved ? { receipt: saved } : {});
      if (d.decision === "denied") {
        overlay(
          "Access is unavailable.",
          "This site’s policy does not allow access when your location is unknown.",
          d.branding,
          true,
        );
        emit("denied", d);
        return;
      }
      if (d.valid || d.decision === "not_required") {
        emit("allowed", {
          verified: d.valid,
          reason: d.reason,
          environment: d.environment,
        });
        return;
      }
      overlay(
        d.branding.title,
        "Confirm your age to continue. Your images and document details stay on your device.",
        d.branding,
      );
      emit("required", d);
    } catch (e) {
      overlay("Let’s confirm your age.", e.message);
      emit("error", { message: e.message });
    }
  }
  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", run, { once: true });
  else run();
})();

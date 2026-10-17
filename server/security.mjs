import crypto from "node:crypto";
import { promisify } from "node:util";
import dns from "node:dns/promises";
import https from "node:https";
import ipaddr from "ipaddr.js";
import {
  SignJWT,
  jwtVerify,
  importJWK,
  exportJWK,
  generateKeyPair,
} from "jose";
const scrypt = promisify(crypto.scrypt);
export const random = (bytes = 32) =>
  crypto.randomBytes(bytes).toString("base64url");
export const hash = (value) =>
  crypto.createHash("sha256").update(String(value)).digest("hex");
export const equal = (a, b) =>
  typeof a === "string" &&
  typeof b === "string" &&
  a.length === b.length &&
  crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
export const now = () => new Date().toISOString();
export const after = (seconds) =>
  new Date(Date.now() + seconds * 1000).toISOString();
export const isFuture = (date) =>
  !!date && new Date(date).getTime() > Date.now();
export async function passwordHash(password) {
  const salt = random(16);
  return `${salt}:${(await scrypt(password, salt, 64)).toString("hex")}`;
}
export async function passwordMatches(password, stored) {
  const [salt, key] = stored.split(":");
  return equal((await scrypt(password, salt, 64)).toString("hex"), key);
}
export function seal(value, key) {
  const iv = crypto.randomBytes(12),
    cipher = crypto.createCipheriv("aes-256-gcm", Buffer.from(key, "hex"), iv);
  return Buffer.concat([
    iv,
    cipher.update(value, "utf8"),
    cipher.final(),
    cipher.getAuthTag(),
  ]).toString("base64url");
}
export function unseal(value, key) {
  const b = Buffer.from(value, "base64url"),
    d = crypto.createDecipheriv(
      "aes-256-gcm",
      Buffer.from(key, "hex"),
      b.subarray(0, 12),
    );
  d.setAuthTag(b.subarray(-16));
  return Buffer.concat([d.update(b.subarray(12, -16)), d.final()]).toString();
}
export async function makeSigningKeys() {
  const { privateKey, publicKey } = await generateKeyPair("ES256", {
    extractable: true,
  });
  return {
    private: await exportJWK(privateKey),
    public: await exportJWK(publicKey),
    kid: random(12),
  };
}
export async function signer(keys, issuer) {
  const privateKey = await importJWK(keys.private, "ES256"),
    publicKey = await importJWK(keys.public, "ES256");
  return {
    jwks: {
      keys: [{ ...keys.public, kid: keys.kid, alg: "ES256", use: "sig" }],
    },
    sign: (payload, audience, seconds = 120, type = "tv-result+jwt") =>
      new SignJWT(payload)
        .setProtectedHeader({ alg: "ES256", kid: keys.kid, typ: type })
        .setIssuer(issuer)
        .setAudience(audience)
        .setIssuedAt()
        .setExpirationTime(Math.floor(Date.now() / 1000) + seconds)
        .setJti(random(16))
        .sign(privateKey),
    verify: async (token, audience, type = "tv-result+jwt") =>
      (
        await jwtVerify(token, publicKey, {
          issuer,
          audience,
          algorithms: ["ES256"],
          typ: type,
        })
      ).payload,
  };
}
export function isPublicIP(value) {
  try {
    let a = ipaddr.parse(value);
    if (a.kind() === "ipv6" && a.isIPv4MappedAddress()) a = a.toIPv4Address();
    return a.range() === "unicast";
  } catch {
    return false;
  }
}
export function allowedReturn(value, origin, environment) {
  const u = new URL(value),
    base = new URL(origin);
  if (
    u.origin !== base.origin ||
    u.username ||
    u.password ||
    u.hash ||
    u.search
  )
    throw new Error(
      "Return URL must be a fixed path on your registered origin, without query parameters.",
    );
  if (
    u.protocol !== "https:" &&
    !(
      environment === "test" &&
      u.protocol === "http:" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname)
    )
  )
    throw new Error("Live sites require HTTPS. Test sites may use localhost.");
  return u.href;
}
export async function webhookTarget(value, lookup = dns.lookup) {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hash ||
    url.search ||
    (url.port && url.port !== "443")
  )
    throw new Error(
      "Webhooks require a public HTTPS URL on port 443, without credentials or query parameters.",
    );
  const addresses = await lookup(url.hostname, { all: true });
  if (!addresses.length || addresses.some((a) => !isPublicIP(a.address)))
    throw new Error(
      "Webhook destination must resolve exclusively to public IP addresses.",
    );
  return { url, address: addresses[0] };
}
// Pin the validated DNS answer to prevent rebinding. Never follow redirects.
export async function deliverWebhook(url, body, signature) {
  const target = await webhookTarget(url);
  return new Promise((resolve, reject) => {
    const req = https.request(
      target.url,
      {
        method: "POST",
        timeout: 10000,
        lookup: (_host, opts, cb) =>
          opts.all
            ? cb(null, [target.address])
            : cb(null, target.address.address, target.address.family),
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
          "TrustBunny-Signature": signature,
          "TrustVerify-Signature": signature, // Legacy integrations.
          "User-Agent": "TrustBunny-Webhooks/1",
        },
      },
      (res) => {
        res.resume();
        resolve(res.statusCode);
      },
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.end(body);
  });
}
export const webhookSignature = (
  body,
  secret,
  timestamp = Math.floor(Date.now() / 1000),
) =>
  `t=${timestamp},v1=${crypto.createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;

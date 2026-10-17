// Independently implemented from the public AWS SESv2 and Signature V4 specifications.
// https://docs.aws.amazon.com/ses/latest/APIReference-V2/API_SendEmail.html
// https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_sigv-create-signed-request.html
// Shared by the Deno entrypoint and Node tests; no AWS credentials reach the browser.
const encoder = new TextEncoder();
const hex = (bytes) =>
  Array.from(new Uint8Array(bytes), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
const digest = async (value) =>
  hex(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
const hmac = async (key, value) => {
  const imported = await crypto.subtle.importKey(
    "raw",
    typeof key === "string" ? encoder.encode(key) : key,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return crypto.subtle.sign("HMAC", imported, encoder.encode(value));
};
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });

export function validEmail(value) {
  if (
    typeof value !== "string" ||
    value.length > 254 ||
    /[^\x21-\x7e]/.test(value)
  )
    return false;
  const parts = value.split("@");
  if (
    parts.length !== 2 ||
    !parts[0] ||
    parts[0].length > 64 ||
    parts[0].startsWith(".") ||
    parts[0].endsWith(".") ||
    parts[0].includes("..")
  )
    return false;
  return (
    /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(parts[0]) &&
    parts[1].includes(".") &&
    parts[1]
      .split(".")
      .every((label) =>
        /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label),
      )
  );
}

export function validPayload(value) {
  return (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === 3 &&
    Object.keys(value).every((key) =>
      ["requestId", "to", "code"].includes(key),
    ) &&
    typeof value.requestId === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value.requestId,
    ) &&
    validEmail(value.to) &&
    typeof value.code === "string" &&
    /^\d{6}$/.test(value.code)
  );
}

export const dispatchDigest = ({ requestId, to, code }) =>
  digest(`${requestId}\n${to}\n${code}`);

export async function sameSecret(actual, expected) {
  if (
    typeof expected !== "string" ||
    expected.length < 32 ||
    expected.length > 256 ||
    typeof actual !== "string" ||
    actual.length > 256
  )
    return false;
  const [a, b] = await Promise.all([digest(actual), digest(expected)]);
  let different = 0;
  for (let i = 0; i < a.length; i++)
    different |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return different === 0;
}

export function validConfig(config) {
  return (
    typeof config.secret === "string" &&
    config.secret.length >= 32 &&
    config.secret.length <= 256 &&
    /^(?:af|ap|ca|cn|eu|il|me|mx|sa|us)-(?:[a-z]+-)*[a-z]+-\d+$/.test(
      config.region || "",
    ) &&
    typeof config.accessKeyId === "string" &&
    /^[A-Z0-9]{16,128}$/.test(config.accessKeyId) &&
    typeof config.secretAccessKey === "string" &&
    config.secretAccessKey.length >= 32 &&
    validEmail(config.from) &&
    (!config.sessionToken ||
      (typeof config.sessionToken === "string" &&
        !/[\r\n]/.test(config.sessionToken))) &&
    (!config.configurationSet ||
      /^[A-Za-z0-9_-]{1,64}$/.test(config.configurationSet))
  );
}

export async function signSesRequest(config, payload, now = new Date()) {
  const host = `email.${config.region}.amazonaws.com${config.region.startsWith("cn-") ? ".cn" : ""}`;
  const path = "/v2/email/outbound-emails";
  const date = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const day = date.slice(0, 8);
  const body = JSON.stringify({
    FromEmailAddress: config.from,
    Destination: { ToAddresses: [payload.to] },
    Content: {
      Simple: {
        Subject: {
          Data: "Your TrustBunny verification code",
          Charset: "UTF-8",
        },
        Body: {
          Text: {
            Data: `Your TrustBunny verification code is ${payload.code}.\n\nEnter this code in the verification window you opened. It expires shortly. Do not share it.\n\nIf you did not request this code, you can ignore this email.`,
            Charset: "UTF-8",
          },
        },
      },
    },
    ...(config.configurationSet
      ? { ConfigurationSetName: config.configurationSet }
      : {}),
  });
  const headers = {
    "content-type": "application/json",
    host,
    "x-amz-date": date,
  };
  if (config.sessionToken)
    headers["x-amz-security-token"] = config.sessionToken;
  const keys = Object.keys(headers).sort();
  const signedHeaders = keys.join(";");
  const canonical = [
    "POST",
    path,
    "",
    keys.map((key) => `${key}:${headers[key].trim()}\n`).join(""),
    signedHeaders,
    await digest(body),
  ].join("\n");
  const scope = `${day}/${config.region}/ses/aws4_request`;
  const stringToSign = `AWS4-HMAC-SHA256\n${date}\n${scope}\n${await digest(canonical)}`;
  let signingKey = await hmac(`AWS4${config.secretAccessKey}`, day);
  for (const part of [config.region, "ses", "aws4_request"])
    signingKey = await hmac(signingKey, part);
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${config.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${hex(await hmac(signingKey, stringToSign))}`;
  // Fetch derives Host from the fixed AWS URL; do not try to set a forbidden header.
  delete headers.host;
  return { url: `https://${host}${path}`, method: "POST", headers, body };
}

async function readPayload(req) {
  if (Number(req.headers.get("content-length") || 0) > 2048)
    throw new Error("too_large");
  const reader = req.body?.getReader();
  if (!reader) throw new Error("invalid");
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 2048) {
        await reader.cancel();
        throw new Error("too_large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}

// claim must atomically validate the precommitted payload digest, enforce send budgets,
// and consume requestId. Once claimed, never release it or retry an ambiguous SES send.
export function createEmailHandler({
  config,
  claim,
  finish,
  fetchImpl = fetch,
  now = () => new Date(),
}) {
  return async (req) => {
    if (req.method !== "POST")
      return json({ error: "Method not allowed" }, 405);
    if (!validConfig(config))
      return json({ error: "Email sending is unavailable" }, 503);
    if (
      !(await sameSecret(
        req.headers.get("x-tv-email-key") || "",
        config.secret,
      ))
    )
      return json({ error: "Unauthorized" }, 401);
    if (
      !(req.headers.get("content-type") || "")
        .toLowerCase()
        .startsWith("application/json")
    )
      return json({ error: "Invalid request" }, 400);
    let payload;
    try {
      payload = await readPayload(req);
    } catch (error) {
      return json(
        { error: "Invalid request" },
        error.message === "too_large" ? 413 : 400,
      );
    }
    if (!validPayload(payload)) return json({ error: "Invalid request" }, 400);
    let authorized;
    try {
      authorized = await claim(
        payload.requestId,
        await dispatchDigest(payload),
      );
    } catch {
      return json({ error: "Email sending is unavailable" }, 503);
    }
    if (authorized?.ok !== true)
      return json({ error: "Email request is unavailable" }, 409);
    let accepted = false;
    try {
      const signed = await signSesRequest(config, payload, now());
      const response = await fetchImpl(signed.url, {
        method: signed.method,
        headers: signed.headers,
        body: signed.body,
        signal: AbortSignal.timeout(10000),
        redirect: "error",
      });
      accepted = response.ok;
      // Error bodies may contain recipient data. Neither return nor log them.
      await response.body?.cancel();
    } catch {
      /* A timeout can follow an accepted send; never replay this requestId. */
    }
    try {
      await finish(payload.requestId, accepted);
    } catch {
      return json({ error: "Email dispatch could not be confirmed" }, 503);
    }
    return accepted
      ? json({ accepted: true })
      : json({ error: "Email dispatch could not be confirmed" }, 502);
  };
}

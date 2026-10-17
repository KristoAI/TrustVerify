import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { Encoder } from "cbor-x";
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from "@simplewebauthn/server";
test("software authenticator registration and login reject wrong origin, challenge, RP and counter", async () => {
  const encoder = new Encoder({ useRecords: false, useTag259ForMaps: false }),
    encode = (v) => Buffer.from(encoder.encode(v)),
    origin = "http://localhost:3300",
    rpID = "localhost";
  const options = await generateRegistrationOptions({
    rpName: "TrustBunny",
    rpID,
    userName: "fixture",
    userID: crypto.randomBytes(32),
    attestationType: "none",
    authenticatorSelection: {
      residentKey: "required",
      userVerification: "required",
    },
  });
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", {
      namedCurve: "prime256v1",
    }),
    jwk = publicKey.export({ format: "jwk" }),
    id = crypto.randomBytes(32),
    cose = encode(
      new Map([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, Buffer.from(jwk.x, "base64url")],
        [-3, Buffer.from(jwk.y, "base64url")],
      ]),
    ),
    rpHash = crypto.createHash("sha256").update(rpID).digest(),
    len = Buffer.alloc(2);
  len.writeUInt16BE(id.length);
  const authData = Buffer.concat([
      rpHash,
      Buffer.from([0x45]),
      Buffer.alloc(4),
      Buffer.alloc(16),
      len,
      id,
      cose,
    ]),
    clientData = Buffer.from(
      JSON.stringify({
        type: "webauthn.create",
        challenge: options.challenge,
        origin,
        crossOrigin: false,
      }),
    );
  const response = {
    id: id.toString("base64url"),
    rawId: id.toString("base64url"),
    type: "public-key",
    response: {
      clientDataJSON: clientData.toString("base64url"),
      attestationObject: encode(
        new Map([
          ["fmt", "none"],
          ["attStmt", new Map()],
          ["authData", authData],
        ]),
      ).toString("base64url"),
      transports: ["internal"],
    },
    clientExtensionResults: {},
  };
  const expected = {
    response,
    expectedChallenge: options.challenge,
    expectedOrigin: origin,
    expectedRPID: rpID,
    requireUserVerification: true,
  };
  const registration = await verifyRegistrationResponse(expected);
  assert.equal(registration.verified, true);
  await assert.rejects(
    verifyRegistrationResponse({
      ...expected,
      expectedOrigin: "https://evil.example",
    }),
  );
  await assert.rejects(
    verifyRegistrationResponse({ ...expected, expectedChallenge: "wrong" }),
  );
  await assert.rejects(
    verifyRegistrationResponse({ ...expected, expectedRPID: "evil.example" }),
  );
  const login = await generateAuthenticationOptions({
      rpID,
      userVerification: "required",
    }),
    cd = Buffer.from(
      JSON.stringify({
        type: "webauthn.get",
        challenge: login.challenge,
        origin,
        crossOrigin: false,
      }),
    ),
    ad = Buffer.concat([rpHash, Buffer.from([5]), Buffer.from([0, 0, 0, 1])]),
    sig = crypto.sign(
      "sha256",
      Buffer.concat([ad, crypto.createHash("sha256").update(cd).digest()]),
      privateKey,
    ),
    authResponse = {
      id: response.id,
      rawId: response.id,
      type: "public-key",
      response: {
        clientDataJSON: cd.toString("base64url"),
        authenticatorData: ad.toString("base64url"),
        signature: sig.toString("base64url"),
        userHandle: options.user.id,
      },
      clientExtensionResults: {},
    },
    credential = registration.registrationInfo.credential;
  const authExpected = {
    response: authResponse,
    expectedChallenge: login.challenge,
    expectedOrigin: origin,
    expectedRPID: rpID,
    requireUserVerification: true,
    credential,
  };
  assert.equal(
    (await verifyAuthenticationResponse(authExpected)).verified,
    true,
  );
  await assert.rejects(
    verifyAuthenticationResponse({
      ...authExpected,
      expectedOrigin: "https://evil.example",
    }),
  );
  await assert.rejects(
    verifyAuthenticationResponse({
      ...authExpected,
      expectedChallenge: "wrong",
    }),
  );
  await assert.rejects(
    verifyAuthenticationResponse({
      ...authExpected,
      credential: { ...credential, counter: 1 },
    }),
  );
});

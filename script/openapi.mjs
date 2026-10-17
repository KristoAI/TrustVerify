import fs from "node:fs/promises";
const string = { type: "string" },
  uuid = { type: "string", format: "uuid" },
  result = {
    type: "object",
    properties: {
      session_id: uuid,
      site_id: uuid,
      status: {
        enum: ["created", "in_progress", "completed", "expired", "cancelled"],
      },
      outcome: { enum: ["passed", "not_passed", "inconclusive", null] },
      environment: { enum: ["test", "live"] },
      age_over: { type: "integer", minimum: 18, maximum: 99 },
      method: { enum: ["selfie", "document", null] },
      assurance: { const: "browser_asserted" },
      source: { enum: ["browser", "reused", null] },
      verified_at: { type: ["string", "null"], format: "date-time" },
      valid_until: { type: ["string", "null"], format: "date-time" },
      valid: { type: "boolean" },
    },
  };
const json = (schema) => ({ "application/json": { schema } }),
  response = (description, schema) => ({ description, content: json(schema) }),
  body = (required, properties) => ({
    required: true,
    content: json({
      type: "object",
      additionalProperties: false,
      required,
      properties,
    }),
  }),
  state = {
    type: "string",
    minLength: 22,
    maxLength: 128,
    pattern: "^[a-zA-Z0-9_-]+$",
  },
  error = { type: "object", properties: { error: string } };
const doc = {
  openapi: "3.1.0",
  info: {
    title: "TrustBunny API",
    version: "1.0.0",
    description:
      "Browser-asserted age-check transport. Images, DOB, exact ages, and OCR text are not accepted. Use your configured TrustBunny origin as the server URL.",
  },
  servers: [
    {
      url: "http://localhost:3300",
      description: "Local development; replace for your deployment",
    },
  ],
  components: {
    securitySchemes: {
      serverKey: {
        type: "http",
        scheme: "bearer",
        description:
          "Site-scoped server API key. Never expose in browser JavaScript.",
      },
    },
    schemas: { VerificationResult: result, Error: error },
  },
  security: [{ serverKey: [] }],
  paths: {
    "/v1/verification-sessions": {
      post: {
        summary: "Create a verification session",
        parameters: [
          {
            in: "header",
            name: "Idempotency-Key",
            required: true,
            schema: { type: "string", minLength: 8, maxLength: 128 },
          },
        ],
        requestBody: body(["state"], {
          state,
          response_mode: { enum: ["assertion", "code"], default: "assertion" },
        }),
        responses: {
          201: response("Session created", {
            type: "object",
            properties: {
              session_id: uuid,
              verification_url: { type: "string", format: "uri" },
              expires_at: { type: "string", format: "date-time" },
              environment: { enum: ["test", "live"] },
            },
          }),
          400: response("Invalid input", error),
          401: response("Invalid API key", error),
          409: response("Idempotency conflict", error),
        },
      },
    },
    "/v1/verification-sessions/{id}": {
      get: {
        summary: "Check the current result and validity",
        parameters: [{ in: "path", name: "id", required: true, schema: uuid }],
        responses: {
          200: response("Current verification result", {
            allOf: [
              { $ref: "#/components/schemas/VerificationResult" },
              {
                type: "object",
                properties: {
                  delivery_status: {
                    enum: [
                      "not_configured",
                      "pending",
                      "processing",
                      "delivered",
                      "failed",
                    ],
                  },
                },
              },
            ],
          }),
          401: response("Invalid API key", error),
          404: response("Session not found for this site", error),
        },
      },
    },
    "/v1/result-exchanges": {
      post: {
        summary: "Exchange a one-time result code",
        requestBody: body(["code", "state"], {
          code: { type: "string", minLength: 20, maxLength: 200 },
          state,
        }),
        responses: {
          200: response("Result and current validity", {
            $ref: "#/components/schemas/VerificationResult",
          }),
          401: response(
            "Invalid, expired, consumed, or mismatched code",
            error,
          ),
          409: response("Code consumed concurrently", error),
        },
      },
    },
    "/.well-known/jwks.json": {
      get: {
        summary: "Public ES256 verification keys",
        security: [],
        responses: {
          200: response("JSON Web Key Set", {
            type: "object",
            properties: { keys: { type: "array", items: { type: "object" } } },
          }),
        },
      },
    },
  },
};
await fs.writeFile("public/openapi.json", JSON.stringify(doc, null, 2) + "\n");

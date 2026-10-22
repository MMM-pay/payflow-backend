/**
 * The OpenAPI description of the REST API.
 *
 * The frontend and any third-party developer read the API from the README
 * today. A machine-readable description is better: a client can be
 * generated from it, and a test can compare it with the routes Express
 * actually serves, so a route cannot quietly fall out of the documentation.
 *
 * The document is written by hand rather than derived from the handlers.
 * Deriving it would mean either a framework (a heavy dependency for a service
 * that deliberately has few) or reflection over the route table (which
 * describes the paths but not what they mean). A hand-written document says
 * what a caller needs to know — that an amount is a decimal string in the
 * token's smallest unit, that `limit` is capped, that a `404` means "no such
 * id" — and the test in `test/openapi.test.ts` keeps it honest.
 *
 * Every path the service serves is listed, including the ones an operator
 * enables (`/admin/*`, `/metrics`): the document describes the API surface,
 * and each conditional route says in its description what has to be true for
 * it to answer.
 */

/** A JSON schema, only as far as this document uses one. */
export interface SchemaObject {
  type?: string | string[];
  format?: string;
  description?: string;
  pattern?: string;
  example?: unknown;
  examples?: unknown[];
  enum?: unknown[];
  items?: SchemaObject;
  properties?: Record<string, SchemaObject>;
  required?: string[];
  additionalProperties?: boolean | SchemaObject;
  /** A schema that must satisfy every listed schema. */
  allOf?: SchemaObject[];
  $ref?: string;
  minimum?: number;
  maximum?: number;
  default?: unknown;
}

/** A path, query or header parameter. */
export interface ParameterObject {
  name: string;
  in: "path" | "query" | "header";
  required?: boolean;
  description?: string;
  schema: SchemaObject;
}

/** One response of an operation. */
export interface ResponseObject {
  description: string;
  content?: Record<string, { schema: SchemaObject }>;
}

/** One operation (a method on a path). */
export interface OperationObject {
  tags: string[];
  summary: string;
  description?: string;
  operationId: string;
  parameters?: ParameterObject[];
  /** The security schemes the operation needs; empty means it is open. */
  security?: { [scheme: string]: string[] }[];
  requestBody?: {
    required?: boolean;
    content: Record<string, { schema: SchemaObject }>;
  };
  responses: Record<string, ResponseObject>;
}

/** The methods a path answers. */
export type PathItemObject = Record<string, OperationObject>;

/** The document, as OpenAPI 3.1 describes it. */
export interface OpenApiDocument {
  openapi: string;
  info: {
    title: string;
    version: string;
    summary?: string;
    description?: string;
    license?: { name: string; identifier?: string };
  };
  servers?: { url: string; description?: string }[];
  tags?: { name: string; description?: string }[];
  externalDocs?: { url: string; description?: string };
  paths: Record<string, PathItemObject>;
  components?: {
    schemas?: Record<string, SchemaObject>;
    securitySchemes?: Record<string, { type: string; scheme?: string; description?: string }>;
  };
}

/** The API version, as `package.json` has it. */
const API_VERSION = "0.2.0";

/**
 * The API changelog, which also carries the deprecation policy.
 *
 * It is linked from the document's `externalDocs` so a generated client keeps
 * a pointer to it: a caller can see what changed between the version it was
 * built against and the one it calls, and how long a deprecated field or
 * route keeps working.
 */
const API_CHANGELOG_URL = "https://github.com/MMM-pay/payflow-backend/blob/main/API_CHANGELOG.md";

/** How the document is mounted and what it may mention. */
export interface OpenApiOptions {
  /**
   * The networks this instance serves, by name. Each one is reachable under
   * `/api/<name>/...` beside the default network's unprefixed paths.
   */
  networks: string[];
}

const AMOUNT_DESCRIPTION =
  "Decimal string in the token's smallest unit (stroops for XLM). Never a JSON number, so no precision is lost.";

const ADDRESS_DESCRIPTION =
  "A Stellar address: an account (G...) or a contract (C...). The checksum is checked.";

/** `$ref` to the shared amount schema. */
const amount = (): SchemaObject => ({ $ref: "#/components/schemas/AmountString" });

/** A decimal string in the token's smallest unit. */
const amountSchema = (): SchemaObject => ({
  type: "string",
  pattern: "^[0-9]+$",
  description: AMOUNT_DESCRIPTION,
  examples: ["10000000"],
});

/** A query parameter holding a page size. */
const limitParameter = (): ParameterObject => ({
  name: "limit",
  in: "query",
  required: false,
  description: "How many rows to return. Capped at 200; a larger value is not an error.",
  schema: { type: "integer", minimum: 1, maximum: 200, default: 50 },
});

/** A query parameter holding a number of days. */
const daysParameter = (): ParameterObject => ({
  name: "days",
  in: "query",
  required: false,
  description: "How many days into the future to project. Capped at 365.",
  schema: { type: "integer", minimum: 1, maximum: 365, default: 30 },
});

/** A query parameter holding a calendar bucket size. */
const bucketParameter = (): ParameterObject => ({
  name: "bucket",
  in: "query",
  required: false,
  description: "The calendar period the report is grouped by.",
  schema: { type: "string", enum: ["day", "week", "month"], default: "month" },
});

/** A query parameter holding a merchant address. */
const merchantParameter = (): ParameterObject => ({
  name: "merchant",
  in: "query",
  required: false,
  description: "Only rows belonging to this merchant.",
  schema: { type: "string", description: ADDRESS_DESCRIPTION },
});

/** An opaque cursor from a previous page's `nextCursor`; fetch the page after it. */
const cursorParameter = (): ParameterObject => ({
  name: "cursor",
  in: "query",
  required: false,
  description:
    "Opaque cursor returned by a previous page. Page by primary key, not by offset; null on the final page.",
  schema: { type: "string" },
});

/** A query parameter holding a subscriber address. */
const subscriberParameter = (): ParameterObject => ({
  name: "subscriber",
  in: "query",
  required: false,
  description: "Only rows belonging to this subscriber.",
  schema: { type: "string", description: ADDRESS_DESCRIPTION },
});

/** A path parameter holding a plan or mandate id. */
const idParameter = (name = "id"): ParameterObject => ({
  name,
  in: "path",
  required: true,
  description: "The on-chain id of the plan or mandate.",
  schema: { type: "integer", minimum: 1 },
});

/** A path parameter holding an address. */
const addressParameter = (name = "address"): ParameterObject => ({
  name,
  in: "path",
  required: true,
  description: "The account or contract the report is about.",
  schema: { type: "string", description: ADDRESS_DESCRIPTION },
});

/** The structured error envelope every non-2xx response uses. */
const errorResponse = (description: string): ResponseObject => ({
  description,
  content: {
    "application/json": {
      schema: { $ref: "#/components/schemas/Error" },
    },
  },
});

/** The standard "not found" answer of an id-bearing route. */
const notFound = (code: string, what: string): ResponseObject =>
  errorResponse(`No ${what} exists with that id (error.code = "${code}").`);

/** The standard "bad parameter" answer. */
const invalidRequest = (): ResponseObject =>
  errorResponse(
    'A query or path parameter is not valid; error.code = "invalid_request" and error.details names the parameter.',
  );

/** How a merchant-only route is authorised, for its description. */
const MERCHANT_PROOF = (message: string): string =>
  `The caller proves control of the merchant address with an ed25519 signature over \`${message}\` (\`merchant\`, \`timestamp\`, \`signature\`), or with a SEP-10 JWT from \`/api/auth\` as \`Authorization: Bearer <token>\`, in which case \`merchant\` is the token's account and may be omitted.`;

/** The `{ merchant, timestamp, signature }` proof of a merchant-only POST. */
const merchantProofBody = (message: string): NonNullable<OperationObject["requestBody"]> => ({
  required: false,
  content: {
    "application/json": {
      schema: {
        type: "object",
        description: `Omitted under a SEP-10 bearer token. The signature is over \`${message}\`.`,
        properties: {
          merchant: { type: "string", description: ADDRESS_DESCRIPTION },
          timestamp: { type: "integer", description: "Unix seconds. Signatures older than ten minutes are refused." },
          signature: { type: "string", description: `Base64-encoded ed25519 signature of \`${message}\`.` },
        },
      },
    },
  },
});

/** The same proof, as query parameters of a merchant-only GET. */
const merchantProofQuery = (message: string): ParameterObject[] => [
  { name: "merchant", in: "query", required: false, description: ADDRESS_DESCRIPTION, schema: { type: "string" } },
  {
    name: "timestamp",
    in: "query",
    required: false,
    description: "Unix seconds. Signatures older than ten minutes are refused.",
    schema: { type: "integer", minimum: 0 },
  },
  {
    name: "signature",
    in: "query",
    required: false,
    description: `Base64-encoded ed25519 signature of \`${message}\`. All three are required without a bearer token.`,
    schema: { type: "string" },
  },
];

/** A path parameter holding a webhook id. */
const webhookIdParameter = (): ParameterObject => ({
  name: "id",
  in: "path",
  required: true,
  description: "The webhook id returned at registration.",
  schema: { type: "integer", minimum: 1 },
});

const unauthorizedProof = (): ResponseObject =>
  errorResponse('The signature is wrong, malformed or older than ten minutes, or the bearer token is invalid or expired (error.code = "unauthorized").');

/**
 * The paths of the read API, mounted under `root`.
 *
 * `root` is `/api` for the default network and `/api/<name>` for every extra
 * network the instance serves.
 */
function apiPaths(root: string): Record<string, PathItemObject> {
  const p = (path: string): string => `${root}${path}`;
  return {
    [p("/plans")]: {
      get: {
        tags: ["plans"],
        summary: "List published plans",
        description:
          "Plans a merchant has published, newest first. Each amount is a decimal string in the plan's token's smallest unit.",
        operationId: `listPlans${operationSuffix(root)}`,
        parameters: [merchantParameter(), cursorParameter(), limitParameter()],
        responses: {
          "200": {
            description: "The plans.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    plans: { type: "array", items: { $ref: "#/components/schemas/Plan" } },
                    nextCursor: {
                      type: ["string", "null"],
                      description:
                        "Opaque cursor to fetch the next page; null when this is the final page.",
                    },
                  },
                  required: ["plans", "nextCursor"],
                },
              },
            },
          },
          "400": invalidRequest(),
          "429": errorResponse('The per-IP rate limit was reached (error.code = "rate_limited").'),
        },
      },
    },
    [p("/plans/{id}")]: {
      get: {
        tags: ["plans"],
        summary: "One plan",
        operationId: `getPlan${operationSuffix(root)}`,
        parameters: [idParameter()],
        responses: {
          "200": {
            description: "The plan.",
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/Plan" } },
            },
          },
          "400": invalidRequest(),
          "404": notFound("plan_not_found", "plan"),
        },
      },
    },
    [p("/plans/{id}/stats")]: {
      get: {
        tags: ["plans"],
        summary: "Statistics for one plan",
        description:
          "Active and total mandates, cancellations, the gross amount collected and the average number of settled charges per mandate.",
        operationId: `getPlanStats${operationSuffix(root)}`,
        parameters: [idParameter()],
        responses: {
          "200": {
            description: "The plan's statistics.",
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/PlanStats" } },
            },
          },
          "400": invalidRequest(),
          "404": notFound("plan_not_found", "plan"),
        },
      },
    },
    [p("/mandates")]: {
      get: {
        tags: ["mandates"],
        summary: "List mandates",
        description:
          "Mandates, newest first. The filters can be combined; an empty value means \"no filter\".",
        operationId: `listMandates${operationSuffix(root)}`,
        parameters: [
          {
            name: "ids",
            in: "query",
            required: false,
            description:
              "A comma-separated batch of at most 100 mandate ids. Ids that do not exist are omitted.",
            schema: { type: "string" },
          },
          subscriberParameter(),
          merchantParameter(),
          {
            name: "status",
            in: "query",
            required: false,
            description: "Only mandates in this state.",
            schema: { type: "string", enum: ["Active", "Paused", "Cancelled", "Completed"] },
          },
          cursorParameter(),
          limitParameter(),
        ],
        responses: {
          "200": {
            description: "The mandates.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    mandates: { type: "array", items: { $ref: "#/components/schemas/Mandate" } },
                    nextCursor: {
                      type: ["string", "null"],
                      description:
                        "Opaque cursor to fetch the next page; null when this is the final page.",
                    },
                  },
                  required: ["mandates", "nextCursor"],
                },
              },
            },
          },
          "400": errorResponse(
            'A malformed id list (error.code = "invalid_ids") or an invalid parameter (error.code = "invalid_request").',
          ),
        },
      },
    },
    [p("/mandates/{id}")]: {
      get: {
        tags: ["mandates"],
        summary: "One mandate",
        operationId: `getMandate${operationSuffix(root)}`,
        parameters: [idParameter()],
        responses: {
          "200": {
            description: "The mandate.",
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/Mandate" } },
            },
          },
          "400": invalidRequest(),
          "404": notFound("mandate_not_found", "mandate"),
        },
      },
    },
    [p("/mandates/{id}/timeline")]: {
      get: {
        tags: ["mandates"],
        summary: "A mandate's complete lifecycle timeline",
        description: "Subscription, charge, pause/resume, cancellation, ending and completion events in ascending ledger order. Amounts and fees are decimal strings.",
        operationId: `listMandateTimeline${operationSuffix(root)}`,
        parameters: [idParameter()],
        responses: {
          "200": {
            description: "The mandate's ordered lifecycle events.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    events: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          mandateId: { type: "integer" },
                          txHash: { type: "string" },
                          kind: { type: "string", enum: ["subscribed", "charged", "pause_changed", "cancelled", "mandate_ended", "mandate_completed"] },
                          ledger: { type: "integer" },
                          at: { type: ["integer", "null"], description: "Ledger close time in Unix seconds." },
                          details: { type: "object", additionalProperties: { type: ["string", "boolean"] } },
                        },
                        required: ["mandateId", "txHash", "kind", "ledger", "at", "details"],
                      },
                    },
                  },
                  required: ["events"],
                },
              },
            },
          },
          "400": invalidRequest(),
          "404": notFound("mandate_not_found", "mandate"),
        },
      },
    },
    [p("/mandates/{id}/charges")]: {
      get: {
        tags: ["mandates"],
        summary: "A mandate's settlement history",
        description: "The charges settled for this mandate, newest first.",
        operationId: `listMandateCharges${operationSuffix(root)}`,
        parameters: [idParameter(), limitParameter()],
        responses: {
          "200": {
            description: "The charges.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    charges: { type: "array", items: { $ref: "#/components/schemas/Charge" } },
                  },
                  required: ["charges"],
                },
              },
            },
          },
          "400": invalidRequest(),
          "404": notFound("mandate_not_found", "mandate"),
        },
      },
    },
    [p("/webhooks")]: {
      post: {
        tags: ["webhooks"],
        summary: "Register a webhook for charge events",
        description:
          "Registers a URL to receive signed POSTs when one of the merchant's mandates charges. The caller proves control of the merchant's Stellar address with an ed25519 signature over `payflow-webhook:v1:<merchant>:<url>:<timestamp>`; the returned secret is used to verify the `Payflow-Signature` header on deliveries.",
        operationId: `registerWebhook${operationSuffix(root)}`,
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/WebhookRegistrationRequest" },
            },
          },
        },
        responses: {
          "200": {
            description: "The webhook registration, including its HMAC signing secret.",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/Webhook" },
              },
            },
          },
          "400": invalidRequest(),
          "429": errorResponse('The per-IP rate limit was reached (error.code = "rate_limited").'),
        },
      },
      get: {
        tags: ["webhooks"],
        summary: "List a merchant's webhooks",
        description:
          "The merchant's registered webhooks, newest first, including ones that gave up after failed deliveries. Secrets are never returned, only their last four characters. The caller proves control of the merchant address with an ed25519 signature over `payflow-webhook-list:v1:<merchant>:<timestamp>`.",
        operationId: `listWebhooks${operationSuffix(root)}`,
        parameters: [
          {
            name: "merchant",
            in: "query",
            required: true,
            description: ADDRESS_DESCRIPTION,
            schema: { type: "string" },
          },
          {
            name: "timestamp",
            in: "query",
            required: true,
            description: "Unix seconds. Signatures older than ten minutes are refused.",
            schema: { type: "integer", minimum: 0 },
          },
          {
            name: "signature",
            in: "query",
            required: true,
            description: "Base64-encoded ed25519 signature of `payflow-webhook-list:v1:<merchant>:<timestamp>`.",
            schema: { type: "string" },
          },
        ],
        responses: {
          "200": {
            description: "The merchant's webhooks.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    merchant: { type: "string", description: ADDRESS_DESCRIPTION },
                    webhooks: { type: "array", items: { $ref: "#/components/schemas/WebhookSummary" } },
                  },
                  required: ["merchant", "webhooks"],
                },
              },
            },
          },
          "400": invalidRequest(),
          "401": errorResponse('The signature is wrong, malformed or older than ten minutes (error.code = "unauthorized").'),
        },
      },
    },
    [p("/webhooks/{id}")]: {
      delete: {
        tags: ["webhooks"],
        summary: "Delete a webhook",
        description:
          "Removes one of the merchant's webhooks: it receives no further deliveries, and retries already scheduled are dropped. The caller proves control of the merchant address with an ed25519 signature over `payflow-webhook-delete:v1:<merchant>:<id>:<timestamp>`, sent as a JSON body or, for clients that cannot send a DELETE body, as `merchant`, `timestamp` and `signature` query parameters.",
        operationId: `deleteWebhook${operationSuffix(root)}`,
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            description: "The webhook id returned at registration.",
            schema: { type: "integer", minimum: 1 },
          },
        ],
        requestBody: {
          required: false,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/WebhookDeleteRequest" },
            },
          },
        },
        responses: {
          "204": { description: "The webhook was deleted." },
          "400": invalidRequest(),
          "401": errorResponse('The signature is wrong, malformed or older than ten minutes (error.code = "unauthorized").'),
          "404": errorResponse('No active webhook with that id belongs to the merchant (error.code = "not_found").'),
        },
      },
    },
    [p("/webhooks/{id}/rotate")]: {
      post: {
        tags: ["webhooks"],
        summary: "Rotate a webhook's signing secret",
        description:
          "Replaces the webhook's HMAC secret and returns the new one, this once. Until `previousSecretExpiresAt` (WEBHOOK_SECRET_OVERLAP_S after the rotation) every delivery carries two signatures, `Payflow-Signature: sha256=<new>, sha256=<old>`, so the receiver can switch secrets without missing a delivery; afterwards only the new secret signs. " +
          MERCHANT_PROOF("payflow-webhook-rotate:v1:<merchant>:<id>:<timestamp>"),
        operationId: `rotateWebhookSecret${operationSuffix(root)}`,
        parameters: [webhookIdParameter()],
        requestBody: merchantProofBody("payflow-webhook-rotate:v1:<merchant>:<id>:<timestamp>"),
        responses: {
          "200": {
            description: "The new secret.",
            content: { "application/json": { schema: { $ref: "#/components/schemas/WebhookRotation" } } },
          },
          "400": invalidRequest(),
          "401": unauthorizedProof(),
          "404": errorResponse('No active webhook with that id belongs to the merchant (error.code = "not_found").'),
        },
      },
    },
    [p("/webhooks/{id}/test")]: {
      post: {
        tags: ["webhooks"],
        summary: "Send a webhook a test event",
        description:
          "Delivers `{ \"event\": \"ping\", \"webhook_id\", \"merchant\" }` through the normal delivery path — the same headers and signatures as a charge, and the same backoff retries when it fails — and answers with the first attempt's outcome. " +
          MERCHANT_PROOF("payflow-webhook-test:v1:<merchant>:<id>:<timestamp>"),
        operationId: `testWebhook${operationSuffix(root)}`,
        parameters: [webhookIdParameter()],
        requestBody: merchantProofBody("payflow-webhook-test:v1:<merchant>:<id>:<timestamp>"),
        responses: {
          "200": {
            description: "How the first attempt went; a failed one is `pending` with its retry time.",
            content: { "application/json": { schema: { $ref: "#/components/schemas/WebhookTestResult" } } },
          },
          "400": invalidRequest(),
          "401": unauthorizedProof(),
          "404": errorResponse('No webhook with that id is receiving deliveries for the merchant (error.code = "not_found").'),
        },
      },
    },
    [p("/webhooks/{id}/deliveries")]: {
      get: {
        tags: ["webhooks"],
        summary: "A webhook's delivery history",
        description:
          "The webhook's last 100 delivery attempts, newest first; a delivery that failed and was retried shows every attempt. A deleted webhook keeps its history. " +
          MERCHANT_PROOF("payflow-webhook-deliveries:v1:<merchant>:<id>:<timestamp>"),
        operationId: `listWebhookDeliveries${operationSuffix(root)}`,
        parameters: [webhookIdParameter(), ...merchantProofQuery("payflow-webhook-deliveries:v1:<merchant>:<id>:<timestamp>")],
        responses: {
          "200": {
            description: "The attempts.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    webhookId: { type: "integer" },
                    deliveries: { type: "array", items: { $ref: "#/components/schemas/WebhookDelivery" } },
                  },
                  required: ["webhookId", "deliveries"],
                },
              },
            },
          },
          "400": invalidRequest(),
          "401": unauthorizedProof(),
          "404": errorResponse('No webhook with that id belongs to the merchant (error.code = "not_found").'),
        },
      },
    },
    [p("/auth")]: {
      get: {
        tags: ["auth"],
        summary: "SEP-10 challenge",
        description:
          "A SEP-10 challenge transaction for `account` to sign: sequence number 0, the server account as source, fifteen-minute time bounds, a `<home domain> auth` manage data operation with the account as source and a random nonce, and a `web_auth_domain` operation, signed by the server. `memo` and muxed accounts are not supported; `client_domain` is ignored. Only served when SEP10_SIGNING_KEY is set; every response carries `Access-Control-Allow-Origin: *`.",
        operationId: `getAuthChallenge${operationSuffix(root)}`,
        parameters: [
          { name: "account", in: "query", required: true, description: "The Stellar account (G...) signing in.", schema: { type: "string" } },
          { name: "home_domain", in: "query", required: false, description: "Must be the configured home domain when given.", schema: { type: "string" } },
        ],
        responses: {
          "200": {
            description: "The challenge.",
            content: { "application/json": { schema: { $ref: "#/components/schemas/AuthChallenge" } } },
          },
          "400": invalidRequest(),
        },
      },
      post: {
        tags: ["auth"],
        summary: "Exchange a signed SEP-10 challenge for a JWT",
        description:
          "Verifies the client-signed challenge — the server's signature, time bounds, home and web auth domains, and the client signatures: an existing account's signers must meet its medium threshold, an account not on the network must sign with its master key — and returns a short-lived HS256 JWT (`iss`, `sub`, `iat`, `exp`, `jti`). Each challenge yields one token. Accepts JSON or `application/x-www-form-urlencoded`.",
        operationId: `getAuthToken${operationSuffix(root)}`,
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: { transaction: { type: "string", description: "The signed challenge, base64 XDR." } },
                required: ["transaction"],
              },
            },
          },
        },
        responses: {
          "200": {
            description: "The token.",
            content: { "application/json": { schema: { $ref: "#/components/schemas/AuthToken" } } },
          },
          "400": errorResponse('The challenge is malformed, expired, already used, not this server\'s, or not signed with enough weight (error.code = "invalid_request").'),
        },
      },
    },
    [p("/due")]: {
      get: {
        tags: ["keeper"],
        summary: "Mandates that can be charged right now",
        description:
          "Active mandates whose next charge has come due. `funded` says whether the last known vault balance covers the charge, so a caller can tell a mandate that is merely due from one the keeper would skip.",
        operationId: `listDueMandates${operationSuffix(root)}`,
        parameters: [limitParameter()],
        responses: {
          "200": {
            description: "The due mandates.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    now: { type: "integer", description: "The instant the list was built, in unix seconds." },
                    due: { type: "array", items: { $ref: "#/components/schemas/DueMandate" } },
                  },
                  required: ["now", "due"],
                },
              },
            },
          },
          "400": invalidRequest(),
        },
      },
    },
    [p("/merchants/{address}/summary")]: {
      get: {
        tags: ["merchants"],
        summary: "A merchant's summary",
        description:
          "Active mandates, the gross amount collected, the charge count, MRR and ARR, and the same revenue broken down per token.",
        operationId: `getMerchantSummary${operationSuffix(root)}`,
        parameters: [addressParameter()],
        responses: {
          "200": {
            description: "The merchant's summary.",
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/MerchantSummary" } },
            },
          },
          "400": invalidRequest(),
        },
      },
    },
    [p("/merchants/{address}/subscribers")]: {
      get: {
        tags: ["merchants"],
        summary: "A merchant's subscribers",
        description: "The merchant's distinct subscribers, grouped by lifetime value.",
        operationId: `listMerchantSubscribers${operationSuffix(root)}`,
        parameters: [addressParameter(), limitParameter()],
        responses: {
          "200": {
            description: "The subscribers.",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/MerchantSubscribers" },
              },
            },
          },
          "400": invalidRequest(),
        },
      },
    },
    [p("/merchants/{address}/churn")]: {
      get: {
        tags: ["merchants"],
        summary: "A merchant's churn",
        description:
          "How the mandate base moved over time: mandates started, cancelled by the subscriber, ended by the merchant and completed, plus the net, per calendar bucket.",
        operationId: `getMerchantChurn${operationSuffix(root)}`,
        parameters: [addressParameter(), bucketParameter(), limitParameter()],
        responses: {
          "200": {
            description: "The churn report.",
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/MerchantChurn" } },
            },
          },
          "400": invalidRequest(),
        },
      },
    },
    [p("/merchants/{address}/revenue")]: {
      get: {
        tags: ["merchants"],
        summary: "A merchant's revenue over time",
        description:
          "What the merchant took in, what the protocol took and what was left, per calendar bucket. The range is half-open: a charge exactly at `to` is excluded.",
        operationId: `getMerchantRevenue${operationSuffix(root)}`,
        parameters: [
          addressParameter(),
          bucketParameter(),
          {
            name: "from",
            in: "query",
            required: false,
            description: "Start of the range, in unix seconds. Unbounded when absent.",
            schema: { type: "integer", minimum: 0 },
          },
          {
            name: "to",
            in: "query",
            required: false,
            description: "End of the range (exclusive), in unix seconds. Unbounded when absent.",
            schema: { type: "integer", minimum: 0 },
          },
          limitParameter(),
        ],
        responses: {
          "200": {
            description: "The revenue report.",
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/MerchantRevenue" } },
            },
          },
          "400": invalidRequest(),
        },
      },
    },
    [p("/merchants/{address}/charges.csv")]: {
      get: {
        tags: ["merchants"],
        summary: "Export a merchant's charges as CSV",
        description:
          "Every settled charge for the merchant, oldest first, as a CSV download (`Content-Disposition: attachment`). Columns: `date` (ledger close time, ISO 8601 UTC), `mandate`, `subscriber`, `gross` (what the subscriber paid), `fee` (the protocol's share), `net` (what the merchant kept) and `tx_hash`. Amounts are in token units with seven decimals. The range is half-open: a charge exactly at `to` is excluded.",
        operationId: `exportMerchantCharges${operationSuffix(root)}`,
        parameters: [
          addressParameter(),
          {
            name: "from",
            in: "query",
            required: false,
            description: "Start of the range, in unix seconds. Unbounded when absent.",
            schema: { type: "integer", minimum: 0 },
          },
          {
            name: "to",
            in: "query",
            required: false,
            description: "End of the range (exclusive), in unix seconds. Unbounded when absent.",
            schema: { type: "integer", minimum: 0 },
          },
        ],
        responses: {
          "200": {
            description: "The charges, one per row after a header row.",
            content: { "text/csv": { schema: { type: "string" } } },
          },
          "400": invalidRequest(),
        },
      },
    },
    [p("/merchants/{address}/forecast")]: {
      get: {
        tags: ["merchants"],
        summary: "A merchant's forecast",
        description:
          "What the merchant's active mandates will bring in over the next N days, net of the protocol fee. Vault funding is not modelled.",
        operationId: `getMerchantForecast${operationSuffix(root)}`,
        parameters: [addressParameter(), daysParameter()],
        responses: {
          "200": {
            description: "The forecast.",
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/Forecast" } },
            },
          },
          "400": invalidRequest(),
        },
      },
    },
    [p("/subscribers/{address}/summary")]: {
      get: {
        tags: ["subscribers"],
        summary: "A subscriber's summary",
        description: "The subscriber's mandates and the gross total paid.",
        operationId: `getSubscriberSummary${operationSuffix(root)}`,
        parameters: [addressParameter()],
        responses: {
          "200": {
            description: "The subscriber's summary.",
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/SubscriberSummary" } },
            },
          },
          "400": invalidRequest(),
        },
      },
    },
    [p("/subscribers/{address}/upcoming")]: {
      get: {
        tags: ["subscribers"],
        summary: "A subscriber's upcoming charges",
        description:
          "The charges this subscriber will be billed over the next N days, with the instant each one falls due.",
        operationId: `getSubscriberUpcoming${operationSuffix(root)}`,
        parameters: [addressParameter(), daysParameter()],
        responses: {
          "200": {
            description: "The upcoming charges.",
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/UpcomingCharges" } },
            },
          },
          "400": invalidRequest(),
        },
      },
    },
    [p("/vault/{address}")]: {
      get: {
        tags: ["vault"],
        summary: "A subscriber's vault balances",
        description: "The latest indexed balance per token the address holds.",
        operationId: `getVaultBalances${operationSuffix(root)}`,
        parameters: [addressParameter()],
        responses: {
          "200": {
            description: "The balances.",
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/VaultBalances" } },
            },
          },
          "400": invalidRequest(),
        },
      },
    },
    [p("/vault/{address}/events")]: {
      get: {
        tags: ["vault"],
        summary: "A subscriber's vault history",
        description: "Deposits, withdrawals and debits, newest first.",
        operationId: `listVaultEvents${operationSuffix(root)}`,
        parameters: [addressParameter(), limitParameter()],
        responses: {
          "200": {
            description: "The vault events.",
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/VaultEvents" } },
            },
          },
          "400": invalidRequest(),
        },
      },
    },
    [p("/tokens/{id}")]: {
      get: {
        tags: ["tokens"],
        summary: "A token's metadata",
        description:
          "The symbol, name and decimals of a token contract, so an amount can be displayed with the right scale.",
        operationId: `getToken${operationSuffix(root)}`,
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            description: "The token's contract id, or `native` for the network's own asset.",
            schema: { type: "string" },
          },
        ],
        responses: {
          "200": {
            description: "The token's metadata.",
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/TokenMetadata" } },
            },
          },
          "400": errorResponse('The id is not a token contract id (error.code = "invalid_token_id").'),
          "502": errorResponse(
            'The token contract could not be read (error.code = "token_metadata_unavailable").',
          ),
        },
      },
    },
    [p("/protocol")]: {
      get: {
        tags: ["protocol"],
        summary: "The protocol fee",
        description: "The current fee in basis points and the history of fee changes.",
        operationId: `getProtocol${operationSuffix(root)}`,
        responses: {
          "200": {
            description: "The protocol fee and its history.",
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/Protocol" } },
            },
          },
        },
      },
    },
    [p("/stats")]: {
      get: {
        tags: ["stats"],
        summary: "Protocol-wide totals",
        description:
          "Counts of plans, mandates and charges, the gross volume over the last 24 hours and all time, the fees collected and the last indexed ledger.",
        operationId: `getStats${operationSuffix(root)}`,
        responses: {
          "200": {
            description: "The protocol totals.",
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/Stats" } },
            },
          },
        },
      },
    },
    [p("/stream")]: {
      get: {
        tags: ["stream"],
        summary: "Live subscription events",
        description:
          "A Server-Sent Events stream of `charged`, `subscribed`, `cancelled` and `mandate_ended` events, with a heartbeat every 25 seconds.",
        operationId: `streamEvents${operationSuffix(root)}`,
        parameters: [merchantParameter(), subscriberParameter()],
        responses: {
          "200": {
            description: "The event stream, in `text/event-stream` format.",
            content: { "text/event-stream": { schema: { type: "string" } } },
          },
          "400": invalidRequest(),
          "503": errorResponse(
            'The concurrent stream cap was reached (error.code = "stream_limit").',
          ),
        },
      },
    },
    [p("/keeper")]: {
      get: {
        tags: ["keeper"],
        summary: "The keeper's recent passes",
        description:
          "The last 20 keeper passes, their failures and the mandates backing off. Only present when the keeper is enabled (KEEPER_ENABLED=true).",
        operationId: `getKeeperHistory${operationSuffix(root)}`,
        responses: {
          "200": {
            description: "The pass history.",
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/KeeperHistory" } },
            },
          },
          "404": errorResponse("The keeper is not enabled, so this route does not exist."),
        },
      },
    },
  };
}

/**
 * A suffix that keeps the operation ids unique across the networks.
 *
 * The same route is served under `/api/...` and under `/api/<network>/...`;
 * OpenAPI operation ids must be unique within a document.
 */
function operationSuffix(root: string): string {
  if (root === "/api") return "";
  const name = root.split("/").filter(Boolean).pop() ?? "";
  if (name === "") return "";
  return `${name[0]!.toUpperCase()}${name.slice(1)}`;
}

/** The paths that do not belong to the read API. */
function servicePaths(): Record<string, PathItemObject> {
  return {
    "/health": {
      get: {
        tags: ["service"],
        summary: "Liveness and the projection's state",
        description:
          "Always answers 200, so a slow backfill does not get the service restarted. The body says whether the projection trails the network, how far behind it is and how fresh it is.",
        operationId: "getHealth",
        responses: {
          "200": {
            description: "The service's state.",
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/Health" } },
            },
          },
        },
      },
    },
    "/ready": {
      get: {
        tags: ["service"],
        summary: "Readiness",
        description:
          "Answers 200 once the projection trails the network by no more than 120 ledgers, and 503 (`starting` or `catching_up`) until then.",
        operationId: "getReady",
        responses: {
          "200": {
            description: "The service is ready.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    status: { type: "string", enum: ["ready"] },
                    lag: { type: ["integer", "null"], description: "Ledgers the projection trails the network by." },
                  },
                  required: ["status", "lag"],
                },
              },
            },
          },
          "503": {
            description: "The projection is not current yet.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    status: { type: "string", enum: ["starting", "catching_up"] },
                    lag: { type: ["integer", "null"] },
                  },
                  required: ["status", "lag"],
                },
              },
            },
          },
        },
      },
    },
    "/metrics": {
      get: {
        tags: ["service"],
        summary: "Prometheus metrics",
        description:
          "The service's counters and gauges in the Prometheus text format. Only present when METRICS_ENABLED=true.",
        operationId: "getMetrics",
        responses: {
          "200": {
            description: "The metrics, in the Prometheus text exposition format.",
            content: { "text/plain": { schema: { type: "string" } } },
          },
          "404": errorResponse("Metrics are not enabled, so this route does not exist."),
        },
      },
    },
    "/api/openapi.json": {
      get: {
        tags: ["service"],
        summary: "This document",
        description: "The OpenAPI 3.1 description of the REST API.",
        operationId: "getOpenApi",
        responses: {
          "200": {
            description: "The OpenAPI document.",
            content: {
              "application/json": {
                schema: { type: "object", description: "An OpenAPI 3.1 document." },
              },
            },
          },
        },
      },
    },
    "/admin/reindex": {
      post: {
        tags: ["admin"],
        summary: "Run one indexer pass now",
        description:
          "Runs an indexer pass immediately. Needs a bearer token, and is only present when ADMIN_TOKEN is set.",
        operationId: "postReindex",
        security: [{ bearerAuth: [] }],
        responses: {
          "200": {
            description: "The pass ran.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    status: { type: "string", enum: ["ok"] },
                    result: { type: ["object", "null"] },
                  },
                  required: ["status", "result"],
                },
              },
            },
          },
          "401": errorResponse('The bearer token is missing or wrong (error.code = "unauthorized").'),
          "503": errorResponse("This process has no indexer to run."),
          "500": errorResponse("The pass threw; the message is kept for the operator."),
        },
      },
    },
    "/admin/keeper/run": {
      post: {
        tags: ["admin"],
        summary: "Run one keeper pass now",
        description:
          "Runs a settlement pass immediately. Needs a bearer token, and is only present when ADMIN_TOKEN is set.",
        operationId: "postKeeperRun",
        security: [{ bearerAuth: [] }],
        responses: {
          "200": {
            description: "The pass ran.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    status: { type: "string", enum: ["ok"] },
                    result: { type: ["object", "null"] },
                  },
                  required: ["status", "result"],
                },
              },
            },
          },
          "401": errorResponse('The bearer token is missing or wrong (error.code = "unauthorized").'),
          "503": errorResponse("The keeper is not enabled."),
          "500": errorResponse("The pass threw; the message is kept for the operator."),
        },
      },
    },
    "/admin/keeper/backoff": {
      get: {
        tags: ["admin"],
        summary: "Mandates backing off",
        description:
          "The mandates whose last charge failed, with when they are tried again. Needs a bearer token, and is only present when ADMIN_TOKEN is set.",
        operationId: "getKeeperBackoff",
        security: [{ bearerAuth: [] }],
        responses: {
          "200": {
            description: "The backing-off mandates.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    status: { type: "string", enum: ["ok"] },
                    backoff: { type: "array", items: { type: "object" } },
                  },
                  required: ["status", "backoff"],
                },
              },
            },
          },
          "401": errorResponse('The bearer token is missing or wrong (error.code = "unauthorized").'),
          "503": errorResponse("The keeper is not enabled."),
        },
      },
    },
    "/admin/indexer/pause": {
      post: {
        tags: ["admin"],
        summary: "Hold the indexer back",
        description:
          "Makes each scheduled pass a no-op: no RPC reads, no writes, the cursor preserved. The API keeps serving. Needs a bearer token, and is only present when ADMIN_TOKEN is set.",
        operationId: "postIndexerPause",
        security: [{ bearerAuth: [] }],
        responses: {
          "200": {
            description: "The indexer is paused.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    status: { type: "string", enum: ["ok"] },
                    paused: { type: "boolean", enum: [true] },
                    result: { type: ["object", "null"] },
                  },
                  required: ["status", "paused", "result"],
                },
              },
            },
          },
          "401": errorResponse('The bearer token is missing or wrong (error.code = "unauthorized").'),
          "503": errorResponse("This process has no indexer to pause."),
        },
      },
    },
    "/admin/indexer/resume": {
      post: {
        tags: ["admin"],
        summary: "Let indexer passes run again",
        description:
          "Resumes the indexer after a pause; it continues from the cursor it kept. Needs a bearer token, and is only present when ADMIN_TOKEN is set.",
        operationId: "postIndexerResume",
        security: [{ bearerAuth: [] }],
        responses: {
          "200": {
            description: "The indexer is running again.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    status: { type: "string", enum: ["ok"] },
                    paused: { type: "boolean", enum: [false] },
                    result: { type: ["object", "null"] },
                  },
                  required: ["status", "paused", "result"],
                },
              },
            },
          },
          "401": errorResponse('The bearer token is missing or wrong (error.code = "unauthorized").'),
          "503": errorResponse("This process has no indexer to resume."),
        },
      },
    },
  };
}

/** The schemas the operations refer to. */
function componentSchemas(): Record<string, SchemaObject> {
  return {
    AmountString: amountSchema(),
    Error: {
      type: "object",
      description:
        "The structured error envelope every non-2xx response uses. `code` is stable per condition and safe to branch on; `message` is safe to display.",
      properties: {
        error: {
          type: "object",
          properties: {
            code: { type: "string", description: "A stable, machine-readable condition." },
            message: { type: "string", description: "Human-readable copy; never carries an internal detail." },
            requestId: {
              type: ["string", "null"],
              description: "The request's id, the same one the X-Request-Id header carries.",
            },
            details: {
              type: "array",
              description: "Present for invalid_request only: one entry per wrong parameter.",
              items: {
                type: "object",
                properties: {
                  path: { type: "string" },
                  message: { type: "string" },
                },
                required: ["path", "message"],
              },
            },
          },
          required: ["code", "message", "requestId"],
        },
      },
      required: ["error"],
    },
    TokenFields: {
      type: "object",
      description:
        "The token's symbol and decimals, joined onto a row's amounts. Both are null when the token contract could not be read; the amount stays a string in its own smallest unit either way.",
      properties: {
        tokenSymbol: { type: ["string", "null"] },
        decimals: { type: ["integer", "null"] },
      },
    },
    Plan: {
      allOf: [
        { $ref: "#/components/schemas/TokenFields" },
        {
          type: "object",
          properties: {
            id: { type: "integer" },
            merchant: { type: "string", description: ADDRESS_DESCRIPTION },
            name: { type: "string" },
            token: { type: "string", description: "The token's contract id." },
            amount: amount(),
            period: { type: "integer", description: "The billing period in seconds." },
            active: { type: "integer", description: "1 when the plan is published, 0 when it is not." },
            ledger: { type: "integer" },
          },
          required: ["id", "merchant", "name", "token", "amount", "period", "active", "ledger"],
        },
      ],
    },
    Mandate: {
      allOf: [
        { $ref: "#/components/schemas/TokenFields" },
        {
          type: "object",
          properties: {
            id: { type: "integer" },
            subscriber: { type: "string", description: ADDRESS_DESCRIPTION },
            merchant: { type: "string", description: ADDRESS_DESCRIPTION },
            plan_id: { type: "integer" },
            amount: amount(),
            period: { type: "integer" },
            next_charge: { type: "integer", description: "When the mandate falls due, in unix seconds." },
            last_charge: { type: "integer" },
            charges_made: { type: "integer" },
            max_charges: { type: "integer", description: "0 means the mandate never expires." },
            fee_bps: { type: "integer", description: "The protocol fee in basis points." },
            status: { type: "string", enum: ["Active", "Paused", "Cancelled", "Completed"] },
            ended_by: { type: ["string", "null"], description: "`subscriber` or `merchant`, or null." },
            ledger: { type: "integer" },
          },
          required: [
            "id",
            "subscriber",
            "merchant",
            "plan_id",
            "amount",
            "period",
            "next_charge",
            "last_charge",
            "charges_made",
            "max_charges",
            "fee_bps",
            "status",
            "ended_by",
            "ledger",
          ],
        },
      ],
    },
    Charge: {
      type: "object",
      properties: {
        tx_hash: { type: "string" },
        mandate_id: { type: "integer" },
        subscriber: { type: "string", description: ADDRESS_DESCRIPTION },
        merchant: { type: "string", description: ADDRESS_DESCRIPTION },
        amount: amount(),
        fee: amount(),
        charges_made: { type: "integer" },
        next_charge: { type: "integer" },
        ledger: { type: "integer" },
        created_at: {
          type: "integer",
          description: "When the charge happened, in unix milliseconds: the close time of its ledger.",
        },
      },
      required: [
        "tx_hash",
        "mandate_id",
        "subscriber",
        "merchant",
        "amount",
        "fee",
        "charges_made",
        "next_charge",
        "ledger",
        "created_at",
      ],
    },
    DueMandate: {
      type: "object",
      properties: {
        id: { type: "integer" },
        subscriber: { type: "string", description: ADDRESS_DESCRIPTION },
        merchant: { type: "string", description: ADDRESS_DESCRIPTION },
        next_charge: { type: "integer" },
        amount: amount(),
        funded: {
          type: "boolean",
          description:
            "Whether the last known vault balance covers this charge. A subscriber the projection has never seen holds nothing, so its mandates are reported as not funded until a deposit is indexed.",
        },
      },
      required: ["id", "subscriber", "merchant", "next_charge", "amount", "funded"],
    },
    PlanStats: {
      type: "object",
      properties: {
        planId: { type: "integer" },
        activeMandates: { type: "integer" },
        totalMandates: { type: "integer" },
        cancellations: { type: "integer" },
        totalCollected: amount(),
        totalCharges: { type: "integer" },
        averageChargesPerMandate: { type: "number" },
      },
      required: [
        "planId",
        "activeMandates",
        "totalMandates",
        "cancellations",
        "totalCollected",
        "totalCharges",
        "averageChargesPerMandate",
      ],
    },
    TokenRevenue: {
      type: "object",
      properties: {
        token: { type: "string" },
        totalCollected: amount(),
        mrr: amount(),
      },
      required: ["token", "totalCollected", "mrr"],
    },
    MerchantSummary: {
      type: "object",
      properties: {
        merchant: { type: "string", description: ADDRESS_DESCRIPTION },
        activeMandates: { type: "integer" },
        totalCollected: amount(),
        chargeCount: { type: "integer" },
        mrr: amount(),
        arr: amount(),
        tokens: { type: "array", items: { $ref: "#/components/schemas/TokenRevenue" } },
      },
      required: ["merchant", "activeMandates", "totalCollected", "chargeCount", "mrr", "arr", "tokens"],
    },
    MerchantSubscriber: {
      type: "object",
      properties: {
        subscriber: { type: "string", description: ADDRESS_DESCRIPTION },
        mandateCount: { type: "integer" },
        chargeCount: { type: "integer" },
        totalCollected: amount(),
      },
      required: ["subscriber", "mandateCount", "chargeCount", "totalCollected"],
    },
    MerchantSubscribers: {
      type: "object",
      properties: {
        merchant: { type: "string", description: ADDRESS_DESCRIPTION },
        subscribers: {
          type: "array",
          items: { $ref: "#/components/schemas/MerchantSubscriber" },
        },
      },
      required: ["merchant", "subscribers"],
    },
    ChurnBucket: {
      type: "object",
      properties: {
        bucket: { type: "string", description: "The bucket's label, in UTC." },
        started: { type: "integer" },
        cancelled: { type: "integer" },
        ended: { type: "integer" },
        completed: { type: "integer" },
        net: { type: "integer", description: "Started minus the departures." },
      },
      required: ["bucket", "started", "cancelled", "ended", "completed", "net"],
    },
    MerchantChurn: {
      type: "object",
      properties: {
        merchant: { type: "string", description: ADDRESS_DESCRIPTION },
        bucket: { type: "string", enum: ["day", "week", "month"] },
        buckets: { type: "array", items: { $ref: "#/components/schemas/ChurnBucket" } },
        totals: { $ref: "#/components/schemas/ChurnBucket" },
      },
      required: ["merchant", "bucket", "buckets", "totals"],
    },
    RevenueBucket: {
      type: "object",
      properties: {
        bucket: { type: "string", description: "The bucket's label, in UTC." },
        gross: amount(),
        fee: amount(),
        net: amount(),
        charges: { type: "integer" },
      },
      required: ["bucket", "gross", "fee", "net", "charges"],
    },
    MerchantRevenue: {
      type: "object",
      properties: {
        merchant: { type: "string", description: ADDRESS_DESCRIPTION },
        bucket: { type: "string", enum: ["day", "week", "month"] },
        from: { type: ["integer", "null"], description: "Start of the range, in unix seconds." },
        to: { type: ["integer", "null"], description: "End of the range (exclusive), in unix seconds." },
        buckets: { type: "array", items: { $ref: "#/components/schemas/RevenueBucket" } },
        totals: { $ref: "#/components/schemas/RevenueBucket" },
      },
      required: ["merchant", "bucket", "from", "to", "buckets", "totals"],
    },
    Forecast: {
      type: "object",
      properties: {
        merchant: { type: "string", description: ADDRESS_DESCRIPTION },
        days: { type: "integer" },
        from: { type: "integer" },
        to: { type: "integer" },
        forecast: amount(),
        mandateCount: { type: "integer" },
        assumptions: { type: "array", items: { type: "string" } },
      },
      required: ["merchant", "days", "from", "to", "forecast", "mandateCount", "assumptions"],
    },
    SubscriberSummary: {
      type: "object",
      properties: {
        subscriber: { type: "string", description: ADDRESS_DESCRIPTION },
        mandates: { type: "array", items: { $ref: "#/components/schemas/Mandate" } },
        totalPaid: amount(),
      },
      required: ["subscriber", "mandates", "totalPaid"],
    },
    UpcomingCharge: {
      type: "object",
      properties: {
        mandateId: { type: "integer" },
        merchant: { type: "string", description: ADDRESS_DESCRIPTION },
        amount: amount(),
        at: { type: "integer", description: "When the charge falls due, in unix seconds." },
      },
      required: ["mandateId", "merchant", "amount", "at"],
    },
    WebhookRegistrationRequest: {
      type: "object",
      properties: {
        merchant: { type: "string", description: ADDRESS_DESCRIPTION },
        url: { type: "string", format: "uri", description: "The URL charge events are POSTed to." },
        secret: {
          type: "string",
          description:
            "HMAC key used to sign deliveries. When absent the service generates one and returns it once.",
        },
        signature: {
          type: "string",
          description:
            "Base64-encoded ed25519 signature of `payflow-webhook:v1:<merchant>:<url>:<timestamp>`, proving control of the merchant address.",
        },
        timestamp: {
          type: "integer",
          description:
            "Unix seconds. Signatures older than ten minutes are refused, so a captured request cannot be replayed indefinitely.",
        },
      },
      required: ["merchant", "url", "signature", "timestamp"],
    },
    Webhook: {
      type: "object",
      properties: {
        id: { type: "integer" },
        merchant: { type: "string", description: ADDRESS_DESCRIPTION },
        url: { type: "string", format: "uri" },
        secret: {
          type: "string",
          description: "HMAC key used to sign delivery requests; treat it as a secret.",
        },
        active: { type: "boolean", description: "Whether deliveries are currently enabled." },
      },
      required: ["id", "merchant", "url", "secret", "active"],
    },
    WebhookSummary: {
      type: "object",
      properties: {
        id: { type: "integer" },
        merchant: { type: "string", description: ADDRESS_DESCRIPTION },
        url: { type: "string", format: "uri" },
        secretLast4: {
          type: "string",
          description: "The signing secret's last four characters; the secret itself is never returned again.",
        },
        failed: { type: "boolean", description: "Deliveries gave up after repeated failures." },
        failures: { type: "integer" },
        lastAttempt: { type: ["integer", "null"], description: "Unix seconds of the last failed attempt." },
        lastStatus: { type: ["integer", "null"], description: "HTTP status of the last failed attempt." },
        createdAt: { type: "integer", description: "Unix seconds." },
      },
      required: ["id", "merchant", "url", "secretLast4", "failed", "failures", "lastAttempt", "lastStatus", "createdAt"],
    },
    WebhookDeleteRequest: {
      type: "object",
      properties: {
        merchant: { type: "string", description: ADDRESS_DESCRIPTION },
        signature: {
          type: "string",
          description: "Base64-encoded ed25519 signature of `payflow-webhook-delete:v1:<merchant>:<id>:<timestamp>`.",
        },
        timestamp: {
          type: "integer",
          description: "Unix seconds. Signatures older than ten minutes are refused.",
        },
      },
      required: ["merchant", "signature", "timestamp"],
    },
    WebhookRotation: {
      type: "object",
      properties: {
        id: { type: "integer" },
        secret: { type: "string", description: "The new HMAC key; returned only here, so store it now." },
        previousSecretExpiresAt: {
          type: ["integer", "null"],
          description: "Unix seconds until which the previous secret also signs; null when it was retired at once.",
        },
      },
      required: ["id", "secret", "previousSecretExpiresAt"],
    },
    WebhookTestResult: {
      type: "object",
      properties: {
        deliveryId: { type: "integer" },
        status: { type: "string", enum: ["delivered", "pending", "failed"] },
        statusCode: { type: ["integer", "null"], description: "The endpoint's HTTP status; null when no response arrived." },
        latencyMs: { type: "integer" },
        error: { type: ["string", "null"] },
        nextRetryAt: { type: ["integer", "null"], description: "Unix seconds of the scheduled retry, when `pending`." },
      },
      required: ["deliveryId", "status", "statusCode", "latencyMs", "error", "nextRetryAt"],
    },
    WebhookDelivery: {
      type: "object",
      properties: {
        id: { type: "integer" },
        deliveryId: { type: "integer", description: "Shared by a delivery's retries." },
        eventId: { type: "string", description: "`charge:<tx hash>` or `ping:<uuid>`." },
        attempt: { type: "integer" },
        status: {
          type: "string",
          enum: ["delivered", "pending", "failed"],
          description: "The delivery's state after this attempt; `pending` means a retry is scheduled.",
        },
        statusCode: { type: ["integer", "null"] },
        error: { type: ["string", "null"] },
        nextRetryAt: { type: ["integer", "null"], description: "Unix seconds." },
        attemptedAt: { type: "integer", description: "Unix seconds." },
      },
      required: ["id", "deliveryId", "eventId", "attempt", "status", "statusCode", "error", "nextRetryAt", "attemptedAt"],
    },
    AuthChallenge: {
      type: "object",
      properties: {
        transaction: { type: "string", description: "The challenge transaction envelope, base64 XDR." },
        network_passphrase: { type: "string" },
      },
      required: ["transaction", "network_passphrase"],
    },
    AuthToken: {
      type: "object",
      properties: {
        token: { type: "string", description: "A JWT to send as `Authorization: Bearer <token>` to merchant-only routes." },
      },
      required: ["token"],
    },
    UpcomingCharges: {
      type: "object",
      properties: {
        subscriber: { type: "string", description: ADDRESS_DESCRIPTION },
        days: { type: "integer" },
        now: { type: "integer" },
        until: { type: "integer" },
        upcoming: { type: "array", items: { $ref: "#/components/schemas/UpcomingCharge" } },
        totalUpcoming: amount(),
        truncated: { type: "boolean" },
        assumptions: { type: "array", items: { type: "string" } },
      },
      required: ["subscriber", "days", "now", "until", "upcoming", "totalUpcoming", "truncated"],
    },
    VaultBalance: {
      type: "object",
      properties: {
        token: { type: "string" },
        balance: amount(),
        ledger: { type: "integer" },
      },
      required: ["token", "balance", "ledger"],
    },
    VaultBalances: {
      type: "object",
      properties: {
        address: { type: "string", description: ADDRESS_DESCRIPTION },
        balances: { type: "array", items: { $ref: "#/components/schemas/VaultBalance" } },
      },
      required: ["address", "balances"],
    },
    VaultEvent: {
      type: "object",
      properties: {
        tx_hash: { type: "string" },
        kind: { type: "string", enum: ["deposit", "withdraw", "debit"] },
        user: { type: "string", description: ADDRESS_DESCRIPTION },
        token: { type: "string" },
        counterparty: { type: ["string", "null"] },
        amount: amount(),
        balance: amount(),
        ledger: { type: "integer" },
      },
      required: ["tx_hash", "kind", "user", "token", "counterparty", "amount", "balance", "ledger"],
    },
    VaultEvents: {
      type: "object",
      properties: {
        address: { type: "string", description: ADDRESS_DESCRIPTION },
        events: { type: "array", items: { $ref: "#/components/schemas/VaultEvent" } },
      },
      required: ["address", "events"],
    },
    TokenMetadata: {
      type: "object",
      properties: {
        token: { type: "string" },
        symbol: { type: "string" },
        name: { type: "string" },
        decimals: { type: "integer", description: "Digits after the decimal point; 7 for XLM's stroops." },
      },
      required: ["token", "symbol", "name", "decimals"],
    },
    Protocol: {
      type: "object",
      properties: {
        fee_bps: { type: ["integer", "null"], description: "The current protocol fee in basis points." },
        history: {
          type: "array",
          items: {
            type: "object",
            properties: {
              tx_hash: { type: "string" },
              old_fee_bps: { type: "integer" },
              new_fee_bps: { type: "integer" },
              ledger: { type: "integer" },
            },
            required: ["tx_hash", "old_fee_bps", "new_fee_bps", "ledger"],
          },
        },
      },
      required: ["fee_bps", "history"],
    },
    Stats: {
      type: "object",
      properties: {
        plans: { type: "integer" },
        mandates: { type: "integer" },
        activeMandates: { type: "integer" },
        charges: { type: "integer" },
        volume24h: amount(),
        volumeAllTime: amount(),
        totalFees: amount(),
        activeMerchants: { type: "integer" },
        lastIndexedLedger: { type: "integer" },
      },
      required: [
        "plans",
        "mandates",
        "activeMandates",
        "charges",
        "volume24h",
        "volumeAllTime",
        "totalFees",
        "activeMerchants",
        "lastIndexedLedger",
      ],
    },
    KeeperPass: {
      type: "object",
      properties: {
        time: { type: "integer" },
        attempted: { type: "integer" },
        settled: { type: "integer" },
        failures: {
          type: "array",
          items: {
            type: "object",
            properties: {
              mandateId: { type: "integer" },
              error: { type: "string" },
            },
            required: ["mandateId", "error"],
          },
        },
        skipped: {
          type: "array",
          description: "Mandates the vault could not cover, with the shortfall.",
          items: {
            type: "object",
            properties: {
              mandateId: { type: "integer" },
              required: amount(),
              balance: amount(),
              shortfall: amount(),
            },
            required: ["mandateId", "required", "balance", "shortfall"],
          },
        },
        backoff: {
          type: "array",
          items: {
            type: "object",
            properties: {
              mandateId: { type: "integer" },
              failures: { type: "integer" },
              retryAt: { type: "integer" },
              retryIn: { type: "integer" },
            },
            required: ["mandateId", "failures", "retryAt", "retryIn"],
          },
        },
      },
      required: ["time", "attempted", "settled", "failures", "backoff"],
    },
    KeeperHistory: {
      type: "object",
      properties: {
        passes: { type: "array", items: { $ref: "#/components/schemas/KeeperPass" } },
      },
      required: ["passes"],
    },
    Health: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["starting", "ok", "catching_up"] },
        network: { type: "string" },
        indexer: {
          type: ["object", "null"],
          properties: {
            cursor: { type: "integer" },
            latestLedger: { type: "integer" },
            lag: { type: ["integer", "null"] },
            paused: { type: "boolean" },
            freshnessSeconds: { type: ["integer", "null"] },
            lastRunAt: { type: ["string", "null"] },
            lastError: { type: ["string", "null"] },
            mismatchedEvents: { type: "integer" },
            reconciliations: { type: "integer" },
            corrections: { type: "integer" },
          },
          required: ["cursor", "latestLedger", "lag", "paused"],
        },
        rpc: {
          type: ["object", "null"],
          properties: {
            active: { type: "string" },
            endpoints: { type: "array", items: { type: "string" } },
          },
          required: ["active", "endpoints"],
        },
        contracts: {
          type: "object",
          properties: {
            planRegistry: { type: "string" },
            vault: { type: "string" },
            subscription: { type: "string" },
          },
          required: ["planRegistry", "vault", "subscription"],
        },
        networks: {
          type: "object",
          description: "The state of every network, when the instance serves more than one.",
          additionalProperties: { $ref: "#/components/schemas/Health" },
        },
      },
      required: ["status", "network", "contracts"],
    },
  };
}

/**
 * Build the OpenAPI document for this instance.
 *
 * The document covers the default network's unprefixed paths and, for every
 * extra network the instance serves, the same paths under `/api/<name>/`.
 */
export function buildOpenApiDocument(options: OpenApiOptions): OpenApiDocument {
  const paths: Record<string, PathItemObject> = {
    ...servicePaths(),
    ...apiPaths("/api"),
  };
  for (const network of options.networks) {
    Object.assign(paths, apiPaths(`/api/${network}`));
  }

  return {
    openapi: "3.1.0",
    info: {
      title: "Payflow API",
      version: API_VERSION,
      summary: "Read API for the Payflow protocol on Stellar.",
      description:
        "The API serves a projection of the Payflow contracts' events: plans, mandates, the charges settled against them and the vault balances behind them.\n\n" +
        "Every amount is a decimal string in the token's smallest unit (stroops for XLM), never a JSON number, so no precision is lost. Every non-2xx response uses the same envelope, `{ \"error\": { \"code\", \"message\", \"requestId\" } }`, where `code` is stable per condition.\n\n" +
        "When the instance serves more than one network, the same paths are also reachable under `/api/<network>/...`.\n\n" +
        "What changed in the API between releases, and how long a deprecated field or route keeps working before it is removed, is recorded in [API_CHANGELOG.md](API_CHANGELOG.md).",
      license: { name: "Apache-2.0", identifier: "Apache-2.0" },
    },
    servers: [{ url: "/", description: "This service." }],
    tags: [
      { name: "plans", description: "Published plans." },
      { name: "mandates", description: "Subscriptions and their settlement history." },
      { name: "merchants", description: "Reports about a merchant's mandates and revenue." },
      { name: "subscribers", description: "Reports about a subscriber's mandates." },
      { name: "vault", description: "The balances and funding history behind the mandates." },
      { name: "keeper", description: "What the settlement keeper is doing." },
      { name: "protocol", description: "Protocol-wide fees and totals." },
      { name: "tokens", description: "Token metadata." },
      { name: "stream", description: "Live events." },
      { name: "stats", description: "Protocol-wide totals." },
      { name: "service", description: "Health, readiness, metrics and this document." },
      { name: "admin", description: "Operator endpoints; they need a bearer token." },
      { name: "auth", description: "SEP-10 sign-in for merchant-only routes." },
    ],
    externalDocs: {
      url: API_CHANGELOG_URL,
      description: "The API changelog and the deprecation policy.",
    },
    paths,
    components: {
      schemas: componentSchemas(),
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          description: "The ADMIN_TOKEN, as `Authorization: Bearer <token>`.",
        },
      },
    },
  };
}

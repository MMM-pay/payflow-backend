import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test, describe } from "node:test";
import { writeApiSchema } from "../src/lib/schema.ts";
import {
  buildOpenApiDocument,
  type OpenApiDocument,
  type SchemaObject,
} from "../src/routes/openapi.ts";

/**
 * The consumer contract test.
 *
 * The frontend declares its own response types, so the backend and the
 * frontend used to agree only by inspection. The OpenAPI document is the
 * machine-readable description of those responses (its bodies are JSON
 * Schema), and CI publishes it as the `api-schema` artifact. This test closes
 * the loop on this side: every checked-in golden response — the fixtures that
 * stand in for the frontend's own — is validated against the schema of the
 * route that produced it. A field the document does not describe, or a
 * required field that disappears, fails here before it reaches a consumer.
 */

const FIXTURES = fileURLToPath(new URL("./fixtures/", import.meta.url));

/** One fixture and the documented route that produced it. */
interface FixtureRoute {
  file: string;
  method: "get";
  path: string;
  status: string;
}

/**
 * The canonical (versioned) path for each golden fixture. The unversioned
 * alias is documented too, but the versioned route is what a generated client
 * calls, so that is what the contract is checked against.
 */
const ROUTES: FixtureRoute[] = [
  { file: "health", method: "get", path: "/health", status: "200" },
  { file: "ready", method: "get", path: "/ready", status: "200" },
  { file: "plans", method: "get", path: "/api/v1/plans", status: "200" },
  { file: "plan_by_id", method: "get", path: "/api/v1/plans/{id}", status: "200" },
  { file: "plan_stats", method: "get", path: "/api/v1/plans/{id}/stats", status: "200" },
  { file: "mandates", method: "get", path: "/api/v1/mandates", status: "200" },
  { file: "mandate_by_id", method: "get", path: "/api/v1/mandates/{id}", status: "200" },
  {
    file: "mandate_charges",
    method: "get",
    path: "/api/v1/mandates/{id}/charges",
    status: "200",
  },
  { file: "vault_balances", method: "get", path: "/api/v1/vault/{address}", status: "200" },
  {
    file: "vault_events",
    method: "get",
    path: "/api/v1/vault/{address}/events",
    status: "200",
  },
  { file: "protocol", method: "get", path: "/api/v1/protocol", status: "200" },
  { file: "protocol_fees", method: "get", path: "/api/v1/protocol/fees", status: "200" },
  { file: "due", method: "get", path: "/api/v1/due", status: "200" },
  {
    file: "merchant_summary",
    method: "get",
    path: "/api/v1/merchants/{address}/summary",
    status: "200",
  },
  {
    file: "merchant_forecast",
    method: "get",
    path: "/api/v1/merchants/{address}/forecast",
    status: "200",
  },
  {
    file: "merchant_subscribers",
    method: "get",
    path: "/api/v1/merchants/{address}/subscribers",
    status: "200",
  },
  {
    file: "merchant_churn",
    method: "get",
    path: "/api/v1/merchants/{address}/churn",
    status: "200",
  },
  {
    file: "merchant_revenue",
    method: "get",
    path: "/api/v1/merchants/{address}/revenue",
    status: "200",
  },
  {
    file: "subscriber_summary",
    method: "get",
    path: "/api/v1/subscribers/{address}/summary",
    status: "200",
  },
  {
    file: "subscriber_upcoming",
    method: "get",
    path: "/api/v1/subscribers/{address}/upcoming",
    status: "200",
  },
  { file: "stats", method: "get", path: "/api/v1/stats", status: "200" },
];

/** Fixtures that are not a response of a documented API route. */
const NOT_API_RESPONSES = new Set(["replay-events"]);

const spec = buildOpenApiDocument({ networks: ["testnet"] });

/** Resolve the `$ref`s the document uses. */
function resolveRef(document: OpenApiDocument, ref: string): SchemaObject {
  const prefix = "#/components/schemas/";
  assert.ok(ref.startsWith(prefix), `unsupported $ref: ${ref}`);
  const schema = document.components?.schemas?.[ref.slice(prefix.length)];
  assert.ok(schema, `unresolved $ref: ${ref}`);
  return schema;
}

/** The JSON type of a runtime value, with integers told apart from numbers. */
function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number" && Number.isInteger(value)) return "integer";
  return typeof value;
}

function matchesType(value: unknown, type: string): boolean {
  const actual = typeOf(value);
  if (type === "number") return actual === "number" || actual === "integer";
  return actual === type;
}

/**
 * Validate a value against the subset of JSON Schema the document uses.
 *
 * That subset is small on purpose: `$ref`, `allOf`, `type` (including a union
 * with `"null"`), `properties`/`required`, `items`, `enum` and
 * `additionalProperties`. Descriptions, formats and numeric bounds are
 * documentation here, not assertions.
 */
function validate(
  value: unknown,
  schema: SchemaObject,
  at: string,
  document: OpenApiDocument,
): string[] {
  if (schema.$ref) return validate(value, resolveRef(document, schema.$ref), at, document);

  const errors: string[] = [];
  for (const part of schema.allOf ?? []) {
    errors.push(...validate(value, part, at, document));
  }

  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((type) => matchesType(value, type))) {
      errors.push(`${at}: expected ${types.join(" | ")}, got ${typeOf(value)}`);
      return errors;
    }
  }

  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`${at}: ${JSON.stringify(value)} is not one of ${JSON.stringify(schema.enum)}`);
  }

  if (typeOf(value) === "object") {
    const record = value as Record<string, unknown>;
    for (const name of schema.required ?? []) {
      if (!(name in record)) errors.push(`${at}.${name}: required property is missing`);
    }
    for (const [name, child] of Object.entries(schema.properties ?? {})) {
      if (name in record) errors.push(...validate(record[name], child, `${at}.${name}`, document));
    }
    const described = new Set(Object.keys(schema.properties ?? {}));
    for (const name of Object.keys(record).filter((key) => !described.has(key))) {
      if (schema.additionalProperties === false) {
        errors.push(`${at}.${name}: property is not documented`);
      } else if (typeof schema.additionalProperties === "object") {
        errors.push(
          ...validate(record[name], schema.additionalProperties, `${at}.${name}`, document),
        );
      }
    }
  }

  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      if (schema.items) errors.push(...validate(item, schema.items, `${at}[${index}]`, document));
    }
  }

  return errors;
}

/** The documented schema of one response body. */
function responseSchema(route: FixtureRoute): SchemaObject {
  const item = spec.paths[route.path];
  assert.ok(item, `${route.path} is not in the OpenAPI document`);
  const operation = item[route.method];
  assert.ok(operation, `${route.method.toUpperCase()} ${route.path} is not documented`);
  const response = operation.responses[route.status];
  assert.ok(response, `${route.path} does not document a ${route.status} response`);
  const schema = response.content?.["application/json"]?.schema;
  assert.ok(schema, `${route.path} ${route.status} has no JSON response schema`);
  return schema;
}

function fixture(file: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURES, `${file}.json`), "utf8")) as unknown;
}

describe("the published consumer schema", () => {
  test("is what the schema command writes", () => {
    const dir = mkdtempSync(join(tmpdir(), "payflow-schema-"));
    try {
      const target = join(dir, "api-schema.json");
      // The same function `npm run schema` calls, without spawning a process
      // (the CI scanner flags child processes in tests, and the wrapper adds
      // nothing this does not already exercise).
      const written = writeApiSchema(target, { STELLAR_NETWORK: "testnet", NETWORKS: "" });
      const artifact = JSON.parse(readFileSync(target, "utf8")) as OpenApiDocument;
      assert.deepEqual(artifact, written, "the written file is the document that was built");
      assert.equal(artifact.openapi, "3.1.0");
      assert.equal(artifact.info.title, "Payflow API");
      assert.ok("/api/v1/plans" in artifact.paths);
      assert.ok(artifact.components?.schemas?.Error);
      // A consumer validates fixtures against the document it downloads, so
      // the artifact has to carry the schemas the operations refer to.
      assert.ok(
        JSON.stringify(artifact).includes("#/components/schemas/Plan"),
        "the response schemas are part of the artifact",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  for (const route of ROUTES) {
    test(`the ${route.file} fixture matches its documented response`, () => {
      const errors = validate(fixture(route.file), responseSchema(route), route.file, spec);
      assert.deepEqual(errors, [], `${route.file} does not match ${route.path}`);
    });
  }

  test("every error fixture matches the shared error envelope", () => {
    const schema = spec.components?.schemas?.Error;
    assert.ok(schema);
    const errors = readdirSync(FIXTURES)
      .filter((name) => name.startsWith("error_") && name.endsWith(".json"))
      .flatMap((name) =>
        validate(
          JSON.parse(readFileSync(join(FIXTURES, name), "utf8")) as unknown,
          schema,
          name,
          spec,
        ),
      );
    assert.deepEqual(errors, []);
  });

  test("no fixture escapes the contract check", () => {
    const checked = new Set([
      ...ROUTES.map((route) => route.file),
      ...readdirSync(FIXTURES)
        .filter((name) => name.startsWith("error_") && name.endsWith(".json"))
        .map((name) => name.slice(0, -".json".length)),
      ...NOT_API_RESPONSES,
    ]);
    for (const name of readdirSync(FIXTURES)) {
      if (!name.endsWith(".json")) continue;
      assert.ok(
        checked.has(name.slice(0, -".json".length)),
        `${name} is not validated; add it to ROUTES or NOT_API_RESPONSES`,
      );
    }
  });

});

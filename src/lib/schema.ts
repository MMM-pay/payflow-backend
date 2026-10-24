/**
 * The API's machine-readable contract: the OpenAPI 3.1 document, whose
 * response schemas are the JSON Schema description of every route's body.
 *
 * The export command (`src/cmd/schema.ts`) and the consumer contract test both
 * call this module, so the artifact CI publishes and the artifact the tests
 * check cannot diverge. Nothing here touches the network.
 */
import { writeFileSync } from "node:fs";
import { buildOpenApiDocument, type OpenApiDocument } from "../routes/openapi.ts";

/**
 * The networks the deployment serves, read from the same variables
 * `networkConfigs` reads. Only the names go into the document, so the export
 * needs no contract ids and can run in CI without a `.env`.
 */
function networkNames(env: NodeJS.ProcessEnv): string[] {
  const names = [env.STELLAR_NETWORK?.trim() || "testnet"];
  for (const name of (env.NETWORKS ?? "").split(",").map((part) => part.trim())) {
    if (name !== "" && !names.includes(name)) names.push(name);
  }
  return names;
}

/** The document for the networks named by `env`. */
export function apiSchema(env: NodeJS.ProcessEnv = process.env): OpenApiDocument {
  return buildOpenApiDocument({ networks: networkNames(env) });
}

/** Write the document to `target` and return it. */
export function writeApiSchema(
  target: string,
  env: NodeJS.ProcessEnv = process.env,
): OpenApiDocument {
  const document = apiSchema(env);
  writeFileSync(target, `${JSON.stringify(document, null, 2)}\n`, "utf8");
  return document;
}

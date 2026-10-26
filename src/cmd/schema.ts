/**
 * Write the API's machine-readable contract to a file.
 *
 * A consumer — the frontend above all — can validate its own fixtures against
 * this artifact instead of re-declaring the response shapes and hoping they
 * match. `src/lib/schema.ts` builds it, the same module the consumer contract
 * test uses, so the published artifact and the tested one are the same.
 *
 * Usage: npm run schema [path]     (default: api-schema.json)
 */
import { writeApiSchema } from "../lib/schema.ts";
import { logger } from "../lib/logger.ts";

const target = process.argv[2] ?? "api-schema.json";
const document = writeApiSchema(target);
logger.info({ path: target, paths: Object.keys(document.paths).length }, "exported the API schema");

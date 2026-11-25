import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test, describe, before, after, mock } from "node:test";
import type { Server } from "node:http";
import { Keypair, Networks, StrKey } from "@stellar/stellar-sdk";
import { openDatabase } from "../src/lib/db.ts";
import { createApp } from "../src/app.ts";
import { WebhookDispatcher } from "../src/lib/webhooks.ts";
import { logger } from "../src/lib/logger.ts";
import type { Config, NetworkConfig } from "../src/config.ts";
import { Sep10Auth } from "../src/routes/auth.ts";

/**
 * #284: fuzz the bearer-token check with malformed, expired, tampered and
 * foreign tokens. Every input other than a well-formed, correctly signed,
 * unexpired token for this network is refused, refused the same way, and
 * never throws. The corpus comes from a seeded PRNG and the clock is mocked,
 * so a run is deterministic and needs no network.
 */

const HOME = "payflow.example";
const WEB = "api.payflow.example";
const ISSUER = `https://${WEB}/api/testnet/auth`;
const SECRET = "a-jwt-secret-that-is-at-least-32-characters";
const OTHER_SECRET = "another-secret-that-is-also-32-characters";
/** A fixed "now" for every test: 2026-01-01T00:00:00Z. */
const NOW = 1_767_225_600;
const TTL = 900;
const SEED = 0x5eed_284;

/** mulberry32: a small, seedable PRNG, so each run fuzzes the same corpus. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const b64u = (value: unknown): string =>
  Buffer.from(typeof value === "string" ? value : JSON.stringify(value)).toString("base64url");
const HEADER = { alg: "HS256", typ: "JWT" };

/** A JWT whose header and payload segments are taken verbatim, HMAC-signed with `secret`. */
function signRaw(header: string, payload: string, secret = SECRET): string {
  const body = `${header}.${payload}`;
  return `${body}.${createHmac("sha256", secret).update(body).digest("base64url")}`;
}

/** A correctly signed token carrying `claims` (and, optionally, another header). */
const forge = (claims: unknown, secret = SECRET, header: unknown = HEADER): string =>
  signRaw(b64u(header), b64u(claims), secret);

const subject = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 1)).publicKey();
const validClaims = { iss: ISSUER, sub: subject, iat: NOW, exp: NOW + TTL, jti: "a".repeat(64) };
const valid = forge(validClaims);

const auth = new Sep10Auth({
  signingKey: Keypair.fromRawEd25519Seed(Buffer.alloc(32, 2)).secret(),
  jwtSecret: SECRET,
  homeDomain: HOME,
  webAuthDomain: WEB,
  networkPassphrase: Networks.TESTNET,
  issuer: ISSUER,
  tokenTtlS: TTL,
  loadAccount: async () => assert.fail("verifying a token never loads an account"),
});

/** Structurally malformed tokens: wrong segment counts, encodings and bytes. */
function structural(): string[] {
  const [h, p, s] = valid.split(".") as [string, string, string];
  return [
    "",
    " ",
    ".",
    "..",
    "...",
    "....",
    "a.b.c",
    "a.b",
    h,
    `${h}.${p}`,
    `${h}.${p}.`,
    `${h}..${s}`,
    `.${p}.${s}`,
    `${h}.${p}.${s}.`,
    `${h}.${p}.${s}.${s}`,
    `${valid} `,
    ` ${valid}`,
    `${valid}\n`,
    `${valid}\0`,
    valid.toUpperCase(),
    valid.toLowerCase(),
    `${h}.${p}.${s}=`,
    `${h}=.${p}.${s}`,
    `${h}.${p}=.${s}`,
    // Standard base64 instead of base64url.
    `${h}.${p}.${Buffer.from(s, "base64url").toString("base64")}`,
    // Signature as hex instead of base64url.
    `${h}.${p}.${Buffer.from(s, "base64url").toString("hex")}`,
    `${h}.${p}.${s.slice(0, -1)}`,
    `${h}.${p}.${s}A`,
    `${h}.${p}.${"A".repeat(s.length)}`,
    `${h}.${p}.${"é".repeat(s.length)}`,
    `${h}.${p}.${"🔥".repeat(11)}`,
    "\u0000".repeat(10),
    "x".repeat(100_000),
    `${h}.${"A".repeat(100_000)}.${s}`,
    ".".repeat(10_000),
    "not-a-jwt",
    "null",
    "undefined",
    "[object Object]",
    "eyJ",
    "Bearer " + valid,
  ];
}

/** Alternative headers, each correctly signed with the real key. */
function headers(): string[] {
  const variants: unknown[] = [
    { alg: "none", typ: "JWT" },
    { alg: "NONE", typ: "JWT" },
    { alg: "HS512", typ: "JWT" },
    { alg: "HS384", typ: "JWT" },
    { alg: "RS256", typ: "JWT" },
    { alg: "ES256", typ: "JWT" },
    { alg: "hs256", typ: "JWT" },
    { alg: "HS256" },
    { typ: "JWT", alg: "HS256" },
    { alg: "HS256", typ: "JWT", kid: "../../etc/passwd" },
    { alg: "HS256", typ: "jwt" },
    { alg: ["HS256"], typ: "JWT" },
    {},
    [],
    null,
    "HS256",
  ];
  const tokens = variants.map((header) => forge(validClaims, SECRET, header));
  // The right JSON with insignificant whitespace is still not the header issued.
  tokens.push(signRaw(b64u('{ "alg": "HS256", "typ": "JWT" }'), b64u(validClaims)));
  tokens.push(signRaw(b64u('{"alg":"HS256","typ":"JWT"}\n'), b64u(validClaims)));
  // A header that is not base64url JSON at all.
  tokens.push(signRaw("%%%", b64u(validClaims)));
  tokens.push(signRaw("", b64u(validClaims)));
  return tokens;
}

/** Claims that are wrong in one way each, every token correctly signed with the real key. */
function claims(): string[] {
  const contract = StrKey.encodeContract(Buffer.alloc(32, 3));
  const muxed = StrKey.encodeMed25519PublicKey(Buffer.concat([Keypair.fromRawEd25519Seed(Buffer.alloc(32, 4)).rawPublicKey(), Buffer.alloc(8)]));
  const badChecksum = `${subject.slice(0, -1)}${subject.endsWith("A") ? "B" : "A"}`;
  const without = (key: keyof typeof validClaims): Record<string, unknown> => {
    const copy: Record<string, unknown> = { ...validClaims };
    delete copy[key];
    return copy;
  };
  const payloads: unknown[] = [
    // Expired, at and past the boundary: a token is valid strictly before `exp`.
    { ...validClaims, exp: NOW },
    { ...validClaims, exp: NOW - 1 },
    { ...validClaims, iat: NOW - 2 * TTL, exp: NOW - TTL },
    { ...validClaims, exp: 0 },
    { ...validClaims, exp: -1 },
    // Wrong types and non-integers.
    { ...validClaims, exp: String(NOW + TTL) },
    { ...validClaims, exp: NOW + 0.5 },
    { ...validClaims, exp: null },
    { ...validClaims, exp: true },
    { ...validClaims, exp: [NOW + TTL] },
    { ...validClaims, iat: String(NOW) },
    { ...validClaims, iat: NOW + 0.5 },
    { ...validClaims, jti: 42 },
    { ...validClaims, jti: null },
    { ...validClaims, iss: null },
    { ...validClaims, sub: null },
    { ...validClaims, sub: 1 },
    { ...validClaims, sub: [subject] },
    { ...validClaims, sub: { account: subject } },
    // Subjects that are not a Stellar account.
    { ...validClaims, sub: "" },
    { ...validClaims, sub: badChecksum },
    { ...validClaims, sub: subject.toLowerCase() },
    { ...validClaims, sub: ` ${subject}` },
    { ...validClaims, sub: contract },
    { ...validClaims, sub: muxed },
    { ...validClaims, sub: Keypair.fromRawEd25519Seed(Buffer.alloc(32, 5)).secret() },
    // Another network's, or nobody's, issuer.
    { ...validClaims, iss: `https://${WEB}/api/mainnet/auth` },
    { ...validClaims, iss: `https://${WEB}/api/futurenet/auth` },
    { ...validClaims, iss: `${ISSUER}/` },
    { ...validClaims, iss: ISSUER.toUpperCase() },
    { ...validClaims, iss: `http://${WEB}/api/testnet/auth` },
    { ...validClaims, iss: "" },
    // Missing claims.
    without("iss"),
    without("sub"),
    without("iat"),
    without("exp"),
    without("jti"),
    // Not an object of claims at all.
    {},
    [],
    [validClaims],
    null,
    0,
    "claims",
    true,
    { __proto__: validClaims },
    JSON.parse(`{"__proto__":${JSON.stringify(validClaims)}}`),
  ];
  const tokens = payloads.map((payload) => forge(payload));
  // Payloads that are not JSON, or not UTF-8, under a valid signature.
  for (const raw of ["", "{", "{\"iss\":", "nul", "\u0000", "\uFEFF" + JSON.stringify(validClaims)]) {
    tokens.push(signRaw(b64u(HEADER), b64u(raw)));
  }
  tokens.push(signRaw(b64u(HEADER), Buffer.from([0xff, 0xfe, 0xfd]).toString("base64url")));
  tokens.push(signRaw(b64u(HEADER), "!!!not-base64!!!"));
  return tokens;
}

/** Valid claims signed with the wrong key, or a signature lifted from another token. */
function foreign(): string[] {
  const [h, p] = valid.split(".") as [string, string];
  const other = forge({ ...validClaims, sub: Keypair.fromRawEd25519Seed(Buffer.alloc(32, 6)).publicKey() });
  return [
    forge(validClaims, OTHER_SECRET),
    forge(validClaims, ""),
    forge(validClaims, SECRET.slice(0, -1)),
    forge(validClaims, `${SECRET} `),
    `${h}.${p}.${other.split(".")[2]}`,
    `${other.split(".").slice(0, 2).join(".")}.${valid.split(".")[2]}`,
    `${h}.${p}.${createHmac("sha512", SECRET).update(`${h}.${p}`).digest("base64url")}`,
    `${h}.${p}.${createHmac("sha256", SECRET).update(p).digest("base64url")}`,
  ];
}

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.=+/ \t%é\u0000";

/** Seeded random tokens: random strings, and single-character mutations of the valid token. */
function random(count: number): string[] {
  const rand = prng(SEED);
  const pick = (s: string): string => s[Math.floor(rand() * s.length)]!;
  const tokens: string[] = [];
  for (let i = 0; i < count; i++) {
    const length = Math.floor(rand() * 300);
    tokens.push(Array.from({ length }, () => pick(ALPHABET)).join(""));
  }
  for (let i = 0; i < count; i++) {
    const chars = [...valid];
    const at = Math.floor(rand() * chars.length);
    const op = Math.floor(rand() * 3);
    if (op === 0) {
      let replacement = pick(ALPHABET);
      while (replacement === chars[at]) replacement = pick(ALPHABET);
      chars[at] = replacement;
    } else if (op === 1) {
      chars.splice(at, 1);
    } else {
      chars.splice(at, 0, pick(ALPHABET));
    }
    tokens.push(chars.join(""));
  }
  // Valid-looking three-segment tokens with random segments.
  for (let i = 0; i < count; i++) {
    const segment = (): string => Array.from({ length: 1 + Math.floor(rand() * 80) }, () => pick(ALPHABET.slice(0, 64))).join("");
    tokens.push(`${segment()}.${segment()}.${segment()}`);
  }
  return tokens;
}

const corpus = (): Array<[string, string[]]> => [
  ["structural", structural()],
  ["header", headers()],
  ["claims", claims()],
  ["foreign", foreign()],
  ["random", random(1_000)],
];

describe("fuzz: Sep10Auth.verify", () => {
  before(() => mock.timers.enable({ apis: ["Date"], now: NOW * 1000 }));
  after(() => mock.timers.reset());

  test("the unmodified token verifies, so the corpus is mutating a token that works", () => {
    assert.equal(auth.verify(valid), subject);
    assert.equal(auth.verify(forge({ ...validClaims, exp: NOW + 1 })), subject, "valid until the second before exp");
  });

  for (const [name, tokens] of corpus()) {
    test(`every ${name} token is refused with null and never throws`, () => {
      assert.ok(tokens.length > 0);
      for (const token of tokens) {
        assert.notEqual(token, valid);
        let result: string | null | undefined;
        assert.doesNotThrow(() => {
          result = auth.verify(token);
        }, `verify threw for ${JSON.stringify(token.slice(0, 120))}`);
        assert.equal(result, null, `accepted ${JSON.stringify(token.slice(0, 120))}`);
      }
    });
  }

  test("the corpus is the same on every run", () => {
    assert.deepEqual(random(50), random(50));
  });

  test("a token expires exactly at exp as the clock moves on", () => {
    const token = forge({ ...validClaims, exp: NOW + 10 });
    assert.equal(auth.verify(token), subject);
    mock.timers.tick(9_999);
    assert.equal(auth.verify(token), subject);
    mock.timers.tick(1);
    assert.equal(auth.verify(token), null);
    mock.timers.setTime(NOW * 1000);
  });
});

describe("fuzz: Authorization header on merchant routes", () => {
  const testnet: NetworkConfig = {
    name: "testnet",
    rpcUrl: "https://rpc.invalid",
    networkPassphrase: Networks.TESTNET,
    planRegistryId: "C".repeat(56),
    vaultId: "C".repeat(56),
    subscriptionId: "C".repeat(56),
    startLedger: 0,
    databasePath: ":memory:",
  };
  // The fuzz sends a few thousand requests from one IP: lift the per-IP
  // limit so every answer is the auth check's, not the rate limiter's.
  const config = { CORS_ORIGIN: "*", API_RATE_LIMIT_MAX: 1_000_000 } as unknown as Config;
  const db = openDatabase(":memory:");
  const disabledDb = openDatabase(":memory:");
  let server: Server;
  let disabled: Server;
  let base = "";
  let disabledBase = "";
  const level = logger.level;

  const listen = (app: ReturnType<typeof createApp>): Promise<[Server, string]> =>
    new Promise((resolve) => {
      const s = app.listen(0, () => {
        const address = s.address();
        resolve([s, `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`]);
      });
    });

  before(async () => {
    // Thousands of access lines say nothing these assertions do not.
    logger.level = "silent";
    mock.timers.enable({ apis: ["Date"], now: NOW * 1000 });
    const webhooks = new WebhookDispatcher({
      db,
      fetchImpl: (async () => assert.fail("no webhook is delivered")) as unknown as typeof fetch,
      lookupImpl: async () => [{ address: "93.184.216.34", family: 4 }],
    });
    [server, base] = await listen(createApp([{ config: testnet, db, webhooks, auth }], config));
    // The same routes on an instance where SEP-10 sign-in is not configured.
    [disabled, disabledBase] = await listen(
      createApp([{ config: testnet, db: disabledDb, webhooks: new WebhookDispatcher({ db: disabledDb }) }], config),
    );
  });

  after(() => {
    logger.level = level;
    mock.timers.reset();
    server.close();
    disabled.close();
    db.close();
    disabledDb.close();
  });

  // Every route that accepts a bearer token in place of a signed message.
  const routes: Array<{ method: string; path: string; body?: unknown }> = [
    { method: "GET", path: "/api/webhooks" },
    { method: "POST", path: "/api/webhooks", body: { url: "https://merchant.example/hooks" } },
    { method: "DELETE", path: "/api/webhooks/1" },
    { method: "POST", path: "/api/webhooks/1/rotate" },
    { method: "GET", path: "/api/webhooks/1/deliveries" },
    { method: "GET", path: `/api/merchants/${subject}/notification-preferences` },
    { method: "PUT", path: `/api/merchants/${subject}/notification-preferences`, body: { events: [] } },
    { method: "GET", path: `/api/subscribers/${subject}/export` },
  ];

  const call = async (
    root: string,
    route: (typeof routes)[number],
    authorization: string,
  ): Promise<{ status: number; code: string | undefined; message: string | undefined }> => {
    const res = await fetch(`${root}${route.path}`, {
      method: route.method,
      headers: {
        authorization,
        ...(route.body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(route.body === undefined ? {} : { body: JSON.stringify(route.body) }),
    });
    const text = await res.text();
    const body = text ? (JSON.parse(text) as { error?: { code?: string; message?: string } }) : {};
    return { status: res.status, code: body.error?.code, message: body.error?.message };
  };

  /**
   * Header values fetch can send (no control characters, at most a few KB),
   * drawn from every corpus, plus malformed schemes around the valid token.
   */
  const headerCorpus = (): string[] => {
    const sendable = (value: string): boolean => /^[\x21-\x7e](?:[\x20-\x7e]*[\x21-\x7e])?$/.test(value) && value.length < 4_096;
    const fromCorpus = corpus().flatMap(([name, tokens]) =>
      (name === "random" ? tokens.slice(0, 150).concat(tokens.slice(1_000, 1_150)) : tokens).filter(sendable),
    );
    return [
      ...fromCorpus.map((token) => `Bearer ${token}`),
      "Bearer",
      "Bearer ",
      "Bearer\t",
      `Bearer ${valid} ${valid}`,
      `Bearer ${valid},Bearer ${valid}`,
      `Bearer${valid}`,
      `Bearer: ${valid}`,
      `Bearer "${valid}"`,
      `Bearer <${valid}>`,
      `Token ${valid}`,
      `JWT ${valid}`,
      `Basic ${Buffer.from(`${subject}:${valid}`).toString("base64")}`,
      `Digest ${valid}`,
      valid,
      "x",
      "null",
    ].filter(sendable);
  };

  test("the valid token is accepted, so a refusal below is the token's fault", async () => {
    const res = await call(base, routes[0]!, `Bearer ${valid}`);
    assert.equal(res.status, 200);
    // The scheme is case-insensitive, as RFC 7235 requires.
    assert.equal((await call(base, routes[0]!, `bearer ${valid}`)).status, 200);
    assert.equal((await call(base, routes[0]!, `BEARER   ${valid}`)).status, 200);
  });

  /** The malformed schemes, which close the corpus. */
  const SCHEMES = 16;
  /**
   * A fixed spread of the corpus (every 15th value, from each category) and
   * every malformed scheme: what each route is fuzzed with. The whole corpus
   * goes through `verify` above and through one route below; sending it to
   * all eight would only repeat the same check at a few ms per request.
   */
  const sample = (values: string[]): string[] =>
    values.filter((_, i) => i % 15 === 0 || i >= values.length - SCHEMES);

  const assertRefused = async (root: string, values: string[], message: string, only?: typeof routes): Promise<void> => {
    const messages = new Set<string | undefined>();
    for (const route of only ?? routes) {
      for (const value of only ? values : sample(values)) {
        const res = await call(root, route, value);
        assert.equal(res.status, 401, `${route.method} ${route.path} with ${JSON.stringify(value.slice(0, 120))}`);
        assert.equal(res.code, "unauthorized");
        messages.add(res.message);
      }
    }
    assert.deepEqual([...messages], [message], "every refusal says the same thing");
  };

  const INVALID = "The bearer token is invalid or has expired; sign in again.";

  test("the whole header corpus gets the same 401 from the webhook list", async () => {
    const values = headerCorpus();
    assert.ok(values.length > 250, `fuzzed ${values.length} header values`);
    await assertRefused(base, values, INVALID, routes.slice(0, 1));
  });

  test("a spread of the corpus gets the same 401 from every merchant route", async () => {
    const values = headerCorpus();
    assert.ok(sample(values).length > 30);
    await assertRefused(base, values, INVALID);
  });

  test("an instance without sign-in refuses every bearer header, the valid one included", async () => {
    await assertRefused(disabledBase, [`Bearer ${valid}`, ...headerCorpus()], "SEP-10 sign-in is not enabled on this instance.");
  });

  test("an expired token is refused like any other bad token, never with a different status", async () => {
    const expiring = forge({ ...validClaims, exp: NOW + 5 });
    assert.equal((await call(base, routes[0]!, `Bearer ${expiring}`)).status, 200);
    mock.timers.tick(5_000);
    try {
      const res = await call(base, routes[0]!, `Bearer ${expiring}`);
      assert.deepEqual(res, {
        status: 401,
        code: "unauthorized",
        message: INVALID,
      });
    } finally {
      mock.timers.setTime(NOW * 1000);
    }
  });
});

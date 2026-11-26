import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import express, { Router, type Request, type Response } from "express";
import { Keypair, StrKey, WebAuth, xdr } from "@stellar/stellar-sdk";
import { z } from "zod";
import type { Config, NetworkConfig } from "../config.ts";
import type { RpcLike } from "../lib/stellar.ts";
import type { Storage } from "../lib/store/types.ts";
import type { AuthChallengeResponse, AuthTokenResponse } from "./types.ts";
import { sendApiError } from "./errors.ts";
import { queryOnly, validate, type Validated } from "./validate.ts";

/**
 * SEP-10 sign-in (https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0010.md).
 *
 * `GET /api/auth?account=G...` answers a challenge: a transaction with
 * sequence number 0, sourced from the server account, valid for fifteen
 * minutes, whose first operation is a manage data `<home domain> auth` with
 * the client as source and a 48-byte random nonce, followed by a
 * `web_auth_domain` operation, and signed by the server. The client signs it
 * and `POST /api/auth` exchanges it for a short-lived JWT whose `sub` is the
 * account. Merchant-only routes accept that JWT as `Authorization: Bearer`
 * beside their per-request signed messages.
 *
 * Verification follows the spec: for an account that exists on the network
 * the client signatures must be from the account's signers and meet its
 * medium threshold; for one that does not, the only client signature must be
 * the account's master key. Each challenge yields at most one token.
 */

/** Challenge validity: the fifteen minutes SEP-10 recommends. */
const CHALLENGE_TTL_S = 900;
/**
 * The SDK accepts a challenge up to five minutes past its time bounds, so a
 * redeemed challenge is remembered that much longer to refuse its replay.
 */
const TIMEBOUNDS_GRACE_S = 300;
/** The only JWT header this service issues, and so the only one it accepts. */
const JWT_HEADER = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");

const nowSeconds = (): number => Math.floor(Date.now() / 1000);

/** An account's weighted ed25519 signers (the master key included) and its medium threshold. */
export interface AccountSigners {
  signers: Array<{ key: string; weight: number }>;
  mediumThreshold: number;
}

/** Loads an account's signers: null when the account does not exist; throws when RPC fails. */
export type AccountLoader = (account: string) => Promise<AccountSigners | null>;

/**
 * Read an account entry through Soroban RPC. `getLedgerEntries` leaves a
 * missing entry out of its answer instead of failing, so an outage is an
 * error rather than an account mistaken for one that does not exist — which
 * would let its master key alone sign in after it had been disabled.
 */
export function accountLoader(rpc: Pick<RpcLike, "getLedgerEntries">): AccountLoader {
  return async (account) => {
    const key = xdr.LedgerKey.account(
      new xdr.LedgerKeyAccount({ accountId: Keypair.fromPublicKey(account).xdrAccountId() }),
    );
    const entry = (await rpc.getLedgerEntries(key)).entries[0]?.val;
    if (entry?.type !== "account") return null;
    // Thresholds are four bytes: master weight, low, medium, high.
    const thresholds = entry.account.thresholds.toBytes();
    // Only ed25519 keys can sign a challenge; pre-auth and hash-x signers cannot.
    const signers = entry.account.signers.flatMap((signer) =>
      signer.key.type === "signerKeyTypeEd25519"
        ? [{ key: StrKey.encodeEd25519PublicKey(signer.key.ed25519.toBytes()), weight: signer.weight }]
        : [],
    );
    return {
      signers: [{ key: account, weight: thresholds[0] ?? 0 }, ...signers],
      mediumThreshold: thresholds[2] ?? 0,
    };
  };
}

/** A challenge or token the client sent is not valid; the message is safe to return. */
export class Sep10Error extends Error {}

export interface Sep10Options {
  /** The server account's secret seed (`S...`); its public key is the stellar.toml SIGNING_KEY. */
  signingKey: string;
  /** HMAC-SHA256 key the JWTs are signed with. */
  jwtSecret: string;
  homeDomain: string;
  webAuthDomain: string;
  networkPassphrase: string;
  /** The JWT `iss`: this network's auth endpoint, so a token is valid on that network only. */
  issuer: string;
  tokenTtlS: number;
  /** Lifetime of a refresh token in seconds. */
  refreshTtlS: number;
  loadAccount: AccountLoader;
  /** Persistence for refresh-token hashes. */
  db: Storage;
}

const claimsSchema = z.object({
  iss: z.string(),
  sub: z.string().refine((value) => StrKey.isValidEd25519PublicKey(value)),
  iat: z.number().int(),
  exp: z.number().int(),
  jti: z.string(),
});

/** Issues SEP-10 challenges and JWTs for one network, and verifies the JWTs. */
export class Sep10Auth {
  readonly homeDomain: string;
  readonly webAuthDomain: string;
  readonly networkPassphrase: string;
  /**
   * The keys live in JavaScript private fields: unlike TypeScript's
   * `private`, they are not enumerable, so serialising or logging this
   * object can never write the server seed or the JWT key.
   */
  readonly #server: Keypair;
  readonly #jwtKey: Buffer;
  private readonly issuer: string;
  private readonly tokenTtlS: number;
  private readonly refreshTtlS: number;
  private readonly loadAccount: AccountLoader;
  private readonly db: Storage;
  /**
   * Hashes of challenges already exchanged for a token, with the unix second
   * after which the SDK would refuse them anyway. Insertion order tracks
   * expiry closely, so expired entries are pruned from the front: O(1)
   * amortised per token, and the map never outgrows one challenge window.
   */
  private readonly redeemed = new Map<string, number>();

  constructor(options: Sep10Options) {
    this.#server = Keypair.fromSecret(options.signingKey);
    this.#jwtKey = Buffer.from(options.jwtSecret, "utf8");
    this.homeDomain = options.homeDomain;
    this.webAuthDomain = options.webAuthDomain;
    this.networkPassphrase = options.networkPassphrase;
    this.issuer = options.issuer;
    this.tokenTtlS = options.tokenTtlS;
    this.refreshTtlS = options.refreshTtlS;
    this.loadAccount = options.loadAccount;
    this.db = options.db;
  }

  /** A server-signed challenge for `account` (a `G...` address). */
  challenge(account: string): AuthChallengeResponse {
    return {
      transaction: WebAuth.buildChallengeTx(
        this.#server,
        account,
        this.homeDomain,
        CHALLENGE_TTL_S,
        this.networkPassphrase,
        this.webAuthDomain,
      ),
      network_passphrase: this.networkPassphrase,
    };
  }

  /**
   * Exchange a client-signed challenge for a JWT. Throws `Sep10Error` when
   * the challenge is malformed, expired, not this server's, already used, or
   * not signed with enough weight by the account; an RPC failure while
   * loading the account propagates as itself.
   */
  async token(transaction: string): Promise<AuthTokenResponse> {
    const serverAccount = this.#server.publicKey();
    const { tx, clientAccountID } = challengeCheck(() =>
      WebAuth.readChallengeTx(transaction, serverAccount, this.networkPassphrase, this.homeDomain, this.webAuthDomain),
    );
    const jti = Buffer.from(tx.hash()).toString("hex");
    this.assertUnused(jti);

    const account = await this.loadAccount(clientAccountID);
    challengeCheck(() =>
      account === null
        ? WebAuth.verifyChallengeTxSigners(
            transaction,
            serverAccount,
            this.networkPassphrase,
            [clientAccountID],
            this.homeDomain,
            this.webAuthDomain,
          )
        : WebAuth.verifyChallengeTxThreshold(
            transaction,
            serverAccount,
            this.networkPassphrase,
            // A zero threshold would accept any listed signer; at least one weighted signature is required.
            Math.max(account.mediumThreshold, 1),
            // A zero-weight signer (a disabled master key) cannot sign in.
            account.signers
              .filter((signer) => signer.weight > 0)
              .map((signer) => ({ ...signer, type: "ed25519_public_key" })),
            this.homeDomain,
            this.webAuthDomain,
          ),
    );

    // Checked again after the await: a concurrent exchange of the same
    // challenge may have finished meanwhile. No await follows, so the check
    // and the record are atomic.
    this.assertUnused(jti);
    const now = nowSeconds();
    this.redeemed.set(jti, Number(tx.timeBounds?.maxTime ?? now) + TIMEBOUNDS_GRACE_S);

    const body = `${JWT_HEADER}.${Buffer.from(
      JSON.stringify({ iss: this.issuer, sub: clientAccountID, iat: now, exp: now + this.tokenTtlS, jti }),
    ).toString("base64url")}`;
    const token = `${body}.${this.mac(body)}`;
    const refreshToken = await this.issueRefreshToken(clientAccountID);
    return { token, refresh_token: refreshToken };
  }

  /**
   * Rotate a refresh token: validate it, issue a new short-lived JWT and a
   * new refresh token, and revoke the consumed one. Returns null when the
   * refresh token is unknown, revoked or expired. The returned refresh token
   * replaces the consumed one, so a leaked refresh token can only be used
   * once — its second use fails because the hash is already revoked.
   */
  async rotate(refreshToken: string): Promise<AuthTokenResponse | null> {
    const now = nowSeconds();
    const tokenHash = this.hashRefreshToken(refreshToken);
    const row = await this.db.get<{ account: string; expires_at: number; revoked_at: number | null }>(
      "SELECT account, expires_at, revoked_at FROM refresh_tokens WHERE token_hash = ?",
      [tokenHash],
    );
    if (!row) return null;
    if (row.revoked_at !== null) return null;
    if (row.expires_at <= now) {
      await this.db.run("UPDATE refresh_tokens SET revoked_at = ? WHERE token_hash = ?", [now, tokenHash]);
      return null;
    }
    // Consume the old token and issue the next.
    await this.db.run("UPDATE refresh_tokens SET revoked_at = ? WHERE token_hash = ?", [now, tokenHash]);
    const newRefreshToken = await this.issueRefreshToken(row.account);
    const token = this.issueJwt(row.account, now);
    return { token, refresh_token: newRefreshToken };
  }

  /** Mint a refresh token for an account: store its hash, return the plaintext once. */
  private async issueRefreshToken(account: string): Promise<string> {
    const plaintext = randomUUID();
    const tokenHash = this.hashRefreshToken(plaintext);
    const now = nowSeconds();
    await this.db.run(
      "INSERT INTO refresh_tokens (token_hash, account, expires_at, created_at) VALUES (?, ?, ?, ?)",
      [tokenHash, account, now + this.refreshTtlS, now],
    );
    return plaintext;
  }

  /** HMAC-SHA256 of a refresh token, so plaintexts are never stored. */
  private hashRefreshToken(token: string): string {
    return createHmac("sha256", this.#jwtKey).update(token).digest("hex");
  }

  /** Build a signed JWT for an account at a given now. */
  private issueJwt(account: string, now: number): string {
    const jti = createHmac("sha256", this.#jwtKey).update(`${account}:${now}:${randomUUID()}`).digest("hex");
    const body = `${JWT_HEADER}.${Buffer.from(
      JSON.stringify({ iss: this.issuer, sub: account, iat: now, exp: now + this.tokenTtlS, jti }),
    ).toString("base64url")}`;
    return `${body}.${this.mac(body)}`;
  }

  private mac(body: string): string {
    return createHmac("sha256", this.#jwtKey).update(body).digest("base64url");
  }

  verify(token: string): string | null {
    const [header, payload, signature, ...rest] = token.split(".");
    if (header !== JWT_HEADER || payload === undefined || signature === undefined || rest.length > 0) {
      return null;
    }
    const expected = Buffer.from(this.mac(`${header}.${payload}`));
    const given = Buffer.from(signature);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;

    let claims: unknown;
    try {
      claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    } catch {
      return null;
    }
    const parsed = claimsSchema.safeParse(claims);
    if (!parsed.success) return null;
    const { iss, sub, exp } = parsed.data;
    return iss === this.issuer && exp > nowSeconds() ? sub : null;
  }

  private assertUnused(jti: string): void {
    const now = nowSeconds();
    for (const [hash, expiresAt] of this.redeemed) {
      if (expiresAt > now) break;
      this.redeemed.delete(hash);
    }
    if (this.redeemed.has(jti)) {
      throw new Sep10Error("The challenge transaction has already been used.");
    }
  }
}

/** Run an SDK challenge check, turning its failure into a `Sep10Error`. */
function challengeCheck<T>(check: () => T): T {
  try {
    return check();
  } catch (err) {
    throw new Sep10Error(err instanceof Error ? err.message : "The challenge transaction is not valid.");
  }
}

/** The network's SEP-10 service, or undefined when sign-in is not configured. */
export function sep10For(
  config: Config,
  network: NetworkConfig,
  rpc: Pick<RpcLike, "getLedgerEntries">,
  db: Storage,
): Sep10Auth | undefined {
  const { SEP10_SIGNING_KEY: signingKey, SEP10_JWT_SECRET: jwtSecret, SEP10_HOME_DOMAIN: homeDomain } = config;
  if (!signingKey || !jwtSecret || !homeDomain) return undefined;
  const webAuthDomain = config.SEP10_WEB_AUTH_DOMAIN ?? homeDomain;
  return new Sep10Auth({
    signingKey,
    jwtSecret,
    homeDomain,
    webAuthDomain,
    networkPassphrase: network.networkPassphrase,
    issuer: `https://${webAuthDomain}/api/${network.name}/auth`,
    tokenTtlS: config.SEP10_JWT_TTL_S,
    refreshTtlS: config.SEP10_REFRESH_TTL_S,
    loadAccount: accountLoader(rpc),
    db,
  });
}

/** Prefix that distinguishes an API key from a SEP-10 JWT bearer token. */
export const API_KEY_PREFIX = "pfk_";

/** HMAC key used to hash API keys before storing them. */
const API_KEY_HMAC_SECRET = "payflow-api-key-v1";

/** Generate a new random API key with the `pfk_` prefix. */
export function generateApiKey(): string {
  return `${API_KEY_PREFIX}${randomBytes(20).toString("hex")}`;
}

/** One-way hash of an API key for safe storage. */
export function hashApiKey(key: string): string {
  return createHmac("sha256", API_KEY_HMAC_SECRET).update(key).digest("hex");
}

/**
 * The account a request's `Authorization: Bearer` SEP-10 token was issued to.
 * `value` is null when no Authorization header was sent, so the route falls
 * back to its signed-message proof. A header that is not a valid, unexpired
 * token for this network is answered with `401 unauthorized` here.
 */
export function sessionOf(req: Request, res: Response, auth: Sep10Auth | undefined): Validated<string | null> {
  const header = req.headers.authorization;
  if (header === undefined) return { ok: true, value: null };
  const token = /^Bearer\s+(\S+)$/i.exec(header)?.[1];
  const account = token !== undefined && token.length <= 4_096 && auth ? auth.verify(token) : null;
  if (account === null) {
    sendApiError(
      res,
      req,
      401,
      "unauthorized",
      auth ? "The bearer token is invalid or has expired; sign in again." : "SEP-10 sign-in is not enabled on this instance.",
    );
    return { ok: false };
  }
  return { ok: true, value: account };
}

/**
 * Async variant of `sessionOf` that also accepts per-merchant API keys.
 *
 * Returns the authenticated merchant address when the request carries a valid
 * SEP-10 JWT or a valid, unrevoked `pfk_` API key. Returns `null` when no
 * `Authorization` header was sent. Sends `401` and returns `{ ok: false }`
 * for any malformed or revoked credential.
 *
 * Pass `db` to enable API key look-ups; without it, only SEP-10 JWT is checked.
 */
export async function resolveSession(
  req: Request,
  res: Response,
  auth: Sep10Auth | undefined,
  db?: Storage,
): Promise<Validated<string | null>> {
  const header = req.headers.authorization;
  if (header === undefined) return { ok: true, value: null };
  const token = /^Bearer\s+(\S+)$/i.exec(header)?.[1];
  if (!token) {
    sendApiError(res, req, 401, "unauthorized", "Invalid Authorization header format.");
    return { ok: false };
  }

  // API key path: `pfk_` prefix distinguishes a key from a JWT.
  if (token.startsWith(API_KEY_PREFIX) && db) {
    const keyHash = hashApiKey(token);
    const record = await db.get<{ id: number; merchant: string; scopes: string; revoked: number }>(
      "SELECT id, merchant, scopes, revoked FROM merchant_api_keys WHERE key_hash = ?",
      [keyHash],
    );
    if (!record || record.revoked !== 0) {
      sendApiError(res, req, 401, "unauthorized", "The API key is invalid or has been revoked.");
      return { ok: false };
    }
    // Update last_used_at; fire-and-forget is acceptable here.
    void db.run(
      "UPDATE merchant_api_keys SET last_used_at = ? WHERE id = ?",
      [Math.floor(Date.now() / 1000), record.id],
    );
    return { ok: true, value: record.merchant };
  }

  // SEP-10 JWT path.
  const account = auth ? auth.verify(token) : null;
  if (account === null) {
    sendApiError(
      res,
      req,
      401,
      "unauthorized",
      auth ? "The bearer token is invalid or has expired; sign in again." : "SEP-10 sign-in is not enabled on this instance.",
    );
    return { ok: false };
  }
  return { ok: true, value: account };
}

const challengeQuerySchema = z.object({
  account: z
    .string()
    .refine((value) => StrKey.isValidEd25519PublicKey(value), "must be a Stellar account (G...)"),
  memo: z.string().max(256).optional(),
  home_domain: authDomainSchema.optional(),
  // SEP-10 permits clients to send this; the server does not use it to
  // authenticate the account.
  client_domain: authDomainSchema.optional(),
}).strict();

const tokenBodySchema = z.object({ transaction: z.string().min(1).max(16_384) }).strict();

/** Rotating a refresh token returns a new short-lived JWT and the next refresh token. */
const rotateBodySchema = z.object({
  refresh_token: z.string().min(1),
});

/**
 * `GET /api/auth`: a SEP-10 challenge. `POST /api/auth`: a JWT for a signed
 * challenge, sent as JSON or as a form, as SEP-10 requires both. Every
 * answer, including an error, carries `Access-Control-Allow-Origin: *` (set
 * in app.ts) and `Cache-Control: no-store`.
 * `POST /api/auth/rotate`: exchange a refresh token for a new JWT and the
 * next refresh token; the consumed token is revoked.
 */
export function authRouter(auth: Sep10Auth): Router {
  const r = Router();

  r.use("/auth", (_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  });

  r.get("/auth", queryOnly("account", "memo", "home_domain", "client_domain"), (req, res) => {
    const parsed = validate(req, res, "query", challengeQuerySchema, req.query);
    if (!parsed.ok) return;
    const { account, memo, home_domain: homeDomain } = parsed.value;
    // Merchants are plain accounts: a shared (memo) account cannot prove it
    // is the merchant. `client_domain` is ignored, as SEP-10 allows.
    if (memo !== undefined) {
      sendApiError(res, req, 400, "invalid_request", undefined, [
        { path: "memo", message: "memos are not supported; authenticate as the account itself" },
      ]);
      return;
    }
    if (homeDomain !== undefined && homeDomain !== auth.homeDomain) {
      sendApiError(res, req, 400, "invalid_request", undefined, [
        { path: "home_domain", message: `must be ${auth.homeDomain}` },
      ]);
      return;
    }
    const body: AuthChallengeResponse = auth.challenge(account);
    res.json(body);
  });

  r.post(
    "/auth",
    queryOnly(),
    express.urlencoded({ extended: false, limit: "64kb" }),
    async (req, res) => {
    const parsed = validate(req, res, "body", tokenBodySchema, req.body);
    if (!parsed.ok) return;
    let body: AuthTokenResponse;
    try {
      body = await auth.token(parsed.value.transaction);
    } catch (err) {
      if (!(err instanceof Sep10Error)) throw err;
      sendApiError(res, req, 400, "invalid_request", err.message, [
        { path: "transaction", message: err.message },
      ]);
      return;
    }
    res.json(body);
    },
  );

  /**
   * Rotate a refresh token: the caller presents the refresh token received
   * at sign-in or at the last rotation, and receives a new short-lived JWT
   * plus the next refresh token. The consumed token is revoked, so a stolen
   * refresh token can only be used once.
   */
  r.post("/auth/rotate", express.json({ limit: "64kb" }), async (req, res) => {
    const parsed = validate(req, res, "body", rotateBodySchema, req.body);
    if (!parsed.ok) return;
    const rotated = await auth.rotate(parsed.value.refresh_token);
    if (rotated === null) {
      sendApiError(res, req, 401, "unauthorized", "The refresh token is unknown, revoked or expired.", [
        { path: "refresh_token", message: "refresh token is not valid for rotation" },
      ]);
      return;
    }
    res.json(rotated);
  });

  return r;
}

import { createHmac, timingSafeEqual } from "node:crypto";
import express, { Router, type Request, type Response } from "express";
import { Keypair, StrKey, WebAuth, xdr } from "@stellar/stellar-sdk";
import { z } from "zod";
import type { Config, NetworkConfig } from "../config.ts";
import type { RpcLike } from "../lib/stellar.ts";
import type { AuthChallengeResponse, AuthTokenResponse } from "./types.ts";
import { sendApiError } from "./errors.ts";
import { validate, type Validated } from "./validate.ts";

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
  loadAccount: AccountLoader;
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
  private readonly loadAccount: AccountLoader;
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
    this.loadAccount = options.loadAccount;
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
    return { token: `${body}.${this.mac(body)}` };
  }

  /**
   * The account a JWT was issued to, or null when it is malformed, signed
   * with another key or algorithm, tampered with, expired, or issued for
   * another network.
   */
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

  private mac(body: string): string {
    return createHmac("sha256", this.#jwtKey).update(body).digest("base64url");
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
    loadAccount: accountLoader(rpc),
  });
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
  const account = token !== undefined && auth ? auth.verify(token) : null;
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
  memo: z.string().optional(),
  home_domain: z.string().optional(),
});

const tokenBodySchema = z.object({ transaction: z.string().min(1) });

/**
 * `GET /api/auth`: a SEP-10 challenge. `POST /api/auth`: a JWT for a signed
 * challenge, sent as JSON or as a form, as SEP-10 requires both. Every
 * answer, including an error, carries `Access-Control-Allow-Origin: *` (set
 * in app.ts) and `Cache-Control: no-store`.
 */
export function authRouter(auth: Sep10Auth): Router {
  const r = Router();

  r.use("/auth", (_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  });

  r.get("/auth", (req, res) => {
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

  r.post("/auth", express.urlencoded({ extended: false, limit: "64kb" }), async (req, res) => {
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
  });

  return r;
}

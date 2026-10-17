import assert from "node:assert/strict";
import { test, describe } from "node:test";
import {
  TokenMetadataService,
  TokenMetadataUnavailable,
  asReader,
  isNativeToken,
  nativeMetadata,
  nativeTokenId,
  unavailableTokens,
  type TokenReader,
} from "../src/lib/tokens.ts";
import type { TokenMetadata } from "../src/routes/types.ts";

const TESTNET = "Test SDF Network ; September 2015";
const USDC = "CCW67TSZV3SSS2HXMBQ5JFGHPJDUIVAPHCIMTQWGLP3OK53N2OQ6TQ7N";
const OTHER = "CDDTZVOGNBJAYJMAKFJOL5FVQJ6ZMFOGPP2P4Y5H3Y4TQF5QZ5N2ABCDEF";

const meta = (token: string, symbol = "USD", decimals = 7): TokenMetadata => ({
  token,
  symbol,
  name: `${symbol} token`,
  decimals,
});

describe("native token id", () => {
  test("native SAC resolves to XLM / 7 without a read", () => {
    const id = nativeTokenId(TESTNET);
    assert.ok(isNativeToken(id, TESTNET));
    assert.ok(isNativeToken("native", TESTNET));
    assert.ok(isNativeToken("  Native  ", TESTNET));
    const m = nativeMetadata(TESTNET);
    assert.equal(m.token, id);
    assert.equal(m.symbol, "XLM");
    assert.equal(m.decimals, 7);
  });

  test("an arbitrary contract id is not native", () => {
    assert.ok(!isNativeToken(USDC, TESTNET));
  });
});

describe("TokenMetadataService caching", () => {
  test("reads once, then serves from cache", async () => {
    let calls = 0;
    const reader: TokenReader = async (id) => {
      calls += 1;
      return meta(id, "AAA", 6);
    };
    const svc = new TokenMetadataService(reader);

    const first = await svc.fetch(USDC);
    const second = await svc.fetch(USDC);
    assert.equal(calls, 1, "second lookup must not hit the reader");
    assert.deepEqual(first, second);
    assert.equal(svc.size, 1);
    assert.deepEqual(svc.cached(USDC), first);
  });

  test("concurrent lookups of one token share a single read", async () => {
    let calls = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reader: TokenReader = async (id) => {
      calls += 1;
      await gate;
      return meta(id);
    };
    const svc = new TokenMetadataService(reader);

    const a = svc.fetch(USDC);
    const b = svc.fetch(USDC);
    release();
    const [ra, rb] = await Promise.all([a, b]);
    assert.equal(calls, 1, "the two in-flight fetches must share one read");
    assert.deepEqual(ra, rb);
  });

  test("entries expire after the TTL", async () => {
    let now = 1_000;
    let calls = 0;
    const reader: TokenReader = async (id) => {
      calls += 1;
      return meta(id);
    };
    const svc = new TokenMetadataService(reader, { ttlMs: 500, now: () => now });

    await svc.fetch(USDC);
    assert.equal(svc.cached(USDC)?.symbol, "USD");
    now += 501; // past expiry
    assert.equal(svc.cached(USDC), undefined);
    await svc.fetch(USDC);
    assert.equal(calls, 2, "an expired entry is re-read");
  });

  test("cache is bounded and evicts the least recently used", async () => {
    const reader: TokenReader = async (id) => meta(id);
    const svc = new TokenMetadataService(reader, { max: 2 });

    await svc.fetch(USDC);
    await svc.fetch(OTHER);
    // Touch USDC so `OTHER` becomes the least recently used.
    assert.equal(svc.cached(USDC)?.token, USDC);
    await svc.fetch("CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABCDEF");
    assert.equal(svc.size, 2);
    assert.equal(svc.cached(OTHER), undefined, "the least recently used entry is dropped");
    assert.ok(svc.cached(USDC));
  });

  test("a failure is not cached; the next lookup retries", async () => {
    let calls = 0;
    const reader: TokenReader = async (id) => {
      calls += 1;
      if (calls === 1) throw new TokenMetadataUnavailable("rpc down");
      return meta(id);
    };
    const svc = new TokenMetadataService(reader);

    await assert.rejects(() => svc.fetch(USDC), TokenMetadataUnavailable);
    assert.equal(svc.cached(USDC), undefined, "a failed read leaves nothing cached");
    const ok = await svc.fetch(USDC);
    assert.equal(ok.symbol, "USD");
    assert.equal(calls, 2);
  });

  test("resolve swallows failures so a list endpoint cannot 500 on an RPC outage", async () => {
    const svc = new TokenMetadataService(unavailableTokens);
    assert.equal(await svc.resolve(USDC), null);
    assert.equal(await svc.resolve(undefined), null);
  });

  test("native resolves through the service without a read", async () => {
    let calls = 0;
    const reader: TokenReader = async (id) => {
      calls += 1;
      return meta(id);
    };
    const svc = new TokenMetadataService(reader, { networkPassphrase: TESTNET });
    const m = await svc.fetch(nativeTokenId(TESTNET));
    assert.equal(m.symbol, "XLM");
    assert.equal(m.decimals, 7);
    assert.equal(calls, 0, "native metadata is never read from the network");
  });

  test("clear drops cache and in-flight reads", async () => {
    const svc = new TokenMetadataService(async (id) => meta(id));
    await svc.fetch(USDC);
    svc.clear();
    assert.equal(svc.size, 0);
    assert.equal(svc.cached(USDC), undefined);
  });
});

describe("asReader", () => {
  test("null falls back to the unavailable reader", async () => {
    const reader = asReader(null);
    await assert.rejects(() => reader(USDC), TokenMetadataUnavailable);
  });

  test("an explicit reader is passed through", async () => {
    const reader = asReader(async (id) => meta(id, "BBB", 4));
    assert.equal((await reader(USDC)).symbol, "BBB");
  });
});

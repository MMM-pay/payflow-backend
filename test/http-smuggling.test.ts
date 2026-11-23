import assert from "node:assert/strict";
import { test, describe, before, after } from "node:test";
import { type Server } from "node:http";
import net from "node:net";
import { openDatabase } from "../src/lib/db.ts";
import { createApp } from "../src/app.ts";
import type { Config } from "../src/config.ts";

const config = { CORS_ORIGIN: "*" } as unknown as Config;

function rawRequest(port: number, payload: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1", () => socket.write(payload));
    let data = "";
    const timer = setTimeout(() => {
      socket.destroy();
      resolve({ status: 0, body: data });
    }, 2000);
    socket.on("data", (chunk) => {
      data += chunk.toString("latin1");
      if (data.includes("\r\n\r\n")) {
        clearTimeout(timer);
        const statusLine = data.split("\r\n")[0] ?? "";
        const status = Number(statusLine.split(" ")[1] ?? 0);
        socket.destroy();
        resolve({ status, body: data });
      }
    });
    socket.on("end", () => {
      clearTimeout(timer);
      const statusLine = data.split("\r\n")[0] ?? "";
      const status = Number(statusLine.split(" ")[1] ?? 0);
      resolve({ status, body: data });
    });
    socket.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

describe("HTTP request smuggling hardening", () => {
  let server: Server;
  let port: number;

  before(async () => {
    const db = openDatabase(":memory:");
    const app = createApp(db, config);
    server = app.listen(0);
    await new Promise<void>((resolve) => server.on("listening", () => resolve()));
    const address = server.address();
    port = typeof address === "object" && address ? address.port : 0;
  });

  after(() => {
    server.close();
  });

  test("allows a normal request", async () => {
    const res = await rawRequest(port, "GET /health HTTP/1.1\r\nHost: x\r\n\r\n");
    assert.equal(res.status, 200);
  });

  test("rejects a request with both Content-Length and Transfer-Encoding", async () => {
    const payload = "POST / HTTP/1.1\r\nHost: x\r\nContent-Length: 6\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n";
    const res = await rawRequest(port, payload);
    assert.equal(res.status, 400);
  });

  test("rejects an obfuscated Transfer-Encoding", async () => {
    const payload = "POST / HTTP/1.1\r\nHost: x\r\nTransfer-Encoding: xchunked\r\n\r\n";
    const res = await rawRequest(port, payload);
    assert.equal(res.status, 400);
  });

  test("rejects a connection upgrade", async () => {
    const payload = "GET / HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: h2c\r\n\r\n";
    const res = await rawRequest(port, payload);
    // Node's parser may already reject; either way it must not be a 200.
    assert.notEqual(res.status, 200);
  });
});

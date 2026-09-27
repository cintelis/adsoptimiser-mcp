// Shared test fixtures: a stub of the Ads Optimiser API on a local port, and
// an in-process MCP client wired to a fresh server instance. (This file holds
// no tests; node --test loads it and finds none.)

import { createServer as createHttpServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.mjs";

export const TOKEN = `ao_${"t".repeat(43)}`;

export function tempDir(prefix = "adsopt-mcp-") {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/**
 * A stub API. `handler(req)` gets { method, path, url, headers, body (Buffer) }
 * and returns { status?, json?, body?, headers? }; anything unhandled is 404.
 * Every request is recorded in `requests`.
 */
export async function startStub(handler = () => undefined) {
  const requests = [];
  let current = handler;
  const server = createHttpServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const url = new URL(req.url, "http://stub");
    const record = {
      method: req.method,
      path: url.pathname,
      url,
      headers: req.headers,
      body: Buffer.concat(chunks),
    };
    requests.push(record);
    let reply;
    try {
      reply = (await current(record)) ?? { status: 404, json: { error: "Not found" } };
    } catch (err) {
      reply = { status: 500, json: { error: String(err) } };
    }
    const headers = { ...(reply.headers ?? {}) };
    let payload = reply.body ?? "";
    if (reply.json !== undefined) {
      headers["content-type"] = "application/json";
      payload = JSON.stringify(reply.json);
    }
    res.writeHead(reply.status ?? 200, headers);
    res.end(payload);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    setHandler(fn) {
      current = fn;
    },
    /** Parse a recorded multipart body the way a server would. */
    async formData(record) {
      return new Request("http://stub/", {
        method: "POST",
        headers: { "content-type": record.headers["content-type"] },
        body: record.body,
      }).formData();
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** A connected in-memory MCP client over a fresh server pointed at `baseUrl`. */
export async function startClient(baseUrl, options = {}) {
  const home = tempDir();
  const sleeps = [];
  const { server, cache, config } = createServer({
    baseUrl,
    appUrl: "https://app.example.test",
    cacheDir: home.dir,
    cwd: options.cwd ?? home.dir,
    env: options.env ?? {},
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    imageWaitSeconds: options.imageWaitSeconds ?? 9,
    pollIntervalMs: options.pollIntervalMs ?? 3000,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    cache,
    config,
    home: home.dir,
    sleeps,
    connectToken(extra = {}) {
      cache.save({ token: TOKEN, workspaceId: "ws_1", workspaceName: "Test", ...extra });
    },
    async call(name, args = {}) {
      const result = await client.callTool({ name, arguments: args });
      return {
        text: result.content.map((c) => c.text ?? "").join("\n"),
        structured: result.structuredContent,
        isError: result.isError === true,
      };
    },
    async close() {
      await client.close();
      home.cleanup();
    },
  };
}

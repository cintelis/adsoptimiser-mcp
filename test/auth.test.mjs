import { after, afterEach, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TokenCache, cachePathFor } from "../src/api.mjs";
import { TOKEN, startClient, startStub, tempDir } from "./helpers.mjs";

const DEVICE = {
  device_code: "dev_secret_code_value",
  user_code: "BCDF-GHJK",
  verification_uri: "https://app.adsoptimiser.com.au/#/device",
  verification_uri_complete: "https://app.adsoptimiser.com.au/#/device?code=BCDF-GHJK",
  expires_in: 600,
  interval: 5,
};
const GRANTED = {
  access_token: TOKEN,
  token_type: "Bearer",
  token_id: "tok_1",
  workspace_id: "ws_1",
  workspace_name: "Acme Ads",
  user_email: "person@example.com",
};

function json(record) {
  return JSON.parse(record.body.toString("utf8") || "{}");
}

describe("token cache", () => {
  it("uses one file per host in the given directory", () => {
    assert.equal(
      cachePathFor("https://api.adsoptimiser.com.au", "/home/x"),
      join("/home/x", ".adsoptimiser-mcp-api.adsoptimiser.com.au.json")
    );
    assert.equal(
      cachePathFor("http://localhost:8787", "/home/x"),
      join("/home/x", ".adsoptimiser-mcp-localhost_8787.json")
    );
  });

  it("writes, reads and clears, and treats a corrupt file as empty", () => {
    const tmp = tempDir();
    try {
      const cache = new TokenCache(join(tmp.dir, "c.json"));
      assert.deepEqual(cache.load(), {});
      assert.equal(cache.token, null);
      cache.save({ token: TOKEN, workspaceId: "ws_1" });
      assert.equal(cache.token, TOKEN);
      assert.equal(JSON.parse(readFileSync(cache.path, "utf8")).workspaceId, "ws_1");
      writeFileSync(cache.path, "{not json");
      assert.deepEqual(cache.load(), {});
      cache.clear();
      assert.equal(existsSync(cache.path), false);
      cache.clear(); // idempotent
    } finally {
      tmp.cleanup();
    }
  });

  it("restricts the file to its owner (mode 0600) where the OS supports it", { skip: process.platform === "win32" }, () => {
    const tmp = tempDir();
    try {
      const path = join(tmp.dir, "c.json");
      writeFileSync(path, "{}", { mode: 0o644 });
      new TokenCache(path).save({ token: TOKEN });
      assert.equal(statSync(path).mode & 0o777, 0o600);
    } finally {
      tmp.cleanup();
    }
  });
});

describe("device flow", () => {
  let stub;
  let ctx;
  before(async () => {
    stub = await startStub();
  });
  after(async () => {
    await stub.close();
  });
  afterEach(async () => {
    await ctx?.close();
    stub.requests.length = 0;
  });

  it("connect starts the flow, shows the URL and code, and hides the device code", async () => {
    stub.setHandler((r) =>
      r.method === "POST" && r.path === "/api/v1/device/code" ? { json: DEVICE } : undefined
    );
    ctx = await startClient(stub.url);
    const res = await ctx.call("adsoptimiser_connect");
    assert.equal(res.isError, false);
    assert.match(res.text, /#\/device\?code=BCDF-GHJK/);
    assert.match(res.text, /matches: BCDF-GHJK/);
    assert.match(res.text, /workspace/i);
    assert.ok(!res.text.includes(DEVICE.device_code));
    assert.ok(!JSON.stringify(res.structured).includes(DEVICE.device_code));

    const [req] = stub.requests;
    assert.deepEqual(json(req), { client_name: "Claude (MCP)" });
    assert.equal(req.headers.authorization, undefined);
    assert.equal(ctx.cache.load().pending.deviceCode, DEVICE.device_code);
  });

  it("finish_connect polls through pending and slow_down, honouring the interval, then stores the token", async () => {
    const answers = [
      { status: 400, json: { error: "authorization_pending", error_description: "Waiting" } },
      { status: 400, json: { error: "slow_down", error_description: "Too fast", interval: 10 } },
      { json: GRANTED },
    ];
    stub.setHandler((r) => {
      if (r.path === "/api/v1/device/code") return { json: DEVICE };
      if (r.path === "/api/v1/device/token") return answers.shift();
      return undefined;
    });
    ctx = await startClient(stub.url);
    await ctx.call("adsoptimiser_connect");
    const res = await ctx.call("adsoptimiser_finish_connect");

    assert.equal(res.isError, false, res.text);
    assert.match(res.text, /Connected as person@example.com to workspace "Acme Ads"/);
    assert.ok(!res.text.includes(TOKEN));
    assert.ok(!JSON.stringify(res.structured).includes(TOKEN));

    const polls = stub.requests.filter((r) => r.path === "/api/v1/device/token");
    assert.equal(polls.length, 3);
    assert.equal(json(polls[0]).device_code, DEVICE.device_code);
    assert.equal(json(polls[0]).grant_type, "urn:ietf:params:oauth:grant-type:device_code");
    // Waited (roughly) the interval, then the widened slow_down interval.
    assert.equal(ctx.sleeps.length, 2);
    assert.ok(ctx.sleeps[0] > 4000 && ctx.sleeps[0] <= 5000, `first wait ${ctx.sleeps[0]}`);
    assert.ok(ctx.sleeps[1] > 9000 && ctx.sleeps[1] <= 10000, `second wait ${ctx.sleeps[1]}`);

    const state = ctx.cache.load();
    assert.equal(state.token, TOKEN);
    assert.equal(state.workspaceName, "Acme Ads");
    assert.equal(state.pending, undefined);
  });

  it("finish_connect keeps waiting after three pending answers", async () => {
    stub.setHandler((r) => {
      if (r.path === "/api/v1/device/code") return { json: DEVICE };
      return { status: 400, json: { error: "authorization_pending" } };
    });
    ctx = await startClient(stub.url);
    await ctx.call("adsoptimiser_connect");
    const res = await ctx.call("adsoptimiser_finish_connect");
    assert.equal(res.isError, false);
    assert.match(res.text, /Still waiting for approval/);
    assert.ok(ctx.cache.load().pending);
  });

  for (const [error, pattern] of [
    ["expired_token", /expired/],
    ["access_denied", /not approved/],
    ["invalid_grant", /not completed/],
  ]) {
    it(`finish_connect stops and clears the pending flow on ${error}`, async () => {
      stub.setHandler((r) => {
        if (r.path === "/api/v1/device/code") return { json: DEVICE };
        return { status: 400, json: { error, error_description: "nope" } };
      });
      ctx = await startClient(stub.url);
      await ctx.call("adsoptimiser_connect");
      const res = await ctx.call("adsoptimiser_finish_connect");
      assert.equal(res.isError, true);
      assert.match(res.text, pattern);
      assert.match(res.text, /adsoptimiser_connect/);
      assert.deepEqual(ctx.cache.load(), {});
    });
  }

  it("finish_connect refuses when nothing is pending, and notices a locally expired code", async () => {
    ctx = await startClient(stub.url);
    const none = await ctx.call("adsoptimiser_finish_connect");
    assert.equal(none.isError, true);
    assert.match(none.text, /No sign-in is in progress/);

    ctx.cache.save({ pending: { deviceCode: "x", userCode: "Y", interval: 5, expiresAt: Date.now() - 1 } });
    const expired = await ctx.call("adsoptimiser_finish_connect");
    assert.equal(expired.isError, true);
    assert.match(expired.text, /expired/);
    assert.equal(stub.requests.length, 0);
  });

  it("connect refuses to replace an existing connection", async () => {
    ctx = await startClient(stub.url);
    ctx.connectToken();
    const res = await ctx.call("adsoptimiser_connect");
    assert.match(res.text, /Already connected/);
    assert.equal(stub.requests.length, 0);
  });

  it("status reports the account from /api/v1/me with the bearer token", async () => {
    stub.setHandler((r) =>
      r.path === "/api/v1/me"
        ? {
            json: {
              user_email: "person@example.com",
              workspace_id: "ws_1",
              workspace_name: "Acme Ads",
              role: "member",
            },
          }
        : undefined
    );
    ctx = await startClient(stub.url);
    const disconnected = await ctx.call("adsoptimiser_status");
    assert.match(disconnected.text, /Not connected/);
    assert.equal(stub.requests.length, 0);

    ctx.connectToken();
    const res = await ctx.call("adsoptimiser_status");
    assert.match(res.text, /person@example.com in workspace "Acme Ads" \(role: member\)/);
    assert.equal(stub.requests[0].headers.authorization, `Bearer ${TOKEN}`);
    assert.ok(!res.text.includes(TOKEN));
  });

  for (const code of ["token_revoked", "invalid_token"]) {
    it(`a 401 ${code} deletes the cached token and asks to reconnect`, async () => {
      stub.setHandler(() => ({ status: 401, json: { error: "This API token was revoked.", code } }));
      ctx = await startClient(stub.url);
      ctx.connectToken();
      const res = await ctx.call("adsoptimiser_list_jobs");
      assert.equal(res.isError, true);
      assert.match(res.text, /no longer valid/);
      assert.match(res.text, /adsoptimiser_connect/);
      assert.equal(existsSync(ctx.cache.path), false);
    });
  }

  it("other 401s keep the cache (the token may be fine)", async () => {
    stub.setHandler(() => ({ status: 401, json: { error: "Authentication required", code: "auth_required" } }));
    ctx = await startClient(stub.url);
    ctx.connectToken();
    const res = await ctx.call("adsoptimiser_get_job", { job_id: "job_1" });
    assert.equal(res.isError, true);
    assert.equal(ctx.cache.token, TOKEN);
  });

  it("disconnect revokes the token on the server, then deletes it locally", async () => {
    stub.setHandler((r) =>
      r.method === "DELETE" && r.path === "/api/v1/tokens/current"
        ? { json: { revoked: true, token_id: "tok_1" } }
        : undefined
    );
    ctx = await startClient(stub.url);
    ctx.connectToken();
    const res = await ctx.call("adsoptimiser_disconnect");
    assert.match(res.text, /revoked on the server/);
    assert.equal(stub.requests[0].headers.authorization, `Bearer ${TOKEN}`);
    assert.equal(existsSync(ctx.cache.path), false);
  });

  it("disconnect still deletes the local token when the server cannot be reached", async () => {
    ctx = await startClient("http://127.0.0.1:9"); // nothing listens on the discard port
    ctx.connectToken();
    const res = await ctx.call("adsoptimiser_disconnect");
    assert.equal(res.isError, false);
    assert.match(res.text, /could not be revoked on the server/);
    assert.match(res.text, /Profile > API tokens/);
    assert.equal(existsSync(ctx.cache.path), false);
  });

  it("tools that need a token say so without calling the API", async () => {
    ctx = await startClient(stub.url);
    const res = await ctx.call("adsoptimiser_list_models");
    assert.equal(res.isError, true);
    assert.match(res.text, /Not connected .* Call adsoptimiser_connect/);
    assert.equal(stub.requests.length, 0);
  });
});

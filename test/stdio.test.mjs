// Launches the real bin over stdio, as Claude Desktop and Claude Code do.

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { TOOL_ROUTES } from "../src/server.mjs";
import { startStub, tempDir } from "./helpers.mjs";

const SERVER = fileURLToPath(new URL("../server.mjs", import.meta.url));

describe("stdio server", () => {
  let stub;
  let home;
  let client;
  before(async () => {
    stub = await startStub((r) =>
      r.path === "/api/v1/device/code"
        ? {
            json: {
              device_code: "d",
              user_code: "BCDF-GHJK",
              verification_uri: "https://app.adsoptimiser.com.au/#/device",
              verification_uri_complete: "https://app.adsoptimiser.com.au/#/device?code=BCDF-GHJK",
              expires_in: 600,
              interval: 5,
            },
          }
        : undefined
    );
    home = tempDir("adsopt-home-");
    client = new Client({ name: "stdio-smoke", version: "0.0.0" });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [SERVER],
        env: {
          ...process.env,
          HOME: home.dir,
          USERPROFILE: home.dir,
          ADSOPTIMISER_URL: stub.url,
        },
        stderr: "pipe",
      })
    );
  });
  after(async () => {
    await client?.close();
    await stub.close();
    home.cleanup();
  });

  it("answers initialize with its name and version", () => {
    const info = client.getServerVersion();
    assert.equal(info.name, "adsoptimiser");
    assert.match(info.version, /^\d+\.\d+\.\d+/);
    assert.match(client.getInstructions() ?? "", /adsoptimiser_connect/);
  });

  it("lists every tool, all prefixed adsoptimiser_, each with an input schema", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    assert.deepEqual(names, Object.keys(TOOL_ROUTES).sort());
    for (const t of tools) {
      assert.match(t.name, /^adsoptimiser_/);
      assert.equal(t.inputSchema.type, "object");
      assert.ok(t.description.length > 20, t.name);
    }
    const download = tools.find((t) => t.name === "adsoptimiser_download_job");
    assert.deepEqual(download.inputSchema.required, ["job_id"]);
  });

  it("uses ADSOPTIMISER_URL and a token cache in the home directory", async () => {
    const status = await client.callTool({ name: "adsoptimiser_status", arguments: {} });
    assert.match(status.content[0].text, new RegExp(`Not connected to ${stub.url}`));

    const connect = await client.callTool({ name: "adsoptimiser_connect", arguments: {} });
    assert.match(connect.content[0].text, /BCDF-GHJK/);
    const pending = await client.callTool({ name: "adsoptimiser_status", arguments: {} });
    assert.match(pending.content[0].text, /waiting for approval/);
  });
});

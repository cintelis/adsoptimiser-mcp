// The published bin is dist/server.mjs, built by `npm run build` (run before
// `npm test` by the pretest script). It must start with no node_modules at
// all: it is copied alone into an empty temp folder and driven over stdio.

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { builtinModules } from "node:module";
import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { TOOL_ROUTES } from "../src/server.mjs";
import { startStub, tempDir } from "./helpers.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const BUNDLE = join(ROOT, "dist", "server.mjs");
const PKG = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));

describe("bundled server (dist/server.mjs)", () => {
  it("is what the package publishes, with no runtime dependencies", () => {
    assert.ok(existsSync(BUNDLE), "dist/server.mjs is missing: run npm run build");
    assert.deepEqual(PKG.bin, { "adsoptimiser-mcp": "dist/server.mjs" });
    assert.equal(PKG.dependencies, undefined);
    assert.equal(PKG.optionalDependencies, undefined);
    assert.equal(PKG.peerDependencies, undefined);
    assert.ok(PKG.files.includes("dist/server.mjs"));
    assert.ok(readFileSync(BUNDLE, "utf8").startsWith("#!/usr/bin/env node\n"));
  });

  it("imports nothing but Node built-ins", () => {
    const source = readFileSync(BUNDLE, "utf8");
    const builtins = new Set(builtinModules);
    const specifiers = [
      ...source.matchAll(/^\s*(?:import|export)\b[^'"`;]*?\bfrom\s*["']([^"']+)["']/gm),
      ...source.matchAll(/^\s*import\s*["']([^"']+)["']/gm),
      ...source.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g),
      // Real calls only: ajv keeps require("ajv/...") inside string literals
      // for its standalone code generator, which this server never uses.
      ...source.matchAll(/(?:\b__require|(?<![\w'"`.])require)\(\s*["']([^"']+)["']\s*\)/g),
    ].map((m) => m[1]);
    const external = specifiers.filter((s) => !s.startsWith("node:") && !builtins.has(s));
    assert.deepEqual([...new Set(external)], []);
    assert.ok(specifiers.length > 0, "expected some node: imports");
  });

  describe("over stdio from an empty folder", () => {
    let stub;
    let home;
    let alone;
    let client;
    before(async () => {
      stub = await startStub();
      home = tempDir("adsopt-home-");
      alone = tempDir("adsopt-bundle-");
      const copy = join(alone.dir, "server.mjs");
      copyFileSync(BUNDLE, copy);
      client = new Client({ name: "bundle-smoke", version: "0.0.0" });
      await client.connect(
        new StdioClientTransport({
          command: process.execPath,
          args: [copy],
          cwd: alone.dir,
          env: {
            ...process.env,
            NODE_PATH: "",
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
      alone.cleanup();
    });

    it("reports the package version", () => {
      assert.deepEqual(client.getServerVersion(), { name: "adsoptimiser", version: PKG.version });
    });

    it("lists every tool with its input schema", async () => {
      const { tools } = await client.listTools();
      assert.deepEqual(tools.map((t) => t.name).sort(), Object.keys(TOOL_ROUTES).sort());
      const run = tools.find((t) => t.name === "adsoptimiser_run_pipeline");
      assert.ok(run.inputSchema.properties.graph, "run_pipeline takes an inline graph");
      const save = tools.find((t) => t.name === "adsoptimiser_save_pipeline");
      assert.deepEqual([...save.inputSchema.required].sort(), ["graph", "name"]);
      const create = tools.find((t) => t.name === "adsoptimiser_create_character");
      for (const field of ["image_paths", "image_urls", "job_ids", "voice", "default_voice_id"]) {
        assert.ok(create.inputSchema.properties[field], `create_character takes ${field}`);
      }
      const preview = tools.find((t) => t.name === "adsoptimiser_preview_voice");
      assert.deepEqual([...preview.inputSchema.required], ["voice"]);
      assert.ok(preview.inputSchema.properties.save_to, "preview_voice takes save_to");
      assert.ok(preview.inputSchema.properties.character_id, "preview_voice takes character_id");
      const assets = tools.find((t) => t.name === "adsoptimiser_list_character_assets");
      assert.deepEqual([...assets.inputSchema.required], ["character_id"]);
      for (const field of ["type", "cursor", "limit", "download_to"]) {
        assert.ok(assets.inputSchema.properties[field], `list_character_assets takes ${field}`);
      }
      const video = tools.find((t) => t.name === "adsoptimiser_generate_video");
      assert.ok(video.inputSchema.properties.character_id && video.inputSchema.properties.script);
    });

    it("answers a tool call", async () => {
      const status = await client.callTool({ name: "adsoptimiser_status", arguments: {} });
      assert.match(status.content[0].text, /Not connected/);
    });
  });
});

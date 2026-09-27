// Starts a built server over stdio and checks it answers initialize and
// tools/list, timing both. Uses only Node built-ins, so it runs against an
// installed tarball with no node_modules of its own.
//
//   node scripts/smoke.mjs [path/to/dist/server.mjs]

import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const server = resolve(process.argv[2] ?? fileURLToPath(new URL("../dist/server.mjs", import.meta.url)));
const expectedVersion = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8")
).version;
const home = mkdtempSync(join(tmpdir(), "adsopt-smoke-"));

const started = performance.now();
const child = spawn(process.execPath, [server], {
  stdio: ["pipe", "pipe", "inherit"],
  env: {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    // Nothing is called over the network during this check.
    ADSOPTIMISER_URL: "http://127.0.0.1:9",
  },
});

const timer = setTimeout(() => finish("no answer within 15 seconds"), 15_000);
function finish(error, detail) {
  clearTimeout(timer);
  child.kill();
  rmSync(home, { recursive: true, force: true });
  if (error) {
    console.error(`Smoke test failed: ${error}`);
    process.exit(1);
  }
  console.log(detail);
}

const send = (message) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
let buffer = "";
let initialisedAt = 0;
child.on("exit", (code) => finish(`server exited early with code ${code}`));
child.stdout.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    const message = JSON.parse(line);
    if (message.id === 1) {
      initialisedAt = performance.now() - started;
      const info = message.result?.serverInfo;
      if (info?.name !== "adsoptimiser" || info?.version !== expectedVersion) {
        child.removeAllListeners("exit");
        return finish(`unexpected serverInfo ${JSON.stringify(info)}; expected version ${expectedVersion}`);
      }
      send({ method: "notifications/initialized" });
      send({ id: 2, method: "tools/list" });
    } else if (message.id === 2) {
      child.removeAllListeners("exit");
      const tools = message.result?.tools ?? [];
      if (tools.length === 0 || !tools.every((t) => t.name.startsWith("adsoptimiser_"))) {
        return finish(`unexpected tools/list reply: ${line.slice(0, 200)}`);
      }
      finish(
        null,
        `OK: ${server} v${expectedVersion} initialised in ${initialisedAt.toFixed(0)} ms, listed ${tools.length} tools in ${(performance.now() - started).toFixed(0)} ms.`
      );
    }
  }
});

send({
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "adsoptimiser-smoke", version: "0.0.0" },
  },
});

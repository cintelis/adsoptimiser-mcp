// Bundles the stdio server into one self-contained ESM file, dist/server.mjs,
// so `npx` installs a single package with no dependencies. Resolving and
// installing the MCP SDK's dependency tree on every launch took longer than
// Claude Desktop's ~30 second start-up limit on Windows.
//
// Only the stdio path is imported, so the SDK's HTTP transports (express,
// hono and friends) are never reached and nothing from them is bundled.
// The licences of everything that is bundled go to dist/THIRD-PARTY-NOTICES.txt.

import { build } from "esbuild";
import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const outdir = join(root, "dist");
const outfile = join(outdir, "server.mjs");

/**
 * zod 4 re-exports every translation of its error messages (about 360 kB) as
 * `z.locales`. Nothing here reads it and English is configured separately, so
 * the barrel is reduced to English alone.
 */
const zodEnglishOnly = {
  name: "zod-english-only",
  setup(b) {
    // "." matches either path separator, so this works on Windows too.
    b.onLoad({ filter: /zod.v4.locales.index\.js$/ }, (args) => ({
      contents: 'export { default as en } from "./en.js";\n',
      resolveDir: dirname(args.path),
      loader: "js",
    }));
  },
};

rmSync(outdir, { recursive: true, force: true });

const result = await build({
  absWorkingDir: root,
  entryPoints: ["server.mjs"],
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node18",
  // Readable output: a stack trace in someone's Claude log should still point
  // at recognisable code, so nothing is minified.
  minify: false,
  sourcemap: false,
  legalComments: "none",
  metafile: true,
  logLevel: "warning",
  plugins: [zodEnglishOnly],
  define: {
    __ADSOPTIMISER_VERSION__: JSON.stringify(pkg.version),
  },
  // Bundled CommonJS (ajv) is wrapped by esbuild. Should a future version
  // require() a Node built-in, esbuild's ESM shim would throw, so provide a
  // real require. (test/bundle.test.mjs checks nothing else is required.)
  banner: {
    js: 'import { createRequire as __adsoptCreateRequire } from "node:module";\nconst require = __adsoptCreateRequire(import.meta.url);',
  },
});

// Every bundled package, with its licence text.
const packages = new Map();
for (const input of Object.keys(result.metafile.inputs)) {
  const match = input.match(/^(.*?node_modules\/((?:@[^/]+\/)?[^/]+))\//);
  if (match && !packages.has(match[2])) packages.set(match[2], join(root, match[1]));
}
const notices = [...packages.keys()].sort().map((name) => {
  const dir = packages.get(name);
  const meta = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  const licenceFile = readdirSync(dir).find((f) => /^(licen[cs]e|copying)(\.|$)/i.test(f));
  const text = licenceFile && existsSync(join(dir, licenceFile))
    ? readFileSync(join(dir, licenceFile), "utf8").trim()
    : `Licence: ${meta.license ?? "see package"}`;
  return `${name}@${meta.version} (${meta.license ?? "unknown"})\n\n${text}`;
});
writeFileSync(
  join(outdir, "THIRD-PARTY-NOTICES.txt"),
  `${pkg.name} bundles the following packages in dist/server.mjs.\n\n` +
    notices.join(`\n\n${"-".repeat(72)}\n\n`) +
    "\n"
);

const kb = (statSync(outfile).size / 1024).toFixed(0);
console.log(
  `Built dist/server.mjs (${kb} kB, v${pkg.version}) from ${Object.keys(result.metafile.inputs).length} modules. Bundled: ${[...packages.keys()].sort().join(", ")}`
);

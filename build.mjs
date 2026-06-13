// Build the GitHub Pages site into dist/: bundle the browser app with esbuild
// using a CONTENT HASH in the filename, so caching is automatic and never
// stale -- the URL changes only when the code does (no manual ?v bumping).
//
// The source modules stay split (docs/*.js) for local dev + the Node tests;
// only the browser entry is bundled here. Static assets are copied as-is.
import { build } from "esbuild";
import { readFileSync, writeFileSync, copyFileSync, rmSync, mkdirSync } from "node:fs";

const SRC = "docs";
const OUT = "dist";
const STATIC = ["servers.json", "favicon.svg"];

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const result = await build({
  entryPoints: [`${SRC}/app.js`],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2020",
  minify: true,
  sourcemap: true,
  outdir: OUT,
  entryNames: "[name]-[hash]",
  metafile: true,
  // The Node/CLI path in wcl.js dynamically imports these; never run in the
  // browser (guarded by IS_NODE), so just leave them unresolved.
  external: ["node:fs", "node:path", "node:url"],
});

const jsPath = Object.keys(result.metafile.outputs)
  .find((f) => f.endsWith(".js") && !f.endsWith(".map"));
const jsName = jsPath.split("/").pop(); // e.g. app-J3K9ZQ2P.js

let html = readFileSync(`${SRC}/index.html`, "utf8");
html = html.replace('src="./app.js"', `src="./${jsName}"`);
writeFileSync(`${OUT}/index.html`, html);

for (const f of STATIC) copyFileSync(`${SRC}/${f}`, `${OUT}/${f}`);

console.log(`built ${OUT}/${jsName} + index.html + ${STATIC.join(", ")}`);

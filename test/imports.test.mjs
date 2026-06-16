// Static guard: a module that USES a shared identifier (DIM.* / KIND.* / a shared
// helper) must IMPORT it. Catches the class of bug where a find-and-replace converts
// `finding("Gear", …)` -> `finding(DIM.GEAR, …)` across files but misses an import --
// which unit tests don't catch (the line only ReferenceErrors at runtime, on a code
// path a given test may not exercise). Pure text check; no network, no execution.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DOCS = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "docs");
// Identifiers that are USED as `NAME.` or `NAME(` and must be imported when used.
const GUARDED = ["DIM", "KIND", "topN", "pct", "perCastValue", "dmgGapPct"];

test("every module that uses a shared identifier imports it", () => {
  for (const file of fs.readdirSync(DOCS).filter((f) => f.endsWith(".js"))) {
    const raw = fs.readFileSync(path.join(DOCS, file), "utf8");
    // Strip comments so a name mentioned in prose (e.g. ".pct.") isn't read as a use.
    const src = raw.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
    // The module's import bindings (anything named inside `import { … }` blocks).
    const imported = new Set();
    for (const m of src.matchAll(/import\s*\{([^}]*)\}/g)) {
      for (const part of m[1].split(",")) {
        const name = part.trim().split(/\s+as\s+/)[0].trim();
        if (name) imported.add(name);
      }
    }
    for (const id of GUARDED) {
      // `core.js` DEFINES these; a name used only as its own definition is fine.
      if (file === "core.js") continue;
      const used = new RegExp(`\\b${id}\\s*[.(]`).test(src);
      // A module may legitimately define its OWN (e.g. progression.js has a local pct).
      const localDef = new RegExp(`\\b(const|let|var|function)\\s+${id}\\b`).test(src);
      if (used && !localDef) assert.ok(imported.has(id), `${file} uses ${id} but does not import it`);
    }
  }
});

// --- export hygiene: the two bug CLASSES a holistic codebase shouldn't let recur ---
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");

// Every .js/.mjs source we care about (app + CLI + worker + tests), comment-stripped.
// Excludes build output and deps so a bundle doesn't make dead code look referenced.
function allSources() {
  const skip = new Set(["node_modules", "dist", ".git", "__pycache__"]);
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (skip.has(e.name)) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(js|mjs)$/.test(e.name)) out.push([p, stripComments(fs.readFileSync(p, "utf8"))]);
    }
  };
  walk(ROOT);
  return out;
}

// (file -> [exported names]) for every docs module.
function docsExports() {
  const map = new Map();
  for (const file of fs.readdirSync(DOCS).filter((f) => f.endsWith(".js"))) {
    const src = stripComments(fs.readFileSync(path.join(DOCS, file), "utf8"));
    const names = [];
    for (const m of src.matchAll(/\bexport\s+(?:async\s+)?(?:function|const|let|class)\s+([A-Za-z0-9_$]+)/g)) names.push(m[1]);
    for (const m of src.matchAll(/\bexport\s*\{([^}]*)\}/g))
      for (const p of m[1].split(",")) { const n = p.trim().split(/\s+as\s+/).pop().trim(); if (n) names.push(n); }
    map.set(file, names);
  }
  return map;
}

// No two docs modules may export the SAME name -- a same-name/different-shape pair is
// how `encountersIn` shipped with one copy in core.js and another in progression.js,
// and the app imported the wrong one (chips rendered "undefined pulls"). `run` is the
// ONE documented exception: every analysis module exports its own card entrypoint.
test("no accidental duplicate exports across docs modules", () => {
  const ALLOWED_DUPES = new Set(["run"]);
  const byName = new Map();
  for (const [file, names] of docsExports())
    for (const n of names) { if (!byName.has(n)) byName.set(n, []); byName.get(n).push(file); }
  for (const [name, files] of byName)
    if (files.length > 1 && !ALLOWED_DUPES.has(name))
      assert.fail(`"${name}" is exported by ${files.join(" AND ")} -- rename or dedupe (only "run" may repeat)`);
});

// Every docs export must be referenced SOMEWHERE in the repo (app, CLI, worker, or a
// test) beyond its own definition. An export referenced literally nowhere is dead
// weight that reads as load-bearing -- the rxHeadline/pickCurrentKill/nightlyTrend
// class. Test references count (a test-only seam like clearGqlCache is real infra);
// "referenced nowhere at all" is the unambiguous failure this guards.
test("no docs export is referenced nowhere in the repo", () => {
  const sources = allSources();
  for (const [file, names] of docsExports()) {
    for (const name of names) {
      const re = new RegExp(`\\b${name.replace(/[$]/g, "\\$")}\\b`, "g");
      let total = 0;
      for (const [, src] of sources) total += (src.match(re) || []).length;
      // 1 == only the definition itself; anything live is referenced at least once more.
      assert.ok(total > 1, `docs/${file} exports "${name}" but nothing references it -- delete it or wire it in`);
    }
  }
});

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

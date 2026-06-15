// @ts-check
// Shared Node CLI setup for cli.mjs and progression-cli.mjs: point wcl.js at the
// shared on-disk GraphQL cache and install a file-backed localStorage shim (gear.js
// caches Wowhead item/instance lookups in localStorage). Both live in the home dir,
// not the repo root, so every git worktree reuses the same cache instead of each
// re-spending WCL points / re-fetching the same tooltips. Call ONCE, before importing
// anything that pulls in wcl.js (the env var must be set first).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const CACHE_DIR = path.join(os.homedir(), ".cache", "warcraftlogs-analysis");

export function setupNodeCaches() {
  process.env.WCL_GQL_CACHE = "1";
  process.env.WCL_GQL_CACHE_FILE = process.env.WCL_GQL_CACHE_FILE || path.join(CACHE_DIR, "gql-cache.json");

  const CACHE_FILE = path.join(CACHE_DIR, "item-cache.json");
  try { fs.mkdirSync(CACHE_DIR, { recursive: true }); } catch { /* ignore */ }
  let store = {};
  try { store = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8")); } catch { /* none yet */ }
  let saveTimer = null;
  const save = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      // Merge with concurrent worktrees' writes, then atomic rename (temp+rename).
      try {
        let merged;
        try {
          merged = { ...JSON.parse(fs.readFileSync(CACHE_FILE, "utf8")), ...store };
        } catch (e) {
          // NEVER-CLOBBER: if the file EXISTS but can't be read, writing only OUR
          // store would wipe concurrent worktrees' entries. Skip this write and keep
          // our store for the next flush; only write ours when there's genuinely no file.
          if (fs.existsSync(CACHE_FILE)) return;
          merged = { ...store };
        }
        store = merged;
        const tmp = `${CACHE_FILE}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(merged));
        fs.renameSync(tmp, CACHE_FILE);
      } catch { /* ignore */ }
    }, 200);
  };
  globalThis.localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); save(); },
    removeItem: (k) => { delete store[k]; save(); },
    clear: () => { store = {}; save(); },
    key: (i) => Object.keys(store)[i] ?? null,
    get length() { return Object.keys(store).length; },
  };
}

#!/usr/bin/env node
// @ts-check
/**
 * One-time maintenance: finish the 2-hex -> 3-hex cache reshard and reclaim disk.
 *
 * The finer-shard change (wcl.js) migrates 2-hex shards into 3-hex LAZILY -- only the
 * entries a run actually touches. So un-touched entries still live only in the old
 * 2-hex shards, which we deliberately never delete (other worktrees on old code read
 * them). Once EVERY worktree is on the new code (check: `git worktree list` + confirm
 * each HEAD contains the finer-shard commit) and no old-code process is running, run
 * this to: (1) copy every remaining 2-hex entry into its 3-hex shard, (2) VERIFY each
 * is present, (3) only then delete the 2-hex shards. Lossless -- nothing is removed
 * until its data is confirmed in 3-hex, so no entry is ever orphaned (no refetch).
 *
 *   node reshard-cleanup.mjs            # do it
 *   node reshard-cleanup.mjs --dry-run  # report only, delete nothing
 */
import fs from "node:fs";
import zlib from "node:zlib";
import path from "node:path";
import os from "node:os";

const dir = process.env.WCL_GQL_CACHE_FILE
  ? `${process.env.WCL_GQL_CACHE_FILE}.shards`
  : path.join(os.homedir(), ".cache", "warcraftlogs-analysis", "gql-cache.json.shards");
const dry = process.argv.includes("--dry-run");

const fnv = (q) => { let h = 0x811c9dc5; for (let i = 0; i < q.length; i++) { h ^= q.charCodeAt(i); h = Math.imul(h, 0x01000193); } return h >>> 0; };
const shard3 = (q) => (fnv(q) & 0xfff).toString(16).padStart(3, "0");
const decode = (buf) => { const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf); const raw = (b.length >= 2 && b[0] === 0x1f && b[1] === 0x8b) ? zlib.gunzipSync(b) : b; return JSON.parse(raw.toString("utf8")); };
const readShard = (file) => { try { return decode(fs.readFileSync(file)); } catch { return null; } };
const writeShard = (file, obj) => { const tmp = `${file}.${process.pid}.tmp`; fs.writeFileSync(tmp, zlib.gzipSync(Buffer.from(JSON.stringify(obj)))); fs.renameSync(tmp, file); };

const files = fs.readdirSync(dir);
const twoHex = files.filter((f) => /^[0-9a-f]{2}\.json(\.gz)?$/.test(f));
if (!twoHex.length) { console.log("[cleanup] no 2-hex shards left -- nothing to do."); process.exit(0); }

// 1. Bucket every 2-hex entry by its 3-hex destination (newest timestamp wins).
const byDest = new Map();   // id3 -> { query: entry }
let entries = 0;
for (const f of twoHex) {
  const obj = readShard(path.join(dir, f));
  if (!obj) { console.error(`[cleanup] ABORT: cannot read ${f} -- not deleting anything.`); process.exit(1); }
  for (const [q, e] of Object.entries(obj)) {
    entries++;
    const id = shard3(q);
    let m = byDest.get(id); if (!m) { m = {}; byDest.set(id, m); }
    if (!m[q] || (m[q].t || 0) < (e.t || 0)) m[q] = e;
  }
}
console.log(`[cleanup] ${twoHex.length} 2-hex shards, ${entries} entries -> ${byDest.size} 3-hex shards${dry ? " (dry run)" : ""}`);

// 2. Merge into the existing 3-hex shards (never clobber: keep newest per query).
for (const [id, add] of byDest) {
  const file = path.join(dir, `${id}.json.gz`);
  const cur = readShard(file) || {};
  let changed = false;
  for (const [q, e] of Object.entries(add)) if (!cur[q] || (cur[q].t || 0) < (e.t || 0)) { cur[q] = e; changed = true; }
  if (changed && !dry) writeShard(file, cur);
}

// 3. VERIFY every 2-hex query is now present in its 3-hex shard before deleting.
let missing = 0;
for (const [id, add] of byDest) {
  const cur = (dry ? null : readShard(path.join(dir, `${id}.json.gz`))) || {};
  for (const q of Object.keys(add)) if (!dry && !(q in cur)) missing++;
}
if (!dry && missing) { console.error(`[cleanup] ABORT: ${missing} entries not verified in 3-hex -- 2-hex shards kept.`); process.exit(1); }

// 4. Only now delete the 2-hex shards.
const before = twoHex.reduce((s, f) => s + fs.statSync(path.join(dir, f)).size, 0);
if (dry) { console.log(`[cleanup] dry run: would delete ${twoHex.length} 2-hex shards, reclaiming ~${(before / 1e6).toFixed(0)}MB.`); process.exit(0); }
for (const f of twoHex) { try { fs.unlinkSync(path.join(dir, f)); } catch { /* raced */ } }
console.log(`[cleanup] verified + deleted ${twoHex.length} 2-hex shards, reclaimed ~${(before / 1e6).toFixed(0)}MB.`);

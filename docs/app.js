// UI wiring: pick character/region/server, auto-detect the rest, stream live.
import { detectContext, detectPriority, DIFFICULTY } from "./core.js";
import * as analyze from "./analyze.js";
import * as diagnose from "./diagnose.js";
import * as rotation from "./rotation.js";
import * as gear from "./gear.js";
import * as prescribe from "./prescribe.js";

const $ = (id) => document.getElementById(id);
const out = $("out"), statusEl = $("status"), goBtn = $("go"), form = $("form");
const regionSel = $("region"), serverSel = $("server");

// --- server dropdown, populated from the bundled realm list per region --- //
let REALMS = {};
async function loadRealms() {
  try { REALMS = await (await fetch("./servers.json")).json(); }
  catch (e) { REALMS = {}; }
  fillServers();
}
function fillServers() {
  const list = REALMS[regionSel.value] || [];
  serverSel.innerHTML = list.map((s) => `<option value="${s.slug}">${s.name}</option>`).join("")
    || '<option value="">(realm list unavailable)</option>';
}
regionSel.addEventListener("change", fillServers);
loadRealms();

// --- live output --- //
function classify(line) {
  if (/^\[error]/.test(line)) return "ln-err";
  if (/<-- WORSE/.test(line)) return "ln-worse";
  if (/^#{3,}|^===|^# |^Detected:/.test(line)) return "ln-head";
  if (/^\s+\d+\.\s+\[/.test(line)) return "ln-rx";
  if (/^---|^\s+- |^\s{2,}\S/.test(line)) return "ln-sub";
  return "";
}
function log(line) {
  const span = document.createElement("span");
  const cls = classify(line);
  if (cls) span.className = cls;
  span.textContent = line + "\n";
  out.appendChild(span);
  window.scrollTo(0, document.body.scrollHeight);
}
function setRunning(on) {
  goBtn.disabled = on;
  goBtn.textContent = on ? "Analyzing…" : "Analyze";
  statusEl.innerHTML = on ? '<span class="spin"></span>running…' : "";
}

const SECTIONS = {
  overview: ["OVERVIEW & ITEM-LEVEL-MATCHED COMPARISON",
    (log, p) => analyze.run(log, p.name, p.server, p.region, p.cls, p.spec, p.difficulty)],
  diagnose: ["TIMELINE DIAGNOSIS",
    (log, p) => diagnose.run(log, p.name, p.server, p.region, p.cls, p.spec, p.difficulty)],
  rotation: ["ROTATION: OPENER & PRIORITY",
    (log, p) => rotation.run(log, p.name, p.server, p.region, p.cls, p.spec, p.difficulty)],
  gear: ["GEAR AUDIT",
    (log, p) => gear.audit(log, p.name, p.server, p.region, p.difficulty, p.cls, p.spec, p.priority)],
  prescribe: ["PRESCRIPTION",
    (log, p) => prescribe.run(log, p.name, p.server, p.region, p.cls, p.spec, p.difficulty)],
};

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = $("name").value.trim();
  const region = regionSel.value;
  const server = serverSel.value; // realm slug
  const serverLabel = serverSel.options[serverSel.selectedIndex]?.text || server;
  out.textContent = "";
  if (!name) { log("[error] enter a character name"); return; }
  if (!server) { log("[error] pick a server"); return; }

  setRunning(true);
  log(`=== ${name} — ${serverLabel} (${region}) ===`);
  try {
    log("");
    log("Detecting class, spec, and difficulty…");
    const ctx = await detectContext(name, server, region);
    const priority = await detectPriority(ctx.className, ctx.specName, ctx.difficulty, ctx.killed[0].encounter.id);
    log(`Detected: ${ctx.specName} ${ctx.className} · ${DIFFICULTY[ctx.difficulty]} · gear priority ${priority}`);
    const p = {
      name, server, region, cls: ctx.className, spec: ctx.specName,
      difficulty: ctx.difficulty, priority,
    };
    for (const key of Object.keys(SECTIONS)) {
      const [title, fn] = SECTIONS[key];
      log(""); log("#".repeat(70)); log("# " + title); log("#".repeat(70));
      try { await fn(log, p); }
      catch (err) { log(`[error] ${title}: ${err.message || err}`); }
    }
    statusEl.textContent = "Done.";
  } catch (err) {
    log(`[error] ${err.message || err}`);
  } finally {
    setRunning(false);
  }
});

// UI wiring: gather form inputs, run the selected analyses, stream lines live.
import { WORKER_URL, WORKER_CONFIGURED } from "./config.js";
import * as analyze from "./analyze.js";
import * as diagnose from "./diagnose.js";
import * as gear from "./gear.js";
import * as prescribe from "./prescribe.js";

const $ = (id) => document.getElementById(id);
const out = $("out"), statusEl = $("status"), goBtn = $("go"), form = $("form");

// Pre-fill the Worker URL field from config/localStorage.
$("worker").value = WORKER_CONFIGURED ? WORKER_URL : (localStorage.getItem("workerUrl") || "");

function classify(line) {
  if (/^\[error]/.test(line)) return "ln-err";
  if (/<-- WORSE/.test(line)) return "ln-worse";
  if (/^#{3,}|^===|^# /.test(line)) return "ln-head";
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
  gear: ["GEAR AUDIT",
    (log, p) => gear.audit(log, p.name, p.server, p.region, p.difficulty, p.cls, p.spec, p.priority)],
  prescribe: ["PRESCRIPTION",
    (log, p) => prescribe.run(log, p.name, p.server, p.region, p.cls, p.spec, p.difficulty)],
};

form.addEventListener("submit", async (e) => {
  e.preventDefault();

  const workerUrl = $("worker").value.trim().replace(/\/$/, "");
  if (workerUrl) localStorage.setItem("workerUrl", workerUrl);
  if (!workerUrl && !WORKER_CONFIGURED) {
    out.textContent = "";
    log("[error] Set your Cloudflare Worker URL under Settings first.");
    return;
  }
  // If the field differs from the loaded config, reload so config.js picks it up.
  if (workerUrl && workerUrl !== WORKER_URL) {
    location.search = "?worker=" + encodeURIComponent(workerUrl);
    return;
  }

  const p = {
    name: $("name").value.trim(),
    server: $("server").value.trim(),
    region: $("region").value,
    cls: $("class_name").value.trim() || "Monk",
    spec: $("spec").value.trim() || "Brewmaster",
    difficulty: parseInt($("difficulty").value, 10),
    priority: $("priority").value,
  };
  if (!p.name || !p.server) { log("[error] character name and server are required"); return; }
  const wanted = [...document.querySelectorAll('.checks input:checked')].map((c) => c.value);

  out.textContent = "";
  setRunning(true);
  log(`=== ${p.name}-${p.server} (${p.region}) | ${p.spec} ${p.cls} ===`);
  try {
    for (const key of Object.keys(SECTIONS)) {
      if (!wanted.includes(key)) continue;
      const [title, fn] = SECTIONS[key];
      log("");
      log("#".repeat(70));
      log("# " + title);
      log("#".repeat(70));
      try {
        await fn(log, p);
      } catch (err) {
        log(`[error] ${title}: ${err.message || err}`);
      }
    }
    statusEl.textContent = "Done.";
  } finally {
    setRunning(false);
  }
});

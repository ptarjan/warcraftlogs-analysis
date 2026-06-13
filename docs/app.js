// UI wiring: pick character/region/server, auto-detect the rest, then render
// the result as a web report -- the prioritized list of changes up top, with
// the supporting analyses as collapsible cards below.
import { detectContext, detectPriority, DIFFICULTY } from "./core.js";
import { isAuthed, beginLogin, handleRedirectCallback, logout } from "./auth.js";
import { NeedsAuth, myCharacters } from "./wcl.js";
import * as analyze from "./analyze.js";
import * as diagnose from "./diagnose.js";
import * as rotation from "./rotation.js";
import * as gear from "./gear.js";
import * as prescribe from "./prescribe.js";

const $ = (id) => document.getElementById(id);
const out = $("out"), statusEl = $("status"), goBtn = $("go"), form = $("form");
const regionSel = $("region"), serverSel = $("server"), authEl = $("auth");

// --- server dropdown, populated from the bundled realm list per region --- //
let REALMS = {};
const realmsReady = loadRealms();
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

// --------------------------------------------------------------------------- //
// Auth (optional): anyone can analyze anonymously via the proxy. Connecting with
// OAuth PKCE makes the browser use the user's OWN Warcraft Logs token instead --
// their own rate budget and access to their private logs. No secret either way.
// --------------------------------------------------------------------------- //
function renderAuth() {
  if (isAuthed()) {
    authEl.innerHTML =
      '<span class="conn ok">✓ Connected · using your Warcraft Logs account</span>' +
      '<button type="button" id="disconnect" class="linkbtn">Disconnect</button>';
    $("disconnect").onclick = () => { logout(); renderAuth(); renderMode(); };
  } else {
    authEl.innerHTML =
      '<button type="button" id="connect" class="linkbtn accent">Connect Warcraft Logs</button>' +
      '<span class="conn muted">optional · use your own rate limit &amp; private logs (or just analyze below)</span>';
    $("connect").onclick = () => beginLogin().catch(showAuthErr);
  }
}
function showAuthErr(e) { cur = makeCard("Connection error"); note(e.message || String(e), "err"); }

// Display name for a realm slug (characters from WCL carry only the slug).
function realmLabel(region, slug) {
  const r = (REALMS[region] || []).find((s) => s.slug === slug);
  return r ? r.name : slug;
}

// Two modes. Anonymous: the manual form (type character + region + server).
// Connected: hide the form and show a clickable list of YOUR characters that
// have parses on current content, most parses first -- click one to analyze.
// Best-effort: if the list can't be built, fall back to the manual form.
function showForm(on) {
  form.style.display = on ? "" : "none";
  const intro = $("intro"); if (intro) intro.style.display = on ? "" : "none";
  const picker = $("picker"); if (picker) picker.style.display = on ? "none" : "";
}
async function renderMode() {
  if (!isAuthed()) { showForm(true); const p = $("picker"); if (p) p.innerHTML = ""; return; }
  let chars = [];
  try { chars = await myCharacters(); } catch { chars = []; }
  await realmsReady;
  const picker = $("picker");
  if (!chars.length || !picker) { showForm(true); return; } // nothing to click -> manual form
  showForm(false);
  picker.innerHTML = "";
  const h = document.createElement("div");
  h.className = "picker-h";
  h.textContent = "Your characters — click one to analyze";
  picker.appendChild(h);
  const grid = document.createElement("div");
  grid.className = "picker-grid";
  for (const c of chars) {
    const label = realmLabel(c.region, c.server);
    const b = document.createElement("button");
    b.type = "button"; b.className = "charbtn";
    const cn = document.createElement("span"); cn.className = "cn"; cn.textContent = c.name;
    const cs = document.createElement("span"); cs.className = "cs";
    cs.textContent = `${label} · ${c.region}` + (c.parses ? ` · ${c.parses} parse${c.parses === 1 ? "" : "s"}` : "");
    b.append(cn, cs);
    b.onclick = () => runAnalysis({ name: c.name, server: c.server, region: c.region, serverLabel: label });
    grid.appendChild(b);
  }
  picker.appendChild(grid);
}

// On load: finish any returning OAuth redirect, reflect auth state, then show
// the right mode (form for anonymous, character picker for connected).
(async () => {
  try { await handleRedirectCallback(); }
  catch (e) { showAuthErr(e); }
  renderAuth();
  renderMode();
})();

// --------------------------------------------------------------------------- //
// Rendering: cards instead of a terminal. Modules still emit text via log();
// here we turn that stream into headings, prose, data blocks, and action cards.
// --------------------------------------------------------------------------- //
const scroll = () => window.scrollTo(0, document.body.scrollHeight);
let cur = null; // { body } -- where log() lines currently go

function makeCard(title, { primary = false, collapsed = false } = {}) {
  let el, body;
  if (collapsed) {
    el = document.createElement("details");
    el.className = "card";
    const s = document.createElement("summary");
    s.textContent = title;
    el.appendChild(s);
    body = document.createElement("div");
    body.className = "body";
    el.appendChild(body);
  } else {
    el = document.createElement("section");
    el.className = "card" + (primary ? " primary" : "");
    const h = document.createElement("h2");
    h.textContent = title;
    el.appendChild(h);
    body = document.createElement("div");
    body.className = "body";
    el.appendChild(body);
  }
  out.appendChild(el);
  const handle = { el, body, mono: null };
  return handle;
}

function append(el) { cur.body.appendChild(el); cur.mono = null; scroll(); }
function appendMono(line) {
  if (!cur.mono) { cur.mono = document.createElement("pre"); cur.mono.className = "mono"; cur.body.appendChild(cur.mono); }
  const span = document.createElement("span");
  if (/<-- WORSE/.test(line)) span.className = "worse";
  span.textContent = line + "\n";
  cur.mono.appendChild(span);
  scroll();
}
function note(text, cls = "") { const d = document.createElement("div"); d.className = "note " + cls; d.textContent = text; append(d); }

function log(line) {
  if (!cur) cur = makeCard("Results");
  let m;
  if (/^[=#-]{3,}$/.test(line.trim())) return;                 // separator bars
  if ((m = line.match(/^={3,}\s*(.+?)\s*={3,}$/))) { const d = document.createElement("div"); d.className = "sub-h"; d.textContent = m[1]; return append(d); }
  if ((m = line.match(/^---\s*(.+?)\s*---$/))) { const d = document.createElement("div"); d.className = "sub-h2"; d.textContent = m[1]; return append(d); }
  if ((m = line.match(/^\s*(\d+)\.\s*\[\s*(.+?)\s*\]\s*(.+)$/))) {
    const info = /info/i.test(m[2]);
    const d = document.createElement("div"); d.className = "rx" + (info ? " info" : "");
    const n = document.createElement("div"); n.className = "num"; n.textContent = m[1];
    const b = document.createElement("div"); b.className = "badge"; b.textContent = m[2];
    const t = document.createElement("div"); t.className = "txt"; t.textContent = m[3];
    d.append(n, b, t); return append(d);
  }
  if (/^\[error]/.test(line)) return note(line.replace(/^\[error]\s*/, ""), "err");
  if (line.trim() === "") { cur.mono = null; return; }          // blank ends a data block
  // aligned (has a run of 2+ spaces between non-space chars) -> data; else prose
  if (/\S\s{2,}\S/.test(line)) return appendMono(line);
  note(line);
}

function setRunning(on) {
  goBtn.disabled = on;
  goBtn.textContent = on ? "Analyzing…" : "Analyze";
  statusEl.innerHTML = on ? '<span class="spin"></span>analyzing…' : "";
}

// Surface WCL rate-limit waits so the page never just looks frozen -- with a
// reset ETA when WCL provides one (Retry-After).
let activeHero = null;
window.addEventListener("wcl-ratelimit", (e) => {
  const s = e && e.detail && e.detail.retryAfter;
  const when = (typeof s === "number" && s > 0)
    ? ` — retry in ~${s >= 60 ? Math.ceil(s / 60) + " min" : Math.ceil(s) + "s"}`
    : " — waiting a moment";
  if (activeHero && activeHero.det && activeHero.det.isConnected) {
    activeHero.det.textContent = `WCL rate limit reached${when}…`;
  }
  statusEl.innerHTML = `<span class="spin"></span>rate limited${when}…`;
});

// Supporting analyses (collapsed by default -- evidence behind the list).
const SUPPORTING = [
  ["Overview & item-level comparison", (p) => analyze.run(log, p.name, p.server, p.region, p.cls, p.spec, p.difficulty)],
  ["Timeline diagnosis", (p) => diagnose.run(log, p.name, p.server, p.region, p.cls, p.spec, p.difficulty)],
  ["Rotation: opener & priority", (p) => rotation.run(log, p.name, p.server, p.region, p.cls, p.spec, p.difficulty)],
  ["Gear audit", (p) => gear.audit(log, p.name, p.server, p.region, p.difficulty, p.cls, p.spec, p.priority)],
];

function buildHero(name, server, region) {
  const h = document.createElement("section"); h.className = "hero";
  const who = document.createElement("div"); who.className = "who";
  who.textContent = name + " ";
  const small = document.createElement("small"); small.textContent = `${server} · ${region}`;
  who.appendChild(small);
  const det = document.createElement("div"); det.className = "detecting";
  det.textContent = "Detecting class, spec, and difficulty…";
  const pills = document.createElement("div"); pills.className = "pills";
  h.append(who, det, pills); out.appendChild(h);
  return { det, pills };
}
function setPills(hero, items) {
  hero.det.remove();
  for (const [text, muted] of items) {
    const s = document.createElement("span"); s.className = "pill" + (muted ? " muted" : "");
    s.textContent = text; hero.pills.appendChild(s);
  }
}

// Run the full analysis for one character. Called by the manual form (anonymous)
// and by clicking a character in the connected picker.
async function runAnalysis({ name, server, region, serverLabel }) {
  out.innerHTML = ""; cur = null;
  setRunning(true);
  const intro = document.getElementById("intro");
  if (intro) intro.style.display = "none";
  const hero = buildHero(name, serverLabel || server, region);
  activeHero = hero;
  // Pin the action list at the top (filled last, once analyses warm the cache).
  const rxCard = makeCard("What to change", { primary: true });
  cur = rxCard; note("Crunching your kills and the field…", "muted");

  try {
    const ctx = await detectContext(name, server, region);
    const priority = await detectPriority(ctx.className, ctx.specName, ctx.difficulty, ctx.killed[0].encounter.id);
    setPills(hero, [
      [`${ctx.specName} ${ctx.className}`, false],
      [DIFFICULTY[ctx.difficulty], true],
      [`${priority} priority`, true],
    ]);
    const p = { name, server, region, cls: ctx.className, spec: ctx.specName, difficulty: ctx.difficulty, priority };

    for (const [title, runFn] of SUPPORTING) {
      cur = makeCard(title, { collapsed: true });
      try { await runFn(p); }
      catch (err) { if (err instanceof NeedsAuth) throw err; note(`${err.message || err}`, "err"); }
    }

    rxCard.body.innerHTML = ""; cur = rxCard; // clear placeholder, fill the list
    try { await prescribe.run(log, p.name, p.server, p.region, p.cls, p.spec, p.difficulty); }
    catch (err) { if (err instanceof NeedsAuth) throw err; note(`${err.message || err}`, "err"); }

    statusEl.textContent = "Done.";
  } catch (err) {
    rxCard.body.innerHTML = ""; cur = rxCard;
    if (err instanceof NeedsAuth) {
      logout(); renderAuth(); renderMode();
      note(err.message || "Reconnect to Warcraft Logs to continue.", "err");
    } else {
      note(err.message || String(err), "err");
    }
  } finally {
    setRunning(false);
  }
}

// Manual form (anonymous mode; hidden when connected in favor of the picker).
form.addEventListener("submit", (e) => {
  e.preventDefault();
  const name = $("name").value.trim();
  const region = regionSel.value;
  const server = serverSel.value;
  const serverLabel = serverSel.options[serverSel.selectedIndex]?.text || server;
  if (!name) { out.innerHTML = ""; cur = makeCard("Error"); note("Enter a character name.", "err"); return; }
  if (!server) { out.innerHTML = ""; cur = makeCard("Error"); note("Pick a server.", "err"); return; }
  runAnalysis({ name, server, region, serverLabel });
});

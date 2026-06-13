// UI wiring: pick character/region/server, auto-detect the rest, then render
// the result as a web report -- the prioritized list of changes up top, with
// the supporting analyses as collapsible cards below.
import { detectContext, detectPriority, DIFFICULTY } from "./core.js";
import { isAuthed, beginLogin, handleRedirectCallback, logout } from "./auth.js";
import { NeedsAuth, myCharacters, primeRateReset } from "./wcl.js";
import { paramsFromSearch, shareSearch } from "./share.js";
import * as overview from "./overview.js";
import * as timeline from "./timeline.js";
import * as rotation from "./rotation.js";
import * as topparse from "./topparse.js";
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
// Connected: hide just the input form and show a clickable list of YOUR
// most-recently-active characters -- click to analyze. Everything else on the
// page (intro, sample) stays put.
// Best-effort: if the list can't be built, fall back to the manual form.
function showForm(on) {
  form.style.display = on ? "" : "none";
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
    cs.textContent = `${label} · ${c.region}` + (c.kills ? ` · ${c.kills} kill${c.kills === 1 ? "" : "s"}` : "");
    b.append(cn, cs);
    b.onclick = () => runAnalysis({ name: c.name, server: c.server, region: c.region, serverLabel: label });
    grid.appendChild(b);
  }
  picker.appendChild(grid);
}

// A ?char=&region=&server= deep link prefills the form and, when it has enough
// to run (a shared result link), analyzes immediately -- overriding the picker.
// The analysis itself is cheap on reload because the fetches are cached (wcl.js).
async function deepLink() {
  const q = paramsFromSearch(location.search);
  if (!q.name) return false;
  await realmsReady;
  $("name").value = q.name;
  if (q.region) { regionSel.value = q.region; fillServers(); }
  if (q.server) serverSel.value = q.server;
  showForm(true); // hide the picker; show the form context behind the result
  if (q.name && q.server && q.region) {
    const serverLabel = serverSel.options[serverSel.selectedIndex]?.text || q.server;
    runAnalysis({ name: q.name, server: q.server, region: q.region, serverLabel });
  }
  return true;
}

// On load: finish any returning OAuth redirect, reflect auth state, then show
// the right mode (form for anonymous, character picker for connected) -- unless
// a deep link tells us exactly which character to analyze.
(async () => {
  try { await handleRedirectCallback(); }
  catch (e) { showAuthErr(e); }
  renderAuth();
  if (!(await deepLink())) renderMode();
})();

// --------------------------------------------------------------------------- //
// Rendering: cards instead of a terminal. Modules still emit text via log();
// here we turn that stream into headings, prose, data blocks, and action cards.
// --------------------------------------------------------------------------- //
const scroll = () => window.scrollTo(0, document.body.scrollHeight);
let cur = null; // fallback card for the global log()/note() (errors, validation)

// Every card has the SAME shape -- a header (title + a status indicator) and a
// body -- whether it's the primary list or a collapsible supporting analysis.
// Keeping one structure is what makes the cards look uniform.
function makeCard(title, { primary = false, collapsed = false } = {}) {
  const el = document.createElement(collapsed ? "details" : "section");
  el.className = "card" + (primary ? " primary" : "") + (collapsed ? "" : " open");
  const head = document.createElement(collapsed ? "summary" : "div");
  head.className = "card-head";
  const ttl = document.createElement("span");
  ttl.className = "card-title";
  ttl.textContent = title;
  head.appendChild(ttl);
  el.appendChild(head);
  const body = document.createElement("div");
  body.className = "body";
  el.appendChild(body);
  out.appendChild(el);
  return { el, head, body, status: null, readout: null };
}

// Per-card processing indicator. Each section shows its own state so that when
// they all run at once the page reads as several parallel flows.
function setCardState(h, state) {
  h.state = state;
  // "done" removes the indicator entirely -- the thinking spinner just vanishes.
  if (state === "done") { if (h.status) { h.status.remove(); h.status = null; } return; }
  if (!h.status) {
    h.status = document.createElement("span");
    h.status.className = "card-status";
    h.head.appendChild(h.status);
  }
  h.status.classList.toggle("err", state === "error");
  if (state === "error") h.status.textContent = "failed";  // keep failures legible
  else h.status.innerHTML = '<span class="spin"></span>';  // running: a thinking spinner
}

// Rendering primitives, parameterized by the card handle `h` so sections running
// concurrently never write into one another's card.
function appendBlock(h, el) { h.body.appendChild(el); h.readout = null; scroll(); }
// The card's single monospace readout (created lazily). Nulled whenever a block
// element (rx item / error) is appended, so the next data line starts a fresh
// readout AFTER it -- preserving stream order.
function readoutOf(h) {
  if (!h.readout) { h.readout = document.createElement("div"); h.readout.className = "readout"; h.body.appendChild(h.readout); }
  return h.readout;
}

// Tell Wowhead's tooltip widget (power.js) to (re)scan links as the report
// streams. Debounced because lines arrive one at a time.
let _whTimer = null;
function refreshWowhead() {
  clearTimeout(_whTimer);
  _whTimer = setTimeout(() => { try { window.$WowheadPower?.refreshLinks?.(); } catch (e) {} }, 250);
}
// Fill `el` with `text`, turning [label](https://…) markdown into safe anchors
// (DOM nodes, never innerHTML).
function fillText(el, text) {
  const re = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g;
  let last = 0, m, linked = false;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) el.appendChild(document.createTextNode(text.slice(last, m.index)));
    const a = document.createElement("a");
    a.href = m[2]; a.target = "_blank"; a.rel = "noopener"; a.textContent = m[1];
    el.appendChild(a);
    last = re.lastIndex; linked = true;
  }
  if (last < text.length) el.appendChild(document.createTextNode(text.slice(last)));
  if (linked) refreshWowhead();
}

// One streamed text line -> a styled readout node. The analyses share a small
// vocabulary, mapped here to one visual language: section/subsection headers,
// "-> takeaway" callouts, a trailing "<-- annotation" lifted into a colored flag
// (red worse / green do-more), and otherwise an aligned data row.
function readoutLine(raw) {
  const trimmed = raw.trim();
  let m;
  if ((m = trimmed.match(/^={3,}\s*(.+?)\s*={3,}$/))) { const d = document.createElement("div"); d.className = "r-head"; d.textContent = m[1]; return d; }
  if ((m = trimmed.match(/^---\s*(.+?)\s*---$/)))     { const d = document.createElement("div"); d.className = "r-sub";  d.textContent = m[1]; return d; }
  const d = document.createElement("div");
  d.className = /^-?->/.test(trimmed) ? "r-call" : "r-line";
  let body = raw, flag = null;
  const fi = raw.indexOf("<--");
  if (fi >= 0) { flag = raw.slice(fi + 3).trim(); body = raw.slice(0, fi).replace(/\s+$/, ""); }
  fillText(d, body);
  if (flag) {
    const s = document.createElement("span");
    s.className = "r-flag " + (/(more|good|^ok\b|✓)/i.test(flag) ? "good" : "bad");
    s.textContent = "  ← " + flag;
    d.appendChild(s);
  }
  return d;
}

// Turn one streamed text line into the right DOM node inside card `h`.
function logTo(h, line) {
  if (/^[=#-]{3,}$/.test(line.trim())) return;                  // bare separator bars
  const m = line.match(/^\s*(\d+)\.\s*\[\s*(.+?)\s*\]\s*(.+)$/); // prescription item -> its own card
  if (m) {
    const info = /info/i.test(m[2]);
    const d = document.createElement("div"); d.className = "rx" + (info ? " info" : "");
    const n = document.createElement("div"); n.className = "num"; n.textContent = m[1];
    const b = document.createElement("div"); b.className = "badge"; b.textContent = m[2].replace(/\s+/g, " ");
    const t = document.createElement("div"); t.className = "txt"; fillText(t, m[3]);
    d.append(n, b, t); return appendBlock(h, d);
  }
  if (/^\[error]/.test(line)) {
    const d = document.createElement("div"); d.className = "note err";
    fillText(d, line.replace(/^\[error]\s*/, "")); return appendBlock(h, d);
  }
  if (line.trim() === "") {                                     // blank -> a gap in the readout
    if (h.readout) { const g = document.createElement("div"); g.className = "r-gap"; h.readout.appendChild(g); }
    return;
  }
  readoutOf(h).appendChild(readoutLine(line));
  scroll();
}

// A logger bound to one card -- this is what each section streams into.
const makeLog = (h) => (line) => logTo(h, line);

// Globals for the non-section paths (auth/validation errors, the placeholder
// line): they target the current fallback card `cur`.
function note(text, cls = "") {
  if (!cur) cur = makeCard("Results");
  const d = document.createElement("div"); d.className = "note " + cls;
  fillText(d, text); return appendBlock(cur, d);
}
function log(line) { if (!cur) cur = makeCard("Results"); return logTo(cur, line); }

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
  // Keep the inline (next-to-button) status short so it doesn't wrap onto its own
  // line; the ETA detail lives in the hero line, which has room.
  statusEl.innerHTML = '<span class="spin"></span>rate limited…';
});

// Supporting analyses (collapsed by default -- evidence behind the list).
const SUPPORTING = [
  ["Overview & item-level comparison", (p, log) => overview.run(log, p.name, p.server, p.region, p.cls, p.spec, p.difficulty)],
  ["Timeline diagnosis", (p, log) => timeline.run(log, p.name, p.server, p.region, p.cls, p.spec, p.difficulty)],
  ["Rotation: opener & priority", (p, log) => rotation.run(log, p.name, p.server, p.region, p.cls, p.spec, p.difficulty)],
  ["Chasing 99: you vs the top parses", (p, log) => topparse.run(log, p.name, p.server, p.region, p.cls, p.spec, p.difficulty)],
  ["Gear audit", (p, log) => gear.audit(log, p.name, p.server, p.region, p.difficulty, p.cls, p.spec, p.priority)],
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

// A back link at the top of the report returns to the character list (connected)
// or the search form (anonymous) -- whichever renderMode() shows.
function addBackBar() {
  const bar = document.createElement("div");
  bar.className = "backbar";
  const b = document.createElement("button");
  b.type = "button";
  b.className = "linkbtn back";
  b.textContent = isAuthed() ? "← Your characters" : "← New search";
  b.onclick = goBack;
  bar.appendChild(b);
  out.appendChild(bar); // first child of the freshly-cleared #out -> sits on top
}
function goBack() {
  setRunning(false);
  activeHero = null;
  out.innerHTML = ""; cur = null;
  // Drop the deep-link params so a reload doesn't immediately re-run the analysis.
  try { history.replaceState(null, "", location.pathname); } catch (e) { /* ignore */ }
  const intro = document.getElementById("intro");
  if (intro) intro.style.display = "";
  renderMode();              // re-shows the picker (connected) or the form (anonymous)
  window.scrollTo(0, 0);
}

// Run the full analysis for one character. Called by the manual form (anonymous)
// and by clicking a character in the connected picker.
async function runAnalysis({ name, server, region, serverLabel }) {
  // Keep the address bar in sync so the result is bookmarkable / shareable.
  try { history.replaceState(null, "", location.pathname + shareSearch({ name, region, server })); } catch (e) { /* ignore */ }
  primeRateReset(); // connected: learn the reset clock now, while still under budget
  out.innerHTML = ""; cur = null;
  setRunning(true);
  // Hide the search form / character list and the intro so the report has the
  // page to itself; the back link (added next) brings the list back.
  form.style.display = "none";
  const picker = $("picker"); if (picker) picker.style.display = "none";
  const intro = document.getElementById("intro");
  if (intro) intro.style.display = "none";
  addBackBar();
  const hero = buildHero(name, serverLabel || server, region);
  activeHero = hero;
  // Build the whole report up front so every card appears at once, each already
  // showing a thinking spinner. The primary list sits on top (filled last, off
  // the warm cache); the supporting analyses are created right after it.
  const rxCard = makeCard("What to change", { primary: true });
  setCardState(rxCard, "busy");
  cur = rxCard; note("Crunching your kills and your peers…", "muted");
  const supCards = SUPPORTING.map(([title]) => {
    const card = makeCard(title, { collapsed: true });
    setCardState(card, "busy");
    return card;
  });

  try {
    const ctx = await detectContext(name, server, region);
    const priority = await detectPriority(ctx.className, ctx.specName, ctx.difficulty, ctx.killed[0].encounter.id);
    setPills(hero, [
      [`${ctx.specName} ${ctx.className}`, false],
      [DIFFICULTY[ctx.difficulty], true],
      [`${priority.charAt(0).toUpperCase() + priority.slice(1)} priority`, true],
    ]);
    const p = { name, server, region, cls: ctx.className, spec: ctx.specName, difficulty: ctx.difficulty, priority };

    // The supporting analyses all start at the SAME time, each streaming into
    // its own card; the card's spinner disappears the moment it finishes. (gql()
    // coalesces/caches identical queries, so concurrent sections share
    // overlapping requests rather than multiplying the API load.)
    const settled = await Promise.allSettled(SUPPORTING.map(([, runFn], i) => {
      const card = supCards[i];
      return Promise.resolve(runFn(p, makeLog(card))).then(
        () => setCardState(card, "done"),
        (err) => {
          setCardState(card, "error");
          if (err instanceof NeedsAuth) throw err; // bubble up to the reconnect flow
          const d = document.createElement("div"); d.className = "note err";
          fillText(d, `${err.message || err}`); appendBlock(card, d);
        },
      );
    }));
    const reconnect = settled.find((s) => s.status === "rejected" && s.reason instanceof NeedsAuth);
    if (reconnect) throw reconnect.reason;

    // The prioritized list depends on the analyses above (cache now warm), so it
    // fills last -- the payoff once the supporting flows complete.
    rxCard.body.innerHTML = ""; cur = rxCard; // clear placeholder, fill the list
    try {
      await prescribe.run(makeLog(rxCard), p.name, p.server, p.region, p.cls, p.spec, p.difficulty, p.priority);
      setCardState(rxCard, "done");
    } catch (err) {
      setCardState(rxCard, "error");
      if (err instanceof NeedsAuth) throw err;
      note(`${err.message || err}`, "err");
    }

    statusEl.textContent = "Done.";

  } catch (err) {
    // Sections that never got to run (e.g. detection failed) shouldn't keep
    // spinning -- remove the ones still pending.
    supCards.forEach((c) => { if (c.state === "busy") c.el.remove(); });
    setCardState(rxCard, "error");
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
  const fail = (msg) => { out.innerHTML = ""; cur = makeCard("Error"); note(msg, "err"); };
  if (!name) return fail("Enter a character name.");
  if (!server) return fail("Pick a server.");
  runAnalysis({ name, server, region, serverLabel });
});

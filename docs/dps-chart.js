// @ts-check
// The "DPS/HPS over the fight" SVG chart: the per-progress curve (you vs the field's
// 25-75% band, phase dividers, biggest-dip highlight), built from the data graph.js streams
// via CHART_PREFIX. A pure DOM builder (data in -> a <div> node out) -- no app state, so it
// lives apart from app.js's UI wiring.

function fmtK(v) {
  return v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `${Math.round(v / 1e3)}k` : `${Math.round(v)}`;
}
export function renderDpsChart(d) {
  const NS = "http://www.w3.org/2000/svg";
  const W = 720, H = 240, padL = 52, padR = 14, padT = 14, padB = 26;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const n = (d.you || []).length;
  const maxY = Math.max(1, ...(d.phi || []), ...(d.you || [])) * 1.08;
  const x = (i) => padL + (n <= 1 ? 0 : (i / (n - 1)) * plotW);
  const y = (v) => padT + plotH - (v / maxY) * plotH;
  const el = (name, attrs, text) => {
    const e = document.createElementNS(NS, name);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    if (text != null) e.textContent = text;
    return e;
  };
  const wrap = document.createElement("div");
  wrap.className = "dpschart";
  const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, class: "dpschart-svg", role: "img",
    "aria-label": `${d.unit} over the fight: you versus the field` });
  // horizontal gridlines + y labels
  for (let i = 0; i <= 3; i++) {
    const v = (maxY * i) / 3, yy = y(v);
    svg.appendChild(el("line", { x1: padL, y1: yy, x2: W - padR, y2: yy, class: "dpschart-grid" }));
    svg.appendChild(el("text", { x: padL - 7, y: yy + 3, class: "dpschart-axis", "text-anchor": "end" }, fmtK(v)));
  }
  // x labels (fight progress)
  for (const fr of [0, 0.5, 1]) {
    const anchor = fr === 0 ? "start" : fr === 1 ? "end" : "middle";
    svg.appendChild(el("text", { x: padL + fr * plotW, y: H - 7, class: "dpschart-axis", "text-anchor": anchor }, `${Math.round(fr * 100)}%`));
  }
  // worst-dip highlight band
  if (d.worst) {
    const xa = x(d.worst.start), xb = x(Math.min(n - 1, d.worst.end));
    svg.appendChild(el("rect", { x: xa, y: padT, width: Math.max(1, xb - xa), height: plotH, class: "dpschart-worst" }));
  }
  // phase dividers + labels (when the curves are aligned by phase)
  const bounds = d.bounds || [];
  if (d.aligned && bounds.length) {
    const starts = [0, ...bounds];
    starts.forEach((bi, idx) => {
      if (bi > 0) svg.appendChild(el("line", { x1: x(bi), y1: padT, x2: x(bi), y2: padT + plotH, class: "dpschart-phase" }));
      const mid = (bi + (idx + 1 < starts.length ? starts[idx + 1] : n - 1)) / 2;
      svg.appendChild(el("text", { x: x(mid), y: padT + 11, class: "dpschart-phase-lbl", "text-anchor": "middle" }, `P${idx + 1}`));
    });
  }
  // peer interquartile band (plo up, phi back)
  if (d.plo && d.phi) {
    const pts = [];
    for (let i = 0; i < n; i++) pts.push(`${x(i)},${y(d.plo[i])}`);
    for (let i = n - 1; i >= 0; i--) pts.push(`${x(i)},${y(d.phi[i])}`);
    svg.appendChild(el("polygon", { points: pts.join(" "), class: "dpschart-band" }));
  }
  const line = (arr, cls) => svg.appendChild(el("polyline", { points: arr.map((v, i) => `${x(i)},${y(v)}`).join(" "), class: cls }));
  if (d.pmed) line(d.pmed, "dpschart-med");
  if (d.you) line(d.you, "dpschart-you");
  wrap.appendChild(svg);
  const legend = document.createElement("div");
  legend.className = "dpschart-legend";
  legend.innerHTML = '<span class="lg you">You</span>'
    + '<span class="lg field">Field median (25–75% band)</span>'
    + (d.worst ? '<span class="lg worst">Biggest dip</span>' : "");
  wrap.appendChild(legend);
  // The caption carries ALL the context (boss · peers · phase note) so the card needs no
  // separate text line under each chart.
  const cap = document.createElement("div");
  cap.className = "dpschart-cap";
  const phaseNote = d.aligned
    ? ` · aligned by phase${d.intermissions ? ` (${d.intermissions} intermission${d.intermissions === 1 ? "" : "s"})` : ""}`
    : "";
  cap.textContent = `${d.boss} · your ${d.unit} vs ${d.peers || 0} peers${phaseNote}`;
  wrap.appendChild(cap);
  return wrap;
}

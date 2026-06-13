#!/usr/bin/env python3
"""Web front-end for the Warcraft Logs analysis tools.

The CLI scripts already print their reports incrementally as they compute, so
instead of rewriting any analysis logic we stream those prints to the browser
live: each request runs the selected analyses in a worker thread, that thread's
stdout is routed (keyed by thread id) into a queue, and the queue is drained as
Server-Sent Events. The page shows the report building in real time.

Run locally:
    pip install -r requirements.txt
    python webapp.py            # http://localhost:5000

Production (free hosting, e.g. Render):
    gunicorn -k gthread -w 1 --threads 8 --timeout 0 webapp:app

Credentials come from WCL_CLIENT_ID / WCL_CLIENT_SECRET (env vars or .env),
exactly like the CLI -- they never reach the browser.
"""
import json
import queue
import sys
import threading
import traceback

from flask import Flask, Response, render_template, request

import analyze
import diagnose
import gear
import prescribe

app = Flask(__name__)

_DONE = object()

DIFFICULTIES = [(5, "Mythic"), (4, "Heroic"), (3, "Normal"), (2, "LFR")]
REGIONS = ["US", "EU", "KR", "TW", "CN"]
PRIORITIES = ["crit", "haste", "mastery", "vers"]

# Display order + labels for the analyses the form can request.
ANALYSES = [
    ("overview", "Overview & item-level-matched comparison"),
    ("diagnose", "Timeline diagnosis (why uptime/APM is low)"),
    ("gear", "Gear audit (real item stats vs the field)"),
    ("prescribe", "Prescription (prioritized to-do list)"),
]


class StreamRouter:
    """A stdout replacement that routes each thread's writes to its own queue.

    A worker thread calls register(q) before running an analysis; everything it
    prints is split into lines and pushed onto q. Unregistered threads (e.g. the
    Flask reloader) fall through to the real stdout, so the console still works.
    """

    def __init__(self, fallback):
        self.fallback = fallback
        self.queues = {}    # thread id -> Queue
        self.buffers = {}   # thread id -> partial-line str

    def register(self, q):
        tid = threading.get_ident()
        self.queues[tid] = q
        self.buffers[tid] = ""

    def unregister(self):
        tid = threading.get_ident()
        self.queues.pop(tid, None)
        return self.buffers.pop(tid, "")

    def write(self, s):
        tid = threading.get_ident()
        q = self.queues.get(tid)
        if q is None:
            return self.fallback.write(s)
        buf = self.buffers.get(tid, "") + s
        *lines, rest = buf.split("\n")
        for line in lines:
            q.put(line)
        self.buffers[tid] = rest
        return len(s)

    def flush(self):
        self.fallback.flush()


router = StreamRouter(sys.stdout)
sys.stdout = router


def _run_selected(params):
    """Run each requested analysis, printing a header before each section."""
    name = params["name"]
    server = params["server"]
    region = params["region"]
    cls = params["class_name"]
    spec = params["spec"]
    diff = params["difficulty"]
    priority = params["priority"]
    wanted = params["analyses"]

    def section(title):
        print(f"\n{'#' * 70}\n# {title}\n{'#' * 70}")

    if "overview" in wanted:
        section("OVERVIEW & ITEM-LEVEL-MATCHED COMPARISON")
        analyze.run(name, server, region, cls, spec, diff)
    if "diagnose" in wanted:
        section("TIMELINE DIAGNOSIS")
        diagnose.run(name, server, region, cls, spec, diff)
    if "gear" in wanted:
        section(f"GEAR AUDIT (priority: {priority})")
        gear.audit(name, server, region, diff, cls, spec, priority)
    if "prescribe" in wanted:
        section("PRESCRIPTION")
        prescribe.run(name, server, region, cls, spec, diff)


def _worker(q, params):
    router.register(q)
    try:
        _run_selected(params)
    except SystemExit as e:  # raised by the CLI helpers on "not found" etc.
        print(f"\n[error] {e}")
    except Exception:  # noqa: BLE001 - surface any failure to the browser
        print("\n[error] analysis failed:")
        traceback.print_exc(file=sys.stdout)
    finally:
        rest = router.unregister()
        if rest:
            q.put(rest)
        q.put(_DONE)


def _parse_params(args):
    try:
        difficulty = int(args.get("difficulty", 5))
    except ValueError:
        difficulty = 5
    wanted = [a for a, _ in ANALYSES if args.get(a) == "1"]
    if not wanted:
        wanted = [a for a, _ in ANALYSES]
    priority = args.get("priority", "crit")
    if priority not in PRIORITIES:
        priority = "crit"
    return {
        "name": args.get("name", "").strip(),
        "server": args.get("server", "").strip(),
        "region": (args.get("region", "US").strip().upper() or "US"),
        "class_name": (args.get("class_name", "Monk").strip() or "Monk"),
        "spec": (args.get("spec", "Brewmaster").strip() or "Brewmaster"),
        "difficulty": difficulty,
        "priority": priority,
        "analyses": wanted,
    }


@app.route("/")
def index():
    return render_template(
        "index.html",
        difficulties=DIFFICULTIES,
        regions=REGIONS,
        priorities=PRIORITIES,
        analyses=ANALYSES,
    )


@app.route("/run")
def run():
    params = _parse_params(request.args)
    if not params["name"] or not params["server"]:
        return Response("character name and server are required", status=400)

    def stream():
        q = queue.Queue()
        threading.Thread(target=_worker, args=(q, params), daemon=True).start()
        # Prelude header so the browser shows context immediately.
        yield _sse(f"=== {params['name']}-{params['server']} ({params['region']}) "
                   f"| {params['spec']} {params['class_name']} ===")
        while True:
            try:
                item = q.get(timeout=15)
            except queue.Empty:
                yield ": keepalive\n\n"  # comment frame keeps proxies from closing
                continue
            if item is _DONE:
                yield "event: done\ndata: end\n\n"
                break
            yield _sse(item)

    return Response(stream(), mimetype="text/event-stream",
                    headers={"Cache-Control": "no-cache",
                             "X-Accel-Buffering": "no"})


def _sse(line):
    return f"data: {json.dumps(line)}\n\n"


if __name__ == "__main__":
    # threaded=True so concurrent SSE streams each get their own thread.
    app.run(host="0.0.0.0", port=5000, threaded=True, debug=False)

"""Warcraft Logs v2 API client.

OAuth client-credentials flow + a thin GraphQL helper with retry, token
caching, and graceful handling of private reports. Credentials are read from
the environment (WCL_CLIENT_ID / WCL_CLIENT_SECRET) or a local .env file --
never hard-coded, so this is safe to commit.
"""
import base64
import json
import os
import time
import urllib.error
import urllib.request

TOKEN_URL = "https://www.warcraftlogs.com/oauth/token"
API_URL = "https://www.warcraftlogs.com/api/v2/client"
TOKEN_CACHE = os.path.join(os.path.dirname(__file__), ".wcl_token.json")


class PrivateReport(Exception):
    """Raised when a report is private / not viewable by this client."""


def _load_dotenv():
    path = os.path.join(os.path.dirname(__file__), ".env")
    if not os.path.exists(path):
        return
    for line in open(path):
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


def _credentials():
    _load_dotenv()
    cid = os.environ.get("WCL_CLIENT_ID")
    secret = os.environ.get("WCL_CLIENT_SECRET")
    if not cid or not secret:
        raise SystemExit(
            "Missing credentials. Set WCL_CLIENT_ID and WCL_CLIENT_SECRET "
            "(env vars or a .env file). See .env.example."
        )
    return cid, secret


def get_token(force=False):
    """Return a bearer token, cached on disk until shortly before expiry."""
    if not force and os.path.exists(TOKEN_CACHE):
        try:
            c = json.load(open(TOKEN_CACHE))
            if c.get("expires_at", 0) > time.time() + 3600:
                return c["access_token"]
        except Exception:
            pass
    cid, secret = _credentials()
    auth = base64.b64encode(f"{cid}:{secret}".encode()).decode()
    req = urllib.request.Request(
        TOKEN_URL,
        data=b"grant_type=client_credentials",
        headers={"Authorization": f"Basic {auth}",
                 "Content-Type": "application/x-www-form-urlencoded"},
    )
    r = json.load(urllib.request.urlopen(req, timeout=60))
    r["expires_at"] = time.time() + r.get("expires_in", 0)
    try:
        json.dump(r, open(TOKEN_CACHE, "w"))
    except Exception:
        pass
    return r["access_token"]


def gql(query, token=None, retries=6):
    """Run a GraphQL query string and return the parsed `data` object.

    Retries transient errors; raises PrivateReport on permission errors so
    callers can skip a report and continue. Honors HTTP 429 rate limits
    (Retry-After header, else exponential backoff) -- important when several
    parallel sessions share one API client's hourly point budget.
    """
    token = token or get_token()
    last = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(
                API_URL,
                data=json.dumps({"query": query}).encode(),
                headers={"Authorization": f"Bearer {token}",
                         "Content-Type": "application/json"},
            )
            r = json.load(urllib.request.urlopen(req, timeout=120))
            if "errors" in r:
                msg = str(r["errors"])
                if "permission" in msg or "do not have" in msg:
                    raise PrivateReport(msg)
                raise RuntimeError(msg)
            return r["data"]
        except PrivateReport:
            raise
        except urllib.error.HTTPError as e:
            last = e
            if e.code == 429:  # rate limited -- wait it out
                retry_after = e.headers.get("Retry-After")
                wait = int(retry_after) if (retry_after and retry_after.isdigit()) \
                    else min(90, 10 * (2 ** attempt))
                time.sleep(wait)
            else:
                time.sleep(2 + attempt)
        except Exception as e:  # noqa: BLE001 - transient network/server errors
            last = e
            time.sleep(2 + attempt)
    raise last


if __name__ == "__main__":
    # Smoke test: verify credentials and print the token's first chars.
    t = get_token()
    print("OK - token acquired:", t[:24] + "...")

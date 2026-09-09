# -*- coding: utf-8 -*-
"""Does this endpoint work from a browser on a static page?

Two things have to hold: it answers, and it sends
Access-Control-Allow-Origin that covers our origin. Anything else is invisible
to the app -- the fetch just fails.
"""
import concurrent.futures as cf
import json
import sys
import urllib.error
import urllib.request

ORIGIN = "https://axionaut.github.io"
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " \
     "(KHTML, like Gecko) Chrome/128.0 Safari/537.36"


def probe(url, timeout=15, want_bytes=False):
    req = urllib.request.Request(url, headers={
        "Origin": ORIGIN, "User-Agent": UA, "Accept": "*/*"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            acao = r.headers.get("Access-Control-Allow-Origin")
            # No cap when the caller needs to parse it. A 400KB cap truncated
            # every large board mid-JSON, so the parse failed and the board was
            # recorded as "not found" -- silently rejecting exactly the biggest
            # employers, which are the ones with the most postings.
            body = r.read() if want_bytes else r.read(4000)
            return {"code": r.status, "cors": acao, "len": len(body),
                    "body": body if want_bytes else body[:400]}
    except urllib.error.HTTPError as e:
        return {"code": e.code, "cors": e.headers.get("Access-Control-Allow-Origin"),
                "len": 0, "body": b""}
    except Exception as e:
        return {"code": 0, "cors": None, "len": 0, "body": b"", "err": str(e)[:80]}


def usable(r):
    return r["code"] == 200 and r["cors"] in ("*", ORIGIN)


if __name__ == "__main__":
    targets = json.load(open(sys.argv[1], encoding="utf-8")) if len(sys.argv) > 1 else []
    with cf.ThreadPoolExecutor(max_workers=12) as pool:
        results = list(pool.map(lambda t: (t[0], t[1], probe(t[1])), targets))
    for name, url, r in results:
        print("%-28s %-4s CORS=%-10s %6s  %s" % (
            name, r["code"], r["cors"] or "NONE", r["len"],
            "USABLE" if usable(r) else "no"))

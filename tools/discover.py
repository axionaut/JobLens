# -*- coding: utf-8 -*-
"""Find which CORS-open ATS board (if any) each candidate company hosts.

Run offline; the output is committed as registry.json data. The app stays a
static page with no backend -- this script never ships.

Verification is deliberately strict: a board counts only if it answers 200, the
response parses, AND it currently has at least one posting. A slug that exists
but is empty adds a request per refresh and nothing else.
"""
import concurrent.futures as cf
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from probe import probe, usable  # noqa: E402
import companies  # noqa: E402

ORIGIN = "https://axionaut.github.io"


def slugs(name):
    """Slug variants a company plausibly registered."""
    base = name.strip()
    plain = re.sub(r"[^a-z0-9]+", "", base.lower())
    dashed = re.sub(r"[^a-z0-9]+", "-", base.lower()).strip("-")
    under = dashed.replace("-", "_")
    # Suffixes in the seed list disambiguate names for me, not for the ATS.
    stripped = re.sub(r"-(remote|india|eu|uk|au|ca|dk|global)$", "", dashed)
    out = []
    for candidate in (dashed, plain, stripped, re.sub(r"[^a-z0-9]+", "", stripped), under):
        if candidate and candidate not in out:
            out.append(candidate)
    return out


# Each entry: how to build the URL, and how to count postings in the response.
def count_greenhouse(j):
    return len(j.get("jobs") or []) if isinstance(j, dict) else 0


def count_ashby(j):
    return len(j.get("jobs") or []) if isinstance(j, dict) else 0


def count_lever(j):
    return len(j) if isinstance(j, list) else 0


def count_smartrecruiters(j):
    return len(j.get("content") or []) if isinstance(j, dict) else 0


def count_workable(j):
    return len(j.get("jobs") or []) if isinstance(j, dict) else 0


def count_recruitee(j):
    return len(j.get("offers") or []) if isinstance(j, dict) else 0


ATS = [
    ("greenhouse", "https://boards-api.greenhouse.io/v1/boards/{s}/jobs", count_greenhouse),
    ("ashby", "https://api.ashbyhq.com/posting-api/job-board/{s}", count_ashby),
    ("lever", "https://api.lever.co/v0/postings/{s}?mode=json", count_lever),
    ("workable", "https://apply.workable.com/api/v1/widget/accounts/{s}?details=true", count_workable),
    ("recruitee", "https://{s}.recruitee.com/api/offers/", count_recruitee),
    ("smartrecruiters", "https://api.smartrecruiters.com/v1/companies/{s}/postings?limit=10",
     count_smartrecruiters),
]


def try_one(ats_name, url_tpl, counter, slug):
    r = probe(url_tpl.format(s=slug), timeout=30, want_bytes=True)
    if not usable(r):
        return None
    try:
        n = counter(json.loads(r["body"]))
    except Exception:
        return None
    return n if n > 0 else None


def find(name):
    """First (ats, slug) that actually serves postings for this name."""
    for slug in slugs(name):
        for ats_name, tpl, counter in ATS:
            n = try_one(ats_name, tpl, counter, slug)
            if n:
                return {"company": name.replace("-", " "), "ats": ats_name, "slug": slug,
                        "region": companies.REGION_OF.get(name, ""), "jobs": n}
    return None


if __name__ == "__main__":
    names = companies.names()
    print("probing %d companies across %d ATS platforms" % (len(names), len(ATS)),
          file=sys.stderr)
    found, missing = [], []
    with cf.ThreadPoolExecutor(max_workers=8) as pool:
        for i, (name, hit) in enumerate(zip(names, pool.map(find, names))):
            if hit:
                found.append(hit)
                print("  %-22s %-16s %-24s %4d jobs" % (
                    name, hit["ats"], hit["slug"], hit["jobs"]), file=sys.stderr)
            else:
                missing.append(name)
            if (i + 1) % 25 == 0:
                print("  ... %d/%d, %d found" % (i + 1, len(names), len(found)),
                      file=sys.stderr)
    out = os.path.join(os.path.dirname(os.path.abspath(__file__)), "discovered.json")
    json.dump(found, open(out, "w", encoding="utf-8"), indent=1, ensure_ascii=False)
    by_ats = {}
    for hit in found:
        by_ats[hit["ats"]] = by_ats.get(hit["ats"], 0) + 1
    print("\nfound %d of %d -> %s" % (len(found), len(names), out), file=sys.stderr)
    print("by ATS: %s" % by_ats, file=sys.stderr)
    print("total postings visible: %d" % sum(h["jobs"] for h in found), file=sys.stderr)
    print("\nnot found (%d): %s" % (len(missing), " ".join(missing)), file=sys.stderr)

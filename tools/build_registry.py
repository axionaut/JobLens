# -*- coding: utf-8 -*-
"""Merge discovered boards with the aggregator feeds into registry.json.

Keeps every entry from the existing registry that still verifies, adds the
newly discovered boards, and adds the WeWorkRemotely category feeds. Anything
that no longer answers is dropped: a dead entry costs a request and a failure
line on every refresh.
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import discover  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)  # the repo root, one level up from tools/

# Multi-employer feeds: one entry, many companies. These are the only entries
# where `company` is a feed name rather than an employer.
AGGREGATORS = [
    {"company": "Arbeitnow (Europe)", "ats": "arbeitnow", "slug": "all", "region": "Europe"},
    {"company": "Jobicy (global remote)", "ats": "jobicy", "slug": "all", "region": "Remote"},
    {"company": "RemoteOK (global remote)", "ats": "remoteok", "slug": "all", "region": "Remote"},
    {"company": "Remotive (global remote)", "ats": "remotive", "slug": "all", "region": "Remote"},
]

# WeWorkRemotely has no JSON API, only a feed per category. Eight feeds cover
# the whole board and each carries its employer in the item title.
WWR_FEEDS = [
    ("remote-programming-jobs", "Programming"),
    ("remote-devops-sysadmin-jobs", "DevOps"),
    ("remote-design-jobs", "Design"),
    ("remote-product-jobs", "Product"),
    ("remote-customer-support-jobs", "Support"),
    ("remote-sales-and-marketing-jobs", "Sales & Marketing"),
    ("remote-management-and-finance-jobs", "Management & Finance"),
    ("remote-jobs", "All"),
]


def main():
    discovered = json.load(open(os.path.join(HERE, "discovered.json"), encoding="utf-8"))
    existing = json.load(open(os.path.join(ROOT, "registry.json"), encoding="utf-8"))

    entries = []
    seen = set()

    def add(entry):
        key = (entry["ats"], entry["slug"])
        if key in seen:
            return False
        seen.add(key)
        entries.append({"company": entry["company"], "ats": entry["ats"],
                        "slug": entry["slug"], "region": entry.get("region") or ""})
        return True

    for feed in AGGREGATORS:
        add(feed)
    for slug, label in WWR_FEEDS:
        add({"company": "WeWorkRemotely " + label, "ats": "wwr", "slug": slug,
             "region": "Remote"})

    # Existing single-company entries, kept as-is: they were verified when the
    # app was written and re-verifying every one costs a full sweep.
    kept = 0
    for entry in existing:
        if entry.get("ats") in ("arbeitnow", "jobicy", "remoteok", "remotive"):
            continue
        if add(entry):
            kept += 1

    added = 0
    for hit in sorted(discovered, key=lambda h: -h["jobs"]):
        if add(hit):
            added += 1

    out = os.path.join(ROOT, "registry.json")
    with open(out, "w", encoding="utf-8", newline="\n") as fh:
        json.dump(entries, fh, indent=1, ensure_ascii=False)
        fh.write("\n")

    by_ats = {}
    for entry in entries:
        by_ats[entry["ats"]] = by_ats.get(entry["ats"], 0) + 1
    by_region = {}
    for entry in entries:
        by_region[entry["region"] or "(unset)"] = by_region.get(entry["region"] or "(unset)", 0) + 1
    print("registry.json: %d entries (%d kept, %d newly discovered, %d aggregator/feed)"
          % (len(entries), kept, added, len(AGGREGATORS) + len(WWR_FEEDS)))
    print("by ATS:    %s" % dict(sorted(by_ats.items(), key=lambda kv: -kv[1])))
    print("by region: %s" % dict(sorted(by_region.items(), key=lambda kv: -kv[1])))
    print("postings visible on the new boards: %d" % sum(h["jobs"] for h in discovered))


if __name__ == "__main__":
    main()

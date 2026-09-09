# tools/ — registry generation

Offline only. Nothing here ships to the browser; the app stays a static page
with no backend. These scripts exist so `registry.json` is reproducible rather
than hand-maintained.

## Why a registry exists at all

JobLens has no job-search API behind it. The browser fetches each employer's
public ATS endpoint directly, which only works where the endpoint sends
`Access-Control-Allow-Origin`. Indeed, LinkedIn, Naukri, Instahyre, Wellfound,
Seek, Adzuna, USAJobs and Workday are all closed to a browser — they need a
server-side key or scraping, and there is no server.

So the reachable world is: ATS boards that are CORS-open, plus the handful of
aggregator feeds that are.

## Running it

    python tools/discover.py        # probe every candidate, writes discovered.json
    python tools/build_registry.py  # merge with the feeds, writes registry.json

`discover.py` takes ~10 minutes for ~450 names. Two things it learned the hard
way, both encoded in the code:

- **Read the whole body.** An early version capped reads at 400KB, so every
  large board failed to JSON-parse and was recorded as "no board" — silently
  discarding exactly the biggest employers. Ramp's Ashby board is 2.4MB.
- **Concurrency changes the answer.** At 16 workers, Greenhouse and Ashby
  throttle and a real board looks absent. 8 workers is the tested ceiling; a
  "not found" from a faster sweep proves nothing.

A board is recorded only if it answers 200, sends CORS, parses, AND currently
has at least one posting. An empty board costs a request per refresh and
returns nothing.

## Adding companies

Add names to the blocks in `companies.py` and re-run. `discover.py` tries slug
variants (dashed, squashed, suffix-stripped) against every CORS-open ATS, so a
name being wrong costs one failed request.

## Coverage ceiling

Indian employers are the weak spot: most use Darwinbox, Keka, Zoho Recruit or
their own careers pages, none of which are reachable from a browser. The ones
that surface do so because they happen to run Greenhouse, Lever or Ashby.

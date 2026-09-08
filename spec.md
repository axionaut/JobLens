# JobLens Specification

Behavioural record, organised by version. Newer sections supersede older ones.

## 1. Facet ratings (superseded by 2)

Five fixed facets — Role, Level, Company, Location, Salary — each rated 1–5.
Replaced because the same five dimensions were rated on every posting, so the
marginal information per rating collapsed, and the things that actually separate
two backend jobs (on-call, greenfield, visa sponsorship, domain) were only
learned indirectly through a tag lane needing many ratings and much contrast.

## 2. Tag ranking

### 2.1 Closed tag ontology

Tags come from a curated vocabulary (`TAG_ONTOLOGY`, 120 entries) plus derived
structured facts. Nothing is mined from prose.

The mined tagger could not support ranking. Across 2,499 postings its commonest
tags were `fair chance`, `angeles county` and `chance ordinance` — the Los
Angeles Fair Chance Ordinance disclaimer, in ~30% of postings — plus
`computer hardware` from an export-control notice and mangled German boilerplate
(`unterst tzung`, umlauts destroyed by the ASCII filter). Of 10,841 distinct
tags only 94 (0.9%) sat in a frequency band worth an opinion; 10,173 appeared in
under 0.2% of jobs.

After the change: 150 distinct tags, 0 untagged postings, median 9 tags per
posting, 87% of tags inside the rankable band.

Location, seniority, region, pay band and experience floor are emitted as tags
rather than separate fields, so they compete for a click alongside Kubernetes
and Greenfield instead of occupying permanent slots.

### 2.2 Rankable band

Only tags on between `TAG_BAND_MIN` (0.4%) and `TAG_BAND_MAX` (30%) of the
library are offered. Below the floor a click would move a handful of postings;
above the ceiling the tag cannot discriminate. `On-site` (86%) and `Mid` (48%)
are excluded by the ceiling. Coverage is shown on each chip's tooltip.

### 2.3 Ranking interaction

Chips are clicked in preference order; the rank shows on the chip. Clicking a
ranked chip removes it. The `·` marker inside a chip flags a tag as unwanted.
Ranking is partial by design — rank two, or ten.

### 2.4 Learning

Bradley-Terry over pairwise comparisons. Each event yields:

- clicked[i] beats clicked[j] for i<j, weight 1
- clicked beats unclicked, weight 0.7
- clicked beats disliked, weight 1
- unclicked beats disliked, weight 0.5

24 passes, learning rate 0.16 decaying at 0.94, L2 shrink 0.012 per pass. The
update is the residual `(1 − P(a beats b))`, so a comparison already predicted
teaches nearly nothing and a contradiction teaches a lot.

Three clicks and one dislike on a twelve-tag posting produced 50 comparisons
across 15 tags. A ranked `Python` immediately applied to 452 postings.

Utilities are always retrained from stored events, never updated in place, so a
ranking can be changed or removed and the model rebuilt exactly.

### 2.5 Scoring

A posting scores as the mean utility of its rankable tags — mean, not sum, so a
twenty-tag posting cannot beat a six-tag one on volume.

The card shows a **percentile within the current pool**, not a predicted rating.
Ranking data carries no absolute scale: the user never said a job was "4 out of
5", only that one tag beats another, so a percentile is the only honest reading.

### 2.6 Dismissal

"Not for me" is a weak negative across all of the posting's tags at
`DISMISS_WEIGHT` 0.25, plus hiding. It deliberately does not guess which tag was
at fault — that attribution error is what the single-star model got wrong.

### 2.7 Migration

Records carrying `rating` (v1 single star) or `ratings` (facets) have them
dropped. Neither maps onto a tag order: knowing a job scored 4 says nothing
about which tag earned it, and inventing a ranking from it would fabricate
preferences the user never expressed. Postings themselves are kept.

### 2.8 Release gate

`.claude/gate.sh`, ported from CineLens, blocks a commit touching `app.js` when
`APP_VERSION` is unbumped, `node --check` fails, the staged diff has whitespace
damage, `spec.md` lacks a section for the new version, or a local-only file is
staged. The co-author trailer check is removed: this project keeps the trailer.

### 2.9 Render ceiling

`RENDER_CEILING` caps any grid at 200 cards. A stale pinned order once returned
the whole candidate set to the Rate view and produced a 6.9MB grid.

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

## 3. Bidirectional ranking, and three fixes to v2

### 3.1 "Not for me" produced no comparisons

`eventPairs` builds constraints as (winner, loser) pairs. A dismissal was
recorded as `disliked: <every tag on the posting>`, which left `rest` empty, so
the loop had nothing for the disliked tags to lose to and the event yielded
**zero** pairs. The click hid the card and taught the model nothing.

Same hole, second symptom: a posting where the only interaction was the `·`
marker had an empty `order`, so `rankingEvents` skipped it entirely (its
`else if (job.dismissed)` branch does not fire for a card that was never
dismissed) while `hasRanking` still counted it as rated. The posting left the
For You pool and contributed nothing.

Fixed with an anchor: `BASELINE`, a synthetic tag held at utility 0 that every
explicit negative loses to. It is excluded from the returned utilities and from
the tag count, and never rendered. This is the one place the model admits an
absolute reference, and it has to: "below neutral" is the only available reading
of a dislike when there is nothing else on the posting to compare it against.
`DISMISS_WEIGHT` 0.25 still applies, so a dismissal is a quarter of a ranking.

Events are now built from `tags.filter(tagIsRankable)` rather than raw tags. A
tag outside the band was never drawn on the card, so a dismissal cannot honestly
be read as an opinion about it.

### 3.2 The structured facets were emitted and then dropped

v2 emitted level, location mode, region, pay band and experience floor as tags,
and 2.2 excluded anything above `TAG_BAND_MAX` (30%) -- which is every one of
them that matters. `Mid` sits on 48% of postings and `On-site` on 86%, so the
level and location chips were computed on every posting and then filtered off
the card. Role family was worse: computed into `job.family`, never added to
`tags` at all, so it could not be ranked under any setting.

`STRUCTURAL_TAGS` (role families, `SENIORITY_ORDER`, `PAY_BANDS`,
`EXPERIENCE_BANDS`, location modes, regions) is exempt from the band. The
ceiling is the right rule for a skill tag -- a tag on everything cannot separate
two postings -- and the wrong one for the dimensions a person opens a job board
to filter on. `Unspecified` and `Other` stay out: they are the absence of a
fact, so there is nothing to hold a preference about.

### 3.3 Ranking from the bottom

Left-click appends to `ranking.order`, best first, as before. Right-click
appends to `ranking.bottom`, **worst first** -- the mirror gesture, not a
different kind of opinion. Naming the two tags you would refuse is usually
easier than ordering the eight you would accept, and both produce the same kind
of pairwise constraint.

Three tiers, best to worst: `order` in click order, then everything untouched,
then `bottom` reversed, then explicit dislikes. Weights follow 2.4 -- explicit
against explicit 1, anything involving the untouched middle 0.7, untouched
against disliked 0.5.

Clicking a chip with the button that ranked it removes it; clicking with the
other button moves it across, since a tag in both lanes would assert that it
beats itself. The `contextmenu` default is suppressed only over a chip, so the
browser menu still works everywhere else on the card -- notably on the title
link, which is how a posting gets opened in a new tab.

A ranked chip shows its position from the top; a bottom-ranked one shows
`↓n` counted from the bottom. Two number lines, not one, because the middle
of the card is deliberately left unranked.

### 3.4 Migration

`ranking.bottom` is backfilled to `[]` on load and in `ensureRanking`, so v2
records train unchanged. No stored ranking is reinterpreted.

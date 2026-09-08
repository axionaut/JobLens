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

### 3.5 Cache-busting

v3 shipped and was invisible: the browser held the previous `app.js`, so the
badge still read v2 and nothing about the page suggested a release had happened.
`index.html` now loads `app.js?v=N` and `styles.css?v=N`, and its `versionBadge`
fallback text is `vN`, all three tracking `APP_VERSION`.

The gate checks all three on any commit touching `app.js`. A bump that forgets
the cache-buster is worse than no bump, because every local check passes and the
deployed page is unchanged.

## 4. Live scores, pinned order

### 4.1 What was actually frozen

Two separate freezes, only one of them intended.

`pinnedOrder` freezes the surfaced ORDER until the view or filters change. That
is correct and stays: a posting leaves the For You candidate pool the instant it
is ranked, so re-sorting on every click would pull the card out from under the
cursor mid-ranking and the next click would land on a different job.

`refreshCard` redrew only the card just clicked. Every other percentage on
screen kept describing a model several rankings out of date, with nothing on the
page to say so. That was never a design decision, only a cost dodge -- the
comment justified it as "1.5s at 60 ratings".

### 4.2 The cost that justified it

Re-measured at the size it actually runs at (16,224 postings, harness in
`node`), a full re-render was ~400ms at 27 rankings and ~490ms at 300. Two
causes, both waste:

- `scoredList` called `jobScore` for the percentile distribution and then
  `predictFit`, which calls `jobScore` again -- 32,448 scorings per render.
- Every scoring sorted a contributions array and ran two filters to fill
  `fit.positive` and `fit.negative`, which **nothing has ever read**.

`jobScore` is now memoised per posting on a cache cleared by `invalidateTaste`,
the breakdown fields are gone, and `resumeEvidenceScale` is hoisted out of the
per-tag loop. A full re-render is now ~82ms at 27 rankings and ~144ms at 300,
dominated by retraining rather than scoring.

### 4.3 Scheduled rescore

A ranking redraws the clicked card immediately -- that is the feedback for the
click -- and schedules a full re-render `RESCORE_DELAY` (220ms) after the last
click in a burst. Same pinned order, every visible percentage recomputed.
`repinOrder` cancels a pending rescore, so one in flight cannot land on a list
the user has just re-sorted or refiltered and quietly undo it.

### 4.4 Drift is offered, not applied

`pinnedDrift` counts the positions where the pinned order disagrees with the
freshly scored order. Cards absent from the fresh list -- just ranked, so out of
the candidate pool -- are excluded: they are held in place deliberately. When it
is non-zero, For You and Rate carry a `re-sort — N cards moved` button. The list
never reorders itself, because a list silently sorted two rankings ago looks
exactly like a list that disagrees with you.

### 4.5 Flat distributions have no percentile

`scorePercentile` returns null when the lowest and highest score in the pool are
equal. Before any ranking every posting scores 0, and the binary search dutifully
returned 0, so every card read "better than 0% of your pool". A percentile over
a flat distribution is not a weak signal, it is a meaningless one; the card
already renders `—` for null.

## 5. The top bar

### 5.1 Only the filters were sticky

`#appHeader` (brand, tabs, headline) was not sticky at all; `.deck` was, at
`top:0`. So scrolling took the tabs and the counts off screen and left a filter
row stuck to the top of the viewport under nothing. Four stacked bands cost
~190px before the first card.

Now one `#topbar` holds all of it and sticks as a unit: a dense row of
brand / tabs / actions, a stats row, and a filter row that folds. 136px open,
80px folded, against ~190px that did not stay.

### 5.2 Filters say what they are doing

Five selects gave no answer to "why am I seeing 8,000 of 16,000 postings"
without inspecting each one. Every active filter is now a pill naming its value,
and clicking a pill removes that filter. `Filters` carries a count and folds the
row; `Clear all` resets them.

`Has salary only` ships on and hid 7,869 of 16,228 postings without ever being
chosen. It is listed as a pill like any other, and `Clear all` takes salary to
Any rather than back to it -- clearing filters means stop hiding postings, not
restore a hiding rule.

Note the distinction the first attempt got wrong: `''` (Any) is OFF for the
salary filter, `'has'` is merely the value it ships with. Comparing against the
shipped value listed Any as active, producing a pill that could not be removed
because clearing it set the value it already had.

The headline now leads with `N of M shown` -- what is on screen -- instead of
the library total, which never explained anything about the screen.

### 5.3 Accessibility

- `#topbar` is sticky, so the tabs and filters are reachable at any scroll.
- `role="tablist"` / `role="tab"` with `aria-selected` maintained on render, and
  arrow-key/Home/End navigation. The roles without the key handling would have
  been a regression: it claims behaviour a screen-reader user then expects.
- The tab group is one tab stop (`tabIndex` -1 on inactive tabs), per the
  tablist pattern, rather than five.
- `:focus-visible` outlines. The custom backgrounds had all but erased the
  browser default, so keyboard focus was invisible.
- A skip link to `#main`.
- `aria-live="polite"` on the headline, `aria-expanded` on the filter toggle.

### 5.4 Notices

Every view opened with a paragraph, re-rendered on every click, in a colour that
demands to be read first. They are now one line each, with the qualifications
in muted text.

### 5.5 Clearing a resume wiped unrelated settings

`resumeClear` assigned a whole new `state.settings` object, dropping
`salaryFilter` (and now `filtersOpen`) with it, so clearing a resume silently
reset the salary filter. It now clears only the three resume keys.

## 6. A positive verdict, and a wider vocabulary

### 6.1 The model could only be told no

"Not for me" had no opposite. The only whole-posting verdict was negative, so
the jobs worth applying to -- the ones with the most to teach -- taught nothing
unless you also picked apart which tag earned it.

`likeJob` is the mirror: every rankable tag on the posting goes above `BASELINE`
at `LIKE_WEIGHT` 0.4, without guessing which one did the work. Weighted above a
dismissal (0.25) because you dismiss in bulk on cards you barely read and save
one you actually considered, and well below an explicit ranking (1.0) because it
still names no tag.

It does **not** hide the card. That is the point: Rated doubles as the shortlist
of postings worth going back to. It leaves the For You candidate pool the way a
ranked posting does, and the two verdicts are mutually exclusive -- liking
clears a dismissal and vice versa.

### 6.2 The middot is gone

The per-chip `·` marked a tag as never-wanted. That is a real distinction from
right-click's "worst thing on THIS posting" -- absolute against relative -- but
three targets on one 80px chip, the third a bare dot, read as a stray dash
rather than a control. Chips now have two gestures and the card has two
verdicts.

`ranking.disliked` stays in the model: dismissals populate it, and stored v2-v5
records still carry it, so a disliked tag still renders (as `✕`) and still
trains. Nothing stored is reinterpreted.

### 6.3 Ontology: 120 -> 203 entries

Four dimensions were missing outright.

- **Company** (10, new lane): seed / Series A-B / Series C+ / public /
  bootstrapped / unicorn / tiny team / big company / agency / non-profit.
  Nothing previously distinguished a twelve-person startup from a listed
  multinational.
- **Benefits** (12, new lane): 4-day week, unlimited PTO, 30d+ leave, parental
  leave, learning budget, home-office stipend, health insurance, retirement
  match, bonus, wellness, sabbatical, work-from-anywhere. Only `Equity` existed.
- **Office** (7, new lane): remote-first, 1-2 days in office, 3+ days in office,
  timezone overlap, async-friendly, flexible hours, relocation expected.
  `Hybrid` covered everything from one day a month to four a week.
- **Tail**: 29 more stacks (QA/Playwright, Databricks, ClickHouse, Flink,
  Prometheus, GitHub Actions, Helm/ArgoCD, eBPF, Solidity, Unity, WASM,
  Tailwind, Figma, Salesforce, SAP, Tableau, Haskell, ROS, FPGA, GDPR, SOC2,
  ...), 12 industries (crypto, insurance, proptech, travel, legal, HR, adtech,
  telecom, manufacturing, aerospace, agritech, sports), 4 more languages, and
  8 conditions (take-home, live coding, degree/no degree, founding role,
  IC vs manager-of-managers).

One realistic posting went from ~9 tags to 30.

### 6.4 Two false positives the expansion exposed

- `rails` matched "payment rails", so fintech postings claimed Ruby. Now
  requires "on rails" or "rails framework/app/application/developer".
- Bare `healthcare` matched the benefits paragraph of any posting offering
  private medical cover, so unrelated companies read as healthtech. Now requires
  healthtech / digital health / clinical trials-data-workflow / patients /
  biotech / medical device / life sciences / pharma / EHR / "healthcare
  platform|provider|system|company|industry". The `Health insurance` perk tag
  carries the benefits sense.

`founding engineer` was also dropped from `Greenfield/0-to-1`, which
`Startup founding role` now names precisely -- two tags for one fact is noise.

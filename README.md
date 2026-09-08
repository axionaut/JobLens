# JobLens

A job search that learns from ratings instead of keywords. You rate a posting on
five separate things — **Role, Level, Company, Location, Salary** — 1 to 5 stars
each, and it learns what you actually want. You *can* give it your resume once
for a warmer start; it is optional and the app works fully without it.

Static: `index.html` + `styles.css` + `app.js` + `registry.json`. No build step,
no dependencies, no backend, no API keys, no accounts, nothing paid.

## Run it

```sh
python -m http.server 8731
```

Then open <http://localhost:8731>. It has to be served over http, not opened as
a `file://` path — `registry.json` is fetched.

First run: **Refresh postings** (a few minutes, pulls ~12k live postings from
142 sources), then the **Rate** tab. Salary and Location start working after two
ratings each.

The **Resume** button is there if you want a warmer start, but nothing prompts
you for it and nothing is gated behind it.

## Sources

142 entries: 138 company job boards plus 4 aggregator boards. All send
`Access-Control-Allow-Origin: *`, so collection runs from the browser with no
backend, no key and no quota.

| kind | source | notes |
| --- | --- | --- |
| ATS | Greenhouse | `boards-api.greenhouse.io/v1/boards/<slug>/jobs?content=true` |
| ATS | Ashby | `api.ashbyhq.com/posting-api/job-board/<slug>` — best salary data |
| ATS | Lever | `api.lever.co/v0/postings/<slug>?mode=json` |
| ATS | SmartRecruiters | needs one detail fetch per posting; slow, capped at 250 |
| board | Arbeitnow | Germany + wider Europe, ~1,100/pull across ~540 companies |
| board | RemoteOK | global remote, carries numeric salary |
| board | Remotive | global remote |
| board | Jobicy | global remote, carries salary + currency |

The company registry has a structural bias — it can only hold companies someone
thought to add, and the easiest ones to find are American. The four boards exist
to correct that: one entry each, pulling from hundreds of employers, weighted
toward Europe and toward remote. A single pull of the four returns ~1,300
postings from ~680 companies in about ten seconds.

21 registry companies are Indian (Paytm, Freshworks, Swiggy, Meesho, CRED,
PhonePe, Groww, Navi, Slice, Fi, Clear, Atlan, Postman, InMobi, Mindtickle,
Whatfix, Observe.AI, Unacademy, BlueStone, Turtlemint, Newton School).

### Regions

Postings are classified into US, Canada, UK, Europe, **Nordics**, ANZ, India,
APAC, LatAm, MEA and Remote. Nordics are separate from Europe deliberately —
distinct pay and immigration, and a Berlin rating should not speak for
Stockholm. Matching is explicit country and city vocabulary with no inference: a
wrong region is worse than none, because it teaches the Location facet something
false. About 15% of a European pull still lands unclassified; those simply carry
no region feature.

## The recommendation logic

Ratings are training truth. The residual-learning machinery is ported from
CineLens (`../Cinelens/app.js`, `spec.md` §8), but the rating model is not: a
film rating is one coherent thing, and a job rating is not.

Rating a job 2 stars because it is in the wrong city used to teach the model
that you dislike `python`, `kubernetes`, that company and that seniority — one
number supervising every lane, with the model left to guess which of them earned
the mark. It guessed badly, and every muddled weight then muddied every later
prediction.

So there are five facets, and each trains only the features it can speak to:

| facet | learns | how |
| --- | --- | --- |
| **Role** | the work itself | tag weights from the description, 9 residual passes, λ 2.8, lr 0.38 |
| **Level** | seniority and scope | shrunk mean per family + seniority |
| **Company** | the employer | shrunk mean per company |
| **Location** | where and how | shrunk mean per arrangement + region |
| **Salary** | the pay | ordered curve over the known PPP figure, forced monotone |

Salary and Location are the reason facets beat a single star by more than they
first appear. Both are objectively known for every posting, so rating them does
not learn a per-job weight — it fits a preference over a value the library
already holds, and that preference then applies to every posting including ones
you never look at. **Two salary ratings teach a threshold across all 12,000.**

Facets are optional per job. Rate what you can judge; an unrated facet
contributes nothing and is *skipped*, not counted as a neutral 3 — otherwise one
strong signal would be dragged to the middle by four abstentions. Clicking a star
you already set clears it.

Common tags are damped so wallpaper terms cannot dominate by frequency, and
postings are length-normalised against the median feature mass so a verbose
posting cannot outrank a better-matched terse one on volume. Each facet is
calibrated back to your own 1–5 distribution, so **the percentage is a predicted
rating** (`((predicted - 1) / 4) × 100`), not a share of matched tags.

Rated cards predict **leave-one-out**, per facet: the model is retrained without
that posting, then asked to predict it. A posting cannot improve its own
displayed fit by contributing its own ratings. That makes Rated a continuous
check on the model — a facet you rated 5 that predicts low means it has not
learned why yet.

If every rating you have given is identical, no facet can learn anything: each
weight comes from `rating − baseline`, and with no spread every residual is
zero. That case is detected and reported rather than silently producing an empty
screen.

### Where the resume fits

Optional, and never asked for — it sits behind a button. Without it the model
starts from a flat baseline and learns entirely from your ratings, which is the
main path; with it the first screen is sorted sensibly before you have rated
anything.

It takes CineLens's manual-tag-preference seat: a small additive term. The one
change is `RESUME_COLD_START_GAIN` — at zero ratings the resume is the only
signal and at CineLens's flat unit it spread predictions across nine points,
true to the model but useless to read, so the term is scaled by how little the
ratings know and decays as evidence arrives. It never grows with more resume
text, only shrinks with more ratings, so it cannot outrun what was learned.

The resume text is never stored. It is converted to tag weights on save and only
the weights are kept.

## "Not for me"

It teaches, it does not only hide. The click records **1 star on Role only** — not
on all five. "Not for me" on a card you barely read is a judgement about the kind
of work; claiming it also means "this company is bad" would invent four opinions
from one click, and a company blacklisted by three glances is hard to notice and
harder to undo. Say more by rating a facet.

It carries `ROW_WEIGHT_DISMISSED` (0.35) of a deliberate star, because the two
are not equally considered: dismissing happens in bulk, a star is a judgement. At
equal weight, dismissing 200 sales postings would swamp a dozen considered
5-stars and drag the baseline toward 1.

The posting is hidden from For You, Rate and Pool, stays visible in Rated with a
badge, and can be undone. Rating any facet on it promotes it back to full weight.

## Tabs

- **For You** — ranked by predicted fit. Says which facets it is ranking on, and
  which are dormant because nothing is rated on them yet.
- **Rate** — the postings nearest the middle of the scale, capped at 3 per
  family. These are the ones the model is least sure about, so each rating
  teaches it most.
- **Rated** — everything you rated, leave-one-out per facet. Dismissed postings
  appear here too, badged, with an undo.
- **Pool** — everything, newest first.
- **Tag Brain** — one table per facet: every learned weight against that facet's
  own baseline. This is the audit. If a weight here is wrong, the ranking is
  wrong for that reason.

Card order is **pinned** while you rate: a rating redraws only that one card, so
cards never reorder or vanish under the cursor mid-rating. The list re-sorts when
you switch tabs, change a filter, or refresh.

## Salary, in PPP rupees

Where a posting states pay, the card shows it converted to **purchasing-power
rupees**, with the original figure beside it and the market-rate equivalent in
the tooltip.

The two are very different and the difference is the point. USD/INR trades near
87; the PPP factor is near 21.5. A $200k US salary is about **₹1.75 crore at
market** and about **₹43 lakh in purchasing power**. The second answers "how
well would this let me live"; the first is what you would actually be paid and
could remit. The card labels the PPP figure and shows both, so they cannot be
confused.

Factors are World Bank *PPP conversion factor, GDP (LCU per international $)*,
2024 series, in `PPP_FACTORS`. They are an editable constant, not a fetch —
there is no CORS-open free PPP endpoint, and a wrong number you can see beats
one that changes silently underneath you. They drift a percent or two a year.

Pay bands feed the Salary facet on the **PPP figure**, so a US posting and an
Indian one land in the same band when they buy the same life — the only
comparison that means anything across a library this international.

### Postings with no stated salary are hidden by default

The **Salary** control in the deck defaults to *Has salary only*, and the choice
persists. Levels are ≥₹25L / ₹40L / ₹60L / ₹1Cr PPP, compared against the **top**
of the advertised range, since that is the number you would be negotiating
toward. *Any (incl. undisclosed)* puts them back.

They are filtered, not dropped at collection, for two reasons. A record thrown
away cannot come back if the company fills the figure in later — shed bytes,
never records. And on Greenhouse and Lever a missing salary is **the API having
no pay field at all**, not the employer withholding it: filtering on it removes
Stripe and Palantir wholesale for a reason that has nothing to do with them.

The filter is a *discovery* rule. It applies to For You, Rate and Pool, but not
to Rated — a posting you already rated stays visible and keeps training the
model whether or not it stated a salary. Your own decisions are not
retroactively hidden from you.

### Coverage is uneven, and that is the ATS's doing

| ATS | salary data |
| --- | --- |
| Ashby | **84%** — structured `minValue`/`maxValue`/`currencyCode`/`interval` |
| Greenhouse | **2%** — no pay field at all; parsed out of the description text |
| Lever | **0%** — no pay field, and its postings do not state it |

### Number formats

Both conventions are parsed: `$182,208 - $236,580`, `€65.000 - €85.000`,
`€70.000,00`, `65'000` (Swiss), `65 000` (French), `$257K`, `€22,50/hr`. The
separator rule is structural, not currency-based, because it cannot be inferred
from the currency — GBP uses the US convention and CHF does not. Reading
`€65.000` with US rules gives sixty-five euros, which the plausibility floor
then discards, so the posting would look like it had no salary rather than
looking wrong.

Employers also mislabel intervals. One OpenAI posting ships `$62.98 – $86.54`
tagged `interval: "1 YEAR"` — an hourly rate wearing an annual label. Declared
intervals are checked against magnitude and corrected, and anything still
implausible is dropped, because showing no salary is honest and showing a wrong
one is not.

## Storage

IndexedDB, per-origin. Postings are tagged on arrival and the description body
is then shed — the tags are what score, and keeping 11k full descriptions would
run to ~100MB for no benefit. Bytes are shed, never records: an unrated posting
may match well after a later tagger change.

If IndexedDB does not respond within 4s the app degrades to memory-only and says
`NOT SAVING` in the header rather than hanging on a blank page.

## Adding companies

`registry.json` is `{company, ats, slug}`. The slug is the last path segment of
a company's careers URL — `job-boards.greenhouse.io/**figma**`,
`jobs.ashbyhq.com/**Linear**`, `jobs.lever.co/**palantir**`. Every entry in the
shipped file was validated against the live endpoint; guessing a slug wrong is
the only real failure mode, and a failed company is reported in the console at
refresh rather than swallowed.

## Known limits

- **Salary coverage depends entirely on the source.** ~84% on Ashby, ~2% on
  Greenhouse, none on Lever. RemoteOK and Jobicy carry numeric ranges. Roughly
  half of all postings state one, and the default filter hides the rest.
- **PPP factors are a hand-maintained constant** and drift yearly. Check
  `PPP_FACTORS` against the World Bank series if precision matters.
- **The company registry is a seed, not coverage.** It is tech-weighted because
  that is what the candidate list was; the aggregator boards offset that, but
  only partly. Widen `registry.json` for other sectors.
- **No Workday.** Its endpoint is per-tenant (`wd*.myworkdayjobs.com/wday/cxs/…`)
  and needs a POST per company, so it is a different adapter shape.
- **The tagger is lexical, not semantic.** It matches a skill vocabulary plus
  repeated content phrases. It does not understand a posting.

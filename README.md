# JobLens

A job search that learns from ratings instead of keywords. On any posting you
**left-click its tags in the order you want them** — `Remote`, `₹60L–1Cr PPP`,
`Kubernetes`, `Greenfield` — and **right-click to rank from the other end**, first
right-click being the worst thing on the card. Every click is a comparison that
applies to the whole corpus, not just that job. You *can* give it your resume
once for a warmer start; it is optional and the app works fully without it.

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

## How the learning works

**You rank tags, not jobs.**

Five fixed facets ran out of road: after twenty postings you have said
"Location: 4" twenty times, and each repetition carries less than the last. The
things that actually separate two backend jobs — on-call, greenfield, visa
sponsorship, the domain — were only ever learned indirectly.

A star was a statement about *one posting*. **"Remote beats Python" is a
statement about every posting carrying either tag**, so it transfers across the
whole corpus the moment you make it. Ranking three tags on a posting carrying
twelve yields ~50 pairwise comparisons from three clicks, and a ranked `Python`
immediately moves 452 postings.

### Tags are a closed vocabulary

`TAG_ONTOLOGY` — 120 curated entries plus derived structured facts (location,
region, seniority, pay band, experience floor). Nothing is mined from prose.

The mined tagger could not support ranking. Its commonest tags across 2,499
postings were `fair chance`, `angeles county` and `chance ordinance` — the Los
Angeles Fair Chance Ordinance disclaimer, in 30% of postings — plus mangled
German boilerplate. Only 94 of 10,841 tags (0.9%) sat in a useful frequency
band. Now: **150 tags, 0 untagged postings, 87% rankable**.

Location, seniority and pay are tags now rather than fixed fields, so they
compete for a click against Kubernetes and Greenfield.

### Both ends of the card

Left-click ranks from the top, right-click from the bottom. `bottom[0]` is the
worst tag on the posting, `bottom[1]` the next-worst — the mirror of the
left-hand gesture, because naming the two things you would refuse is usually
easier than ordering the eight you would accept. The middle is left unranked on
purpose, and the two blocks are drawn as separate number lines. Clicking a chip
with the button that ranked it removes it; the other button moves it across.

### Only tags worth a click are shown

Skill tags: between 0.4% and 30% of the library. Below that a click moves a
handful of postings; above it the tag cannot discriminate. Each chip's tooltip
shows how many postings it covers.

The **structured facets are exempt** — role family, level, location mode,
region, pay band, experience floor are always offered however common they are.
The ceiling is right for a skill tag and wrong for the dimensions you opened a
job board to filter on: `Mid` sits on 48% of postings and `On-site` on 86%, and
ranking `Remote` above `₹60L–1Cr PPP` is worth saying anyway.

### The learner

Bradley-Terry over pairwise comparisons — the same maths as Elo. Clicked beats
later-clicked, clicked beats unclicked (0.7), anything beats disliked. 24
passes, lr 0.16 decaying 0.94, L2 shrink. The update is the residual, so a
comparison the model already predicts teaches almost nothing.

Utilities are always retrained from the stored events, never updated in place,
so any ranking can be changed or removed and the model rebuilt exactly.

### Percentile, not a rating

A posting scores as the **mean** utility of its rankable tags — mean, not sum,
so a twenty-tag posting cannot win on volume. The card shows a **percentile
within your current pool**, because ranking data has no absolute scale: you
never said a job was 4 out of 5, only that one tag beats another.

### "Not for me"

A weak negative across all the posting's rankable tags (0.25 weight), plus
hiding. It deliberately does not guess *which* tag was at fault — that
attribution error is exactly what the single-star model got wrong.

Every explicit negative loses to `BASELINE`, a synthetic tag held at utility 0.
Bradley-Terry only ever compares two tags, so a posting whose every tag is
disliked has nothing left to lose to and would otherwise yield no comparison at
all. The anchor is the fixed zero that "below neutral" is measured against, and
it is never scored or displayed.

## Tabs

- **For You** — ranked by learned tag utility, shown as a pool percentile.
- **Rate** — the postings carrying the most tags the model has never seen
  compared, capped at 3 per family. These teach the most per click.
- **Rated** — everything you have ranked, changeable; the model retrains from
  scratch each time. Dismissed postings appear here too, with an undo.
- **Pool** — everything, newest first.
- **Tag Brain** — every tag the model has an opinion about, its score, and how
  many postings it moves. This is the audit: a wrong weight is visible here
  rather than buried in a percentage.

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

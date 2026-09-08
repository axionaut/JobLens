/* JobLens — a rating-learned job recommender.
 *
 * The recommendation logic is ported from CineLens (Apps/Cinelens/app.js,
 * spec.md section 8): ratings are training truth, a regularized additive model
 * learns tag/family/condition effects from the residual between each rated
 * item's actual rating and the model's current prediction, common features are
 * damped, and the raw score is calibrated back to the user's own 1-5
 * distribution. Rated cards predict leave-one-out so a posting cannot improve
 * its own displayed fit by contributing its own tags to the model.
 *
 * Where CineLens has manual tag preferences as a small additive signal, JobLens
 * has the resume: it seeds taste before any ratings exist and then stays a minor
 * term while ratings take over. Same slot, same math, no new machinery.
 *
 * Static: no build step, no dependencies, no backend. Every ATS endpoint below
 * sends Access-Control-Allow-Origin:*, so collection runs from the browser.
 */

const APP_VERSION = 6;

/* ---------------------------------------------------------------- constants */

// Ported from CineLens app.js:10816-10821. Tuned there against a real rating
// history; kept identical here rather than re-guessed, and re-tunable once
// there are enough job ratings to justify moving them.
const TASTE_MODEL_TAG_REGULARIZATION = 2.8;
const TASTE_MODEL_BROAD_REGULARIZATION = 3.5;
const TASTE_MODEL_PASSES = 9;
const TASTE_MODEL_TAG_LEARNING_RATE = 0.38;
const TASTE_MODEL_BROAD_LEARNING_RATE = 0.24;
const TASTE_MODEL_RESUME_UNIT = 0.16;
// How much louder the resume is with no ratings at all than once ratings exist.
const RESUME_COLD_START_GAIN = 6;

// A family/seniority applies to far more postings than a skill tag, so its
// inferred signal is damped the way CineLens damps genres.
const BROAD_SCORE_FACTOR = 0.35;
const CONDITION_SCORE_FACTOR = 0.30;

const MIN_RATINGS_FOR_MODEL = 3;

// "Not for me" is a rating, not just a filter: it teaches the bottom of the
// scale. It is recorded as a real 1 so it trains through the same path as a
// deliberate 1-star, but it is WEIGHTED LOWER, because the two are not equally
// considered. Dismissing is one click on a card you barely read and it happens
// in bulk; a star rating is a judgement. At equal weight, dismissing 200 sales
// postings would swamp a dozen considered 5-stars and drag the baseline toward
// 1, making every prediction read low. This restores the per-row weight slot
// CineLens uses for cross-format evidence (formatTasteWeight, app.js:10832).
const DISMISSAL_RATING = 1;
const ROW_WEIGHT_DISMISSED = 0.35;
const ROW_WEIGHT_RATED = 1;
const TAG_MASS_PIVOT_FALLBACK = 6;
const REFRESH_CONCURRENCY = 6;

const DB_NAME = 'joblens';
const DB_VERSION = 1;

/* -------------------------------------------------------------- app state */

const state = {
  jobs: {},                 // id -> job record
  // Default: postings with no stated salary are out. Kept as a filter rather
  // than dropped at collection, because on Greenhouse and Lever a missing
  // salary is the API having no pay field at all, not the employer withholding
  // it -- and because a record thrown away cannot come back if the company
  // fills the figure in later. Shed bytes, never records.
  settings: { resumeTags: {}, resumeSavedAt: '', resumeChars: 0, salaryFilter: 'has', facetImportance: {} },
  meta: { lastRefresh: '' },
  view: 'foryou',
  filters: { text: '', seniority: '', location: '', age: 0, salary: 'has' }
};

let registry = [];
let refreshAbort = false;
const tasteModelCache = new Map();

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const $ = sel => document.querySelector(sel);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ------------------------------------------------------------- persistence */

// IndexedDB can fail in three ways that all look the same from here: it throws
// (some private-browsing modes), it errors, or it simply never fires any event
// at all -- which is what headless Chrome does, and what a blocked upgrade does
// when another tab holds the old version. The third case is the dangerous one,
// because an un-timed-out open leaves the whole app awaiting a promise that
// will never settle and the user sees a permanently blank page with no error.
// So the open is raced against a timeout and every failure degrades to the same
// place: memory-only, with the header saying so.
const DB_OPEN_TIMEOUT_MS = 4000;
let storageDegraded = '';

function openDb() {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => { if (!settled) { settled = true; fn(value); } };
    const timer = setTimeout(
      () => finish(reject, new Error('IndexedDB did not respond within ' + DB_OPEN_TIMEOUT_MS + 'ms')),
      DB_OPEN_TIMEOUT_MS);
    let req;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (err) {
      clearTimeout(timer);
      finish(reject, err);
      return;
    }
    req.onupgradeneeded = () => {
      const database = req.result;
      if (!database.objectStoreNames.contains('jobs')) database.createObjectStore('jobs', { keyPath: 'id' });
      if (!database.objectStoreNames.contains('kv')) database.createObjectStore('kv');
    };
    req.onsuccess = () => { clearTimeout(timer); finish(resolve, req.result); };
    req.onerror = () => { clearTimeout(timer); finish(reject, req.error || new Error('IndexedDB open failed')); };
    req.onblocked = () => { clearTimeout(timer); finish(reject, new Error('IndexedDB blocked by another tab')); };
  });
}

let dbHandle = null;
let dbAttempted = false;

// Resolves to a database or to null. Null means every write below becomes a
// no-op and the session lives in memory only: postings and ratings are real
// until the tab closes, and the header says they will not survive it. Losing
// ratings silently would be the worst outcome here, so it is stated rather
// than discovered.
async function db() {
  if (dbHandle || dbAttempted) return dbHandle;
  dbAttempted = true;
  try {
    dbHandle = await openDb();
  } catch (err) {
    dbHandle = null;
    storageDegraded = err.message;
    console.warn('JobLens: storage unavailable, running in memory only —', err.message);
  }
  return dbHandle;
}

async function loadState() {
  const d = await db();
  if (!d) return;
  const jobs = await new Promise((res, rej) => {
    const r = d.transaction('jobs').objectStore('jobs').getAll();
    r.onsuccess = () => res(r.result || []); r.onerror = () => rej(r.error);
  });
  // Records written before facets carry a single `rating`. It is migrated onto
  // the role facet, because a single star on a job card was overwhelmingly a
  // judgement of the work -- and because spreading it across all five would
  // invent four opinions the user never gave.
  // Records from before tag ranking carried a single star, then five facet
  // stars. Neither maps onto a tag ORDER -- knowing you gave a job 4 stars says
  // nothing about which of its tags earned them -- so the old scores are
  // dropped rather than invented into a ranking. The postings themselves stay.
  jobs.forEach(job => {
    delete job.rating;
    delete job.ratings;
    if (!job.ranking) job.ranking = { order: [], bottom: [], disliked: [] };
    if (!job.ranking.bottom) job.ranking.bottom = [];
    state.jobs[job.id] = job;
  });
  const kv = await new Promise((res, rej) => {
    const r = d.transaction('kv').objectStore('kv').get('root');
    r.onsuccess = () => res(r.result || null); r.onerror = () => rej(r.error);
  });
  if (kv) {
    state.settings = { ...state.settings, ...(kv.settings || {}) };
    state.meta = { ...state.meta, ...(kv.meta || {}) };
  }
}

async function saveJobs(records) {
  if (!records.length) return;
  const d = await db();
  if (!d) return;
  await new Promise((res, rej) => {
    const tx = d.transaction('jobs', 'readwrite');
    const os = tx.objectStore('jobs');
    records.forEach(r => os.put(r));
    tx.oncomplete = res; tx.onerror = () => rej(tx.error);
  });
}

async function saveMeta() {
  const d = await db();
  if (!d) return;
  await new Promise((res, rej) => {
    const tx = d.transaction('kv', 'readwrite');
    tx.objectStore('kv').put({ settings: state.settings, meta: state.meta }, 'root');
    tx.oncomplete = res; tx.onerror = () => rej(tx.error);
  });
}

/* -------------------------------------------------------------- collection */

// Every endpoint here was checked for Access-Control-Allow-Origin:* before the
// app was written as a static page. If one ever drops the header its whole ATS
// goes dark in the browser with no other symptom, so a fetch failure is
// reported per company rather than swallowed.
const ATS = {
  greenhouse: {
    url: slug => `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs?content=true`,
    rows: json => (json.jobs || []).map(j => ({
      key: String(j.id),
      title: j.title,
      url: j.absolute_url,
      location: j.location?.name || '',
      postedAt: j.updated_at || j.first_published || '',
      body: htmlToText(j.content || '')
    }))
  },
  ashby: {
    url: slug => `https://api.ashbyhq.com/posting-api/job-board/${slug}?includeCompensation=true`,
    rows: json => (json.jobs || []).map(j => ({
      key: String(j.id),
      title: j.title,
      url: j.jobUrl || j.applyUrl || '',
      location: [j.location, ...(j.secondaryLocations || []).map(s => s.location)]
        .filter(Boolean).join(' / '),
      postedAt: j.publishedAt || j.updatedAt || '',
      body: htmlToText(j.descriptionHtml || j.descriptionPlain || ''),
      compensation: j.compensation || null,
      remote: !!j.isRemote,
      department: j.department || j.team || ''
    }))
  },
  // SmartRecruiters is the one platform whose list endpoint carries no
  // description at all -- only title, location and department. Tagging on a
  // title alone would feed the role facet a handful of thin, misleading tags,
  // so the description is fetched per posting. That is one request each, which
  // is why it is capped and run at low concurrency: it is the slow adapter, and
  // it earns its place by being the only route to Freshworks and Swiggy.
  smartrecruiters: {
    url: slug => `https://api.smartrecruiters.com/v1/companies/${slug}/postings?limit=100`,
    rows: json => (json.content || []).map(j => ({
      key: String(j.id),
      title: j.name,
      url: j.ref || '',
      location: [j.location?.city, j.location?.region, j.location?.country]
        .filter(Boolean).join(', ') + (j.location?.remote ? ' (Remote)' : ''),
      postedAt: j.releasedDate || '',
      body: '',
      department: j.department?.label || j.function?.label || '',
      needsDetail: true
    })),
    detail: (slug, key) => `https://api.smartrecruiters.com/v1/companies/${slug}/postings/${key}`,
    fromDetail: json => {
      const sections = json.jobAd?.sections || {};
      return htmlToText([
        sections.jobDescription?.text,
        sections.qualifications?.text,
        sections.additionalInformation?.text
      ].filter(Boolean).join(' '));
    }
  },
  // ---- aggregator boards -------------------------------------------------
  //
  // The company-by-company registry has a structural bias: it can only contain
  // companies someone thought to add, and the ones easiest to find are American.
  // These four are job boards rather than employers -- one entry each, pulling
  // postings from thousands of companies, weighted toward Europe and toward
  // remote. They are the only realistic route to global coverage without
  // hand-curating a registry per country.
  //
  // Their rows carry their own company name, so `company` on the row overrides
  // the registry entry's label.

  // Germany and wider Europe, ~250 per page over many pages, full descriptions.
  arbeitnow: {
    url: () => 'https://www.arbeitnow.com/api/job-board-api',
    paged: page => `https://www.arbeitnow.com/api/job-board-api?page=${page}`,
    maxPages: 8,
    rows: json => (json.data || []).map(j => ({
      key: j.slug,
      title: j.title,
      company: (j.company_name || '').trim() || 'Unknown',
      url: j.url || '',
      location: j.remote && !/remote/i.test(j.location || '')
        ? (j.location || '') + ' (Remote)'
        : (j.location || ''),
      postedAt: j.created_at ? new Date(j.created_at * 1000).toISOString() : '',
      body: htmlToText(j.description || '') + ' ' + (j.tags || []).join(' ')
    }))
  },

  // Global remote, and the only board here that ships a numeric salary range.
  remoteok: {
    url: () => 'https://remoteok.com/api',
    rows: json => (Array.isArray(json) ? json.slice(1) : []).map(j => ({
      key: String(j.id),
      title: j.position,
      company: (j.company || '').trim() || 'Unknown',
      url: j.url || j.apply_url || '',
      location: (j.location || '').trim() || 'Remote',
      postedAt: j.date || '',
      body: htmlToText(j.description || '') + ' ' + (j.tags || []).join(' '),
      salaryHint: Number(j.salary_min) > 0
        ? { min: Number(j.salary_min), max: Number(j.salary_max) || Number(j.salary_min),
            currency: 'USD', interval: '1 YEAR' }
        : null
    }))
  },

  remotive: {
    url: () => 'https://remotive.com/api/remote-jobs?limit=200',
    rows: json => (json.jobs || []).map(j => ({
      key: String(j.id),
      title: j.title,
      company: (j.company_name || '').trim() || 'Unknown',
      url: j.url || '',
      location: j.candidate_required_location || 'Remote',
      postedAt: j.publication_date || '',
      body: htmlToText(j.description || '') + ' ' + (j.tags || []).join(' ') + ' ' + (j.salary || ''),
      department: j.category || ''
    }))
  },

  jobicy: {
    url: () => 'https://jobicy.com/api/v2/remote-jobs?count=100',
    rows: json => (json.jobs || []).map(j => ({
      key: String(j.id),
      title: j.jobTitle,
      company: (j.companyName || '').trim() || 'Unknown',
      url: j.url || '',
      location: j.jobGeo || 'Remote',
      postedAt: j.pubDate ? new Date(j.pubDate).toISOString() : '',
      body: htmlToText(j.jobDescription || j.jobExcerpt || '') + ' ' + (j.jobIndustry || []).join(' '),
      department: Array.isArray(j.jobIndustry) ? j.jobIndustry[0] : (j.jobIndustry || ''),
      salaryHint: Number(j.salaryMin) > 0
        ? { min: Number(j.salaryMin), max: Number(j.salaryMax) || Number(j.salaryMin),
            currency: (j.salaryCurrency || 'USD').toUpperCase(),
            interval: /year|annual/i.test(j.salaryPeriod || 'year') ? '1 YEAR' : String(j.salaryPeriod || '') }
        : null
    }))
  },

  lever: {
    url: slug => `https://api.lever.co/v0/postings/${slug}?mode=json`,
    rows: json => (Array.isArray(json) ? json : []).map(j => ({
      key: String(j.id),
      title: j.text,
      url: j.hostedUrl || j.applyUrl || '',
      location: j.categories?.location || '',
      postedAt: j.createdAt ? new Date(j.createdAt).toISOString() : '',
      body: htmlToText(j.descriptionPlain || j.description || '') + ' ' +
            (j.lists || []).map(l => `${l.text} ${htmlToText(l.content || '')}`).join(' '),
      department: j.categories?.team || j.categories?.department || ''
    }))
  }
};

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '-', mdash: '-',
  lsquo: "'", rsquo: "'", ldquo: '"', rdquo: '"', hellip: '...', bull: '*', middot: '*'
};

function decodeEntities(text) {
  let out = String(text || '');
  if (out.indexOf('&') === -1) return out;
  for (let pass = 0; pass < 2; pass++) {
    if (out.indexOf('&') === -1) break;
    out = out.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body) => {
      if (body.charAt(0) === '#') {
        const code = body.charAt(1) === 'x' || body.charAt(1) === 'X'
          ? parseInt(body.slice(2), 16)
          : parseInt(body.slice(1), 10);
        return isNaN(code) || code < 9 ? whole : String.fromCodePoint(code);
      }
      const named = NAMED_ENTITIES[body.toLowerCase()];
      return named === undefined ? whole : named;
    });
  }
  return out;
}

// Greenhouse hands back content that is HTML *escaped* (&lt;p&gt;...), so the
// entities must be decoded BEFORE tags are stripped. Doing it the other way
// round strips nothing -- there are no real tags yet -- and then decodes raw
// markup into the body, which is how 63% of postings came back with zero tags
// on the first run. Block-level tags become spaces so words either side of a
// list item cannot be welded into a phantom bigram.
function htmlToText(html) {
  return decodeEntities(String(html || ''))
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const DETAIL_CAP = 250;
const DETAIL_CONCURRENCY = 4;

// Fills in bodies for the one platform that does not ship them in its listing.
// Capped so a single large board cannot stall the whole refresh, and a posting
// whose detail fetch fails keeps its title-only record rather than vanishing.
async function fillDetails(spec, entry, rows) {
  const queue = rows.filter(row => row.needsDetail).slice(0, DETAIL_CAP);
  let cursor = 0;
  async function worker() {
    while (cursor < queue.length) {
      const row = queue[cursor++];
      try {
        const res = await fetch(spec.detail(entry.slug, row.key), { signal: AbortSignal.timeout(20000) });
        if (res.ok) row.body = spec.fromDetail(await res.json());
      } catch (err) { /* keep the title-only record */ }
    }
  }
  await Promise.all(Array.from({ length: DETAIL_CONCURRENCY }, worker));
  return rows;
}

async function fetchJson(url, label) {
  const res = await fetch(url, { signal: AbortSignal.timeout(25000) });
  if (!res.ok) throw new Error(`${label}: HTTP ${res.status}`);
  return res.json();
}

async function fetchCompany(entry) {
  const spec = ATS[entry.ats];
  if (!spec) return [];
  let rows = [];
  if (spec.paged) {
    // Boards paginate; a company board does not. Stop on the first empty page
    // rather than trusting the reported total, and cap the walk so one board
    // cannot dominate a refresh.
    for (let page = 1; page <= (spec.maxPages || 5); page++) {
      const batch = spec.rows(await fetchJson(spec.paged(page), entry.company));
      if (!batch.length) break;
      rows = rows.concat(batch);
    }
  } else {
    rows = spec.rows(await fetchJson(spec.url(entry.slug), entry.company));
  }
  if (spec.detail) rows = await fillDetails(spec, entry, rows);
  return rows.map(row => ({ ...row, entry }));
}

/* ------------------------------------------------------------------ salary */

// PPP conversion factors: units of local currency per international dollar,
// World Bank "PPP conversion factor, GDP (LCU per international $)", 2024
// series. The international dollar IS the US dollar by definition, so USD is
// 1 by construction.
//
// These are ESTIMATES and they drift a percent or two a year. They are here as
// an editable constant rather than fetched, because there is no CORS-open free
// PPP endpoint and a wrong number that silently changes under you is worse than
// a wrong number you can see and correct.
//
// Market rates are a different thing entirely and are NOT used here. USD/INR
// trades near 87; the PPP factor is near 21.5. A $200k US salary is therefore
// about Rs 1.75 crore at market and about Rs 43 lakh in purchasing power. The
// second number is the one that answers "how well would this let me live",
// which is what a PPP comparison is for -- but it is emphatically not what you
// would be paid or could remit. The card labels it PPP and shows the original
// figure alongside so the two can never be confused.
const PPP_FACTORS = {
  USD: 1,
  INR: 21.5,
  EUR: 0.70,
  GBP: 0.69,
  CAD: 1.21,
  AUD: 1.47,
  SGD: 0.84,
  CHF: 1.13,
  SEK: 8.80,
  BRL: 2.50,
  JPY: 100.0,
  PLN: 1.85,
  ILS: 3.60,
  MXN: 10.20
};
const PPP_SOURCE_YEAR = 2024;
const PPP_TARGET = 'INR';

// Rough market rates, used ONLY for the secondary "nominal" figure in the
// tooltip, so the PPP number is never mistaken for take-home. Same caveat: a
// visible constant beats an invisible fetch.
const NOMINAL_PER_USD = { USD: 1, INR: 87, EUR: 0.92, GBP: 0.79, CAD: 1.37, AUD: 1.52,
  SGD: 1.34, CHF: 0.88, SEK: 10.5, BRL: 5.4, JPY: 155, PLN: 3.9, ILS: 3.7, MXN: 18.5 };

const HOURS_PER_YEAR = 2080;
const MONTHS_PER_YEAR = 12;

function annualise(value, interval) {
  const i = String(interval || '').toUpperCase();
  if (i.indexOf('HOUR') !== -1) return value * HOURS_PER_YEAR;
  if (i.indexOf('MONTH') !== -1) return value * MONTHS_PER_YEAR;
  if (i.indexOf('WEEK') !== -1) return value * 52;
  if (i.indexOf('DAY') !== -1) return value * 260;
  return value;
}

// Ashby ships this properly structured, which is the only reason salary is
// usable at all: 781/781 of its postings carry min/max/currency/interval, while
// Greenhouse has no pay field and Lever has none either. Take the Salary
// component and ignore equity, which is not comparable across companies.
function salaryFromAshby(compensation) {
  if (!compensation) return null;
  const tiers = compensation.compensationTiers || [];
  for (const tier of tiers) {
    for (const part of (tier.components || [])) {
      if (String(part.compensationType || '') !== 'Salary') continue;
      const min = Number(part.minValue || 0);
      const max = Number(part.maxValue || min);
      if (!min && !max) continue;
      return {
        min: annualise(min || max, part.interval),
        max: annualise(max || min, part.interval),
        currency: String(part.currencyCode || 'USD').toUpperCase(),
        source: 'structured'
      };
    }
  }
  return null;
}

// Fallback for Greenhouse and Lever, which state pay in prose when they state it
// at all. Handles "$182,208 - $236,580/yr", "$257K - $335K", en/em dashes, and
// a bare single figure. Deliberately conservative: a wrong salary is worse than
// no salary, so anything that does not look like a real pay range is dropped.
const CURRENCY_SYMBOLS = { '$': 'USD', '€': 'EUR', '£': 'GBP', '₹': 'INR', '¥': 'JPY' };

// Thousands and decimal separators are swapped between conventions: 65,000.50
// in the US and UK is 65.000,50 across most of Europe, and Switzerland writes
// 65'000. Reading a European figure with US rules turns EUR 65.000 into sixty
// five euros, which the plausibility floor then discards -- so the posting
// looks like it has no salary rather than looking wrong, which is why this has
// to be handled at parse time rather than caught downstream.
//
// The rule is structural, not currency-based, because it cannot be inferred
// from the currency: GBP uses the US convention and CHF does not.
//
//   both separators present  -> whichever comes LAST is the decimal
//   one separator, repeated  -> thousands (65.000.000)
//   one separator, once      -> decimal only if 1-2 trailing digits;
//                               exactly 3 trailing digits is thousands
//
// The single remaining ambiguity is a lone separator with exactly three digits
// after it: "1.500" is 1500 everywhere in Europe and 1.5 in a US context that
// would never write a salary that way. Three digits wins, and a value that
// small is rejected by the floor regardless.
function parseMoney(token) {
  let text = String(token).trim().replace(/[\s  ']/g, '');
  const thousand = /[kK]$/.test(text);
  if (thousand) text = text.replace(/[kK]$/, '');

  const lastDot = text.lastIndexOf('.');
  const lastComma = text.lastIndexOf(',');
  let decimalAt = -1;

  if (lastDot !== -1 && lastComma !== -1) {
    decimalAt = Math.max(lastDot, lastComma);
  } else if (lastDot !== -1 || lastComma !== -1) {
    const only = lastDot !== -1 ? '.' : ',';
    const at = lastDot !== -1 ? lastDot : lastComma;
    const occurrences = text.split(only).length - 1;
    const trailing = text.length - at - 1;
    if (occurrences === 1 && trailing > 0 && trailing < 3) decimalAt = at;
  }

  const whole = (decimalAt === -1 ? text : text.slice(0, decimalAt)).replace(/[.,]/g, '');
  const fraction = decimalAt === -1 ? '' : text.slice(decimalAt + 1).replace(/[.,]/g, '');
  const value = parseFloat(whole + (fraction ? '.' + fraction : ''));
  if (isNaN(value)) return 0;
  return thousand ? value * 1000 : value;
}

// Hourly pay is written in small numbers with decimals ($45.00 - $60.00), a
// shape that would match half the prose in a job description if it were folded
// into the annual pattern. So it gets its own pass, and that pass REQUIRES the
// per-hour wording next to the figure before it will believe a two-digit number
// is money.
function hourlyFromText(body) {
  // Comma decimals too, since an hourly rate is exactly where a European
  // posting writes 45,00 rather than 45.00.
  const re = /([$\u20ac\u00a3\u20b9])\s?(\d{1,3}(?:[.,]\d{1,2})?)\s*(?:-|\u2013|\u2014|to|bis)\s*[$\u20ac\u00a3\u20b9]?\s?(\d{1,3}(?:[.,]\d{1,2})?)\s*(?:\/|per\s)?\s?(?:hr|hour|std)/i;
  const match = re.exec(body);
  if (!match) return null;
  const currency = CURRENCY_SYMBOLS[match[1]] || 'USD';
  let min = parseMoney(match[2]) * HOURS_PER_YEAR;
  let max = parseMoney(match[3]) * HOURS_PER_YEAR;
  if (max < min) { const swap = min; min = max; max = swap; }
  if (min < 15000 || max > 2000000) return null;
  return { min: Math.round(min), max: Math.round(max), currency: currency, source: 'text' };
}

function salaryFromText(text) {
  const body = String(text || '');
  const hourly = hourlyFromText(body);
  if (hourly) return hourly;
  // A money token in either convention: grouped by commas (65,000), by dots,
  // apostrophes or thin spaces (65.000 / 65'000 / 65 000), K-suffixed (65K,
  // 65,5K), or an ungrouped run of digits. An optional decimal tail in either
  // separator is allowed, so 65.000,50 and 65,000.50 both match in full and
  // parseMoney decides which separator was which. Matching only part of a
  // European figure would be worse than not matching it.
  const MONEY = "\\d{1,3}(?:[.,'\\u202f\\u00a0 ]\\d{3})+(?:[.,]\\d{1,2})?" +
    "|\\d{2,3}(?:[.,]\\d{1,2})?[kK]" +
    "|\\d{5,7}(?:[.,]\\d{1,2})?";
  const re = new RegExp(
    '([$\\u20ac\\u00a3\\u20b9\\u00a5])\\s?(' + MONEY + ')' +
    '\\s*(?:-|\\u2013|\\u2014|to|bis)\\s*' +
    '[$\\u20ac\\u00a3\\u20b9\\u00a5]?\\s?(' + MONEY + ')', 'g');
  let best = null;
  let match;
  while ((match = re.exec(body))) {
    const currency = CURRENCY_SYMBOLS[match[1]] || 'USD';
    let min = parseMoney(match[2]);
    let max = parseMoney(match[3]);
    if (max < min) { const swap = min; min = max; max = swap; }
    const hourly = /\/\s?(hr|hour)|per hour/i.test(body.slice(match.index, match.index + 60));
    if (hourly) { min = min * HOURS_PER_YEAR; max = max * HOURS_PER_YEAR; }
    // A plausible annual salary in the currency's own units. This rejects
    // fundraising figures, ARR, and customer counts, which is what most
    // large numbers in a job description actually are.
    const floor = currency === 'INR' ? 200000 : 20000;
    const ceiling = currency === 'INR' ? 200000000 : 2000000;
    if (min < floor || max > ceiling) continue;
    if (!best || max > best.max) best = { min: min, max: max, currency: currency, source: 'text' };
  }
  return best;
}

// Converted through international dollars: out of the source currency at its
// own PPP factor, then into rupees at India's. An unknown currency returns null
// rather than guessing, so an unconverted salary is visibly absent instead of
// quietly wrong.
function toTargetPpp(salary) {
  if (!salary) return null;
  const from = PPP_FACTORS[salary.currency];
  const to = PPP_FACTORS[PPP_TARGET];
  if (!from || !to) return null;
  const rate = to / from;
  return { min: Math.round(salary.min * rate), max: Math.round(salary.max * rate), rate: rate };
}

function toTargetNominal(salary) {
  if (!salary) return null;
  const from = NOMINAL_PER_USD[salary.currency];
  const to = NOMINAL_PER_USD[PPP_TARGET];
  if (!from || !to) return null;
  const rate = to / from;
  return { min: Math.round(salary.min * rate), max: Math.round(salary.max * rate) };
}

// Indian digit grouping, because the reader is reading rupees: 1,00,000 is a
// lakh and 1,00,00,000 is a crore, and a number this size is unreadable without
// the right units.
function formatInr(value) {
  const n = Number(value || 0);
  if (n >= 10000000) return '₹' + (n / 10000000).toFixed(n >= 100000000 ? 0 : 2).replace(/\.00$/, '') + ' Cr';
  if (n >= 100000) return '₹' + (n / 100000).toFixed(n >= 10000000 ? 0 : 1).replace(/\.0$/, '') + ' L';
  return '₹' + n.toLocaleString('en-IN');
}

function formatSource(salary) {
  const symbol = { USD: '$', EUR: '€', GBP: '£', INR: '₹', JPY: '¥' }[salary.currency] ||
    (salary.currency + ' ');
  const short = value => value >= 1000 ? Math.round(value / 1000) + 'K' : String(value);
  return symbol + short(salary.min) + ' - ' + symbol + short(salary.max);
}

// Bands are cut on the PPP rupee figure so the condition lane learns in one
// consistent unit. A US posting and an Indian one land in the same band when
// they buy the same life, which is the only comparison that means anything
// across a library this international.
function salaryBand(pppRange) {
  if (!pppRange) return '';
  const mid = (pppRange.min + pppRange.max) / 2;
  // Labelled as a person reads them, because these are chips you rank against
  // Kubernetes and Remote, not internal keys.
  if (mid >= 15000000) return '₹1.5Cr+ PPP';
  if (mid >= 10000000) return '₹1–1.5Cr PPP';
  if (mid >= 6000000) return '₹60L–1Cr PPP';
  if (mid >= 4000000) return '₹40–60L PPP';
  if (mid >= 2500000) return '₹25–40L PPP';
  return 'under ₹25L PPP';
}

// Plausible annual pay in the currency's own units, derived from the PPP table
// rather than a per-currency list, so adding a currency above adds its bounds
// too. 15k-2M international dollars spans an internship stipend to a very
// senior package.
function plausibleAnnual(value, currency) {
  const factor = PPP_FACTORS[currency];
  if (!factor) return false;
  return value >= 15000 * factor && value <= 2000000 * factor;
}

// Employers mislabel the interval. OpenAI ships "$62.98 - $86.54" tagged
// `interval: "1 YEAR"`, which is an hourly rate wearing an annual label, and
// taking it at its word prints a salary of about 1,300 rupees a year. So the
// declared interval is checked against the magnitude: if an "annual" figure is
// far too small to be one but becomes sensible at 2,080 hours, it was hourly.
// Anything still implausible after that is dropped, because showing no salary
// is honest and showing a wrong one is not.
function reconcileInterval(salary) {
  if (!salary) return null;
  if (plausibleAnnual(salary.min, salary.currency)) return salary;
  const asHourly = { min: salary.min * HOURS_PER_YEAR, max: salary.max * HOURS_PER_YEAR };
  if (plausibleAnnual(asHourly.min, salary.currency)) {
    return Object.assign({}, salary, asHourly, { intervalCorrected: true });
  }
  return null;
}

function salaryFromHint(hint) {
  if (!hint || !(hint.min > 0)) return null;
  return {
    min: annualise(hint.min, hint.interval),
    max: annualise(hint.max || hint.min, hint.interval),
    currency: String(hint.currency || 'USD').toUpperCase(),
    source: 'structured'
  };
}

function extractSalary(row, body) {
  const structured = salaryFromHint(row.salaryHint) || salaryFromAshby(row.compensation);
  const salary = reconcileInterval(structured || salaryFromText(body));
  if (!salary) return null;
  const ppp = toTargetPpp(salary);
  if (!ppp) return null;
  return {
    min: salary.min,
    max: salary.max,
    currency: salary.currency,
    source: salary.source,
    pppMin: ppp.min,
    pppMax: ppp.max,
    intervalCorrected: !!salary.intervalCorrected,
    band: salaryBand(ppp)
  };
}

function salaryHtml(job) {
  const salary = job.salary;
  if (!salary) return '';
  const nominal = toTargetNominal(salary);
  const tip = formatSource(salary) + ' ' + salary.currency +
    '  ·  PPP-adjusted at ' + PPP_FACTORS[salary.currency] + ' ' + salary.currency +
    ' per international $ (World Bank ' + PPP_SOURCE_YEAR + ')' +
    (nominal ? '  ·  at market rates this would be ' + formatInr(nominal.min) + ' - ' + formatInr(nominal.max) +
      ', which is what you would be paid, not what it buys here' : '') +
    (salary.source === 'text' ? '  ·  read out of the description, not a structured field' : '') +
    (salary.intervalCorrected ? '  ·  posted as annual but the figures are hourly, so read as hourly' : '');
  return '<div class="salary" title="' + esc(tip) + '">' +
    '<strong>' + esc(formatInr(salary.pppMin)) + ' - ' + esc(formatInr(salary.pppMax)) + '</strong>' +
    '<span class="pppTag">PPP</span>' +
    '<span class="muted">' + esc(formatSource(salary)) + ' ' + esc(salary.currency) + '</span></div>';
}

/* ---------------------------------------------------------------- ontology */

// Tags are a CLOSED, curated vocabulary, not phrases mined from the text.
//
// The mined version could not support ranking. Across 2,499 postings its most
// common tags were "fair chance", "angeles county" and "chance ordinance" -- the
// Los Angeles Fair Chance Ordinance disclaimer, in 30% of postings -- alongside
// "computer hardware" from an export-control notice and mangled German
// boilerplate ("unterst tzung"). Only 94 of 10,841 distinct tags fell in a
// frequency band wide enough to be worth an opinion; 10,173 appeared in under
// 0.2% of jobs, so rating one would have moved four postings.
//
// A closed vocabulary fixes both ends at once: boilerplate can never enter
// because nothing outside this list is ever emitted, and every entry here is
// something a person can actually hold a preference about. The cost is that a
// skill nobody listed is invisible, which is the right trade -- a missing tag is
// recoverable by editing this list, a corpus of junk tags is not.
//
// `match` is tested against the lowercased title + description. `derive` tags
// come from structured fields instead and are added in tagPosting.

const TAG_CATEGORIES = {
  work: 'Work', tech: 'Tech', domain: 'Domain', seniority: 'Seniority',
  experience: 'Experience', location: 'Location', pay: 'Pay', condition: 'Conditions',
  family: 'Role family', stage: 'Company', perk: 'Benefits', office: 'Office'
};

const w = body => new RegExp('(^|[^a-z0-9+#.])' + body + '([^a-z0-9+#]|$)', 'i');

const TAG_ONTOLOGY = [
  // --- languages -----------------------------------------------------------
  ['Python', 'tech', w('python')],
  ['JavaScript', 'tech', w('javascript')],
  ['TypeScript', 'tech', w('typescript')],
  ['Go', 'tech', /\b(golang|\bgo programming|in go\b)/i],
  ['Rust', 'tech', w('rust')],
  ['Java', 'tech', /\bjava\b(?!script)/i],
  ['Kotlin', 'tech', w('kotlin')],
  ['Swift', 'tech', w('swift')],
  // Bare \brails\b caught "payment rails", so a fintech posting claimed Ruby.
  ['Ruby', 'tech', /\bruby\b|\bon rails\b|\brails (framework|app|application|developer)\b/i],
  ['C++', 'tech', /c\+\+/i],
  ['C#/.NET', 'tech', /\bc#|\.net\b/i],
  ['Scala', 'tech', w('scala')],
  ['Elixir', 'tech', w('elixir')],
  ['PHP', 'tech', w('php')],
  ['SQL', 'tech', w('sql')],
  ['R', 'tech', /\br\b(?= programming|, python| and python)/i],
  // --- frontend ------------------------------------------------------------
  ['React', 'tech', /\breact\b/i],
  ['Vue', 'tech', /\bvue(\.js)?\b/i],
  ['Angular', 'tech', /\bangular\b/i],
  ['Svelte', 'tech', /\bsvelte\b/i],
  ['Next.js', 'tech', /\bnext\.js\b/i],
  ['CSS/Design systems', 'tech', /\b(tailwind|design system|css-in-js|styled components)\b/i],
  ['Accessibility', 'tech', /\b(accessibility|wcag|a11y)\b/i],
  ['iOS', 'tech', /\b(ios|swiftui|objective-c)\b/i],
  ['Android', 'tech', /\bandroid\b/i],
  ['React Native', 'tech', /\breact native\b/i],
  ['Flutter', 'tech', /\bflutter\b/i],
  // --- backend & data ------------------------------------------------------
  ['Node.js', 'tech', /\bnode\.?js\b/i],
  ['Django/Flask', 'tech', /\b(django|flask|fastapi)\b/i],
  ['Spring', 'tech', /\bspring boot\b|\bspring framework\b/i],
  ['GraphQL', 'tech', /\bgraphql\b/i],
  ['gRPC', 'tech', /\bgrpc\b/i],
  ['REST APIs', 'tech', /\brest(ful)? api/i],
  ['Postgres', 'tech', /\bpostgres(ql)?\b/i],
  ['MySQL', 'tech', /\bmysql\b/i],
  ['MongoDB', 'tech', /\bmongo(db)?\b/i],
  ['Redis', 'tech', /\bredis\b/i],
  ['Elasticsearch', 'tech', /\b(elasticsearch|opensearch)\b/i],
  ['Kafka', 'tech', /\bkafka\b/i],
  ['Spark', 'tech', /\b(apache )?spark\b/i],
  ['Airflow/dbt', 'tech', /\b(airflow|dbt)\b/i],
  ['Snowflake/BigQuery', 'tech', /\b(snowflake|bigquery|redshift)\b/i],
  ['Data pipelines', 'tech', /\b(data pipeline|etl|elt)\b/i],
  // --- infra ---------------------------------------------------------------
  ['Kubernetes', 'tech', /\b(kubernetes|k8s)\b/i],
  ['Docker', 'tech', /\bdocker|containeriz/i],
  ['Terraform/IaC', 'tech', /\b(terraform|infrastructure as code|pulumi)\b/i],
  ['AWS', 'tech', /\baws\b|amazon web services/i],
  ['GCP', 'tech', /\bgcp\b|google cloud/i],
  ['Azure', 'tech', /\bazure\b/i],
  ['CI/CD', 'tech', /\b(ci\/cd|continuous (integration|delivery|deployment)|github actions|jenkins)\b/i],
  ['Observability', 'tech', /\b(observability|prometheus|grafana|datadog|opentelemetry)\b/i],
  ['Linux', 'tech', /\blinux\b/i],
  ['Distributed systems', 'tech', /\bdistributed systems?\b/i],
  ['Microservices', 'tech', /\bmicroservice/i],
  ['Embedded/Firmware', 'tech', /\b(embedded|firmware|rtos|microcontroller)\b/i],
  // --- ml / ai -------------------------------------------------------------
  ['Machine learning', 'tech', /\bmachine learning\b|\bml engineer/i],
  ['Deep learning', 'tech', /\bdeep learning\b|\bneural network/i],
  ['PyTorch/TensorFlow', 'tech', /\b(pytorch|tensorflow|jax)\b/i],
  ['LLMs', 'tech', /\b(llm|large language model|generative ai|genai|foundation model)\b/i],
  ['RAG/Embeddings', 'tech', /\b(retrieval[- ]augmented|rag pipeline|vector (db|database)|embeddings)\b/i],
  ['Computer vision', 'tech', /\bcomputer vision\b|\bimage recognition\b/i],
  ['NLP', 'tech', /\bnlp\b|natural language processing/i],
  ['Recommenders/Ranking', 'tech', /\b(recommendation system|recommender|ranking system|search relevance)\b/i],
  ['Reinforcement learning', 'tech', /\breinforcement learning\b|\brlhf\b/i],
  ['MLOps', 'tech', /\bmlops\b|\bmodel deployment\b/i],
  ['Research', 'tech', /\b(research scientist|publish(ed|ing)? papers|neurips|icml|research engineer)\b/i],
  ['Statistics/Experimentation', 'tech', /\b(a\/b test|experimentation|causal inference|statistical model)/i],
  // --- security ------------------------------------------------------------
  ['Security', 'tech', /\b(security engineer|appsec|infosec|penetration test|threat model)\b/i],
  ['Cryptography', 'tech', /\bcryptograph/i],
  // --- non-engineering craft ----------------------------------------------
  ['Product management', 'tech', /\bproduct manager\b|\bproduct management\b/i],
  ['UX/Product design', 'tech', /\b(ux|user experience|product design|figma)\b/i],
  ['User research', 'tech', /\buser research\b/i],
  ['Analytics/BI', 'tech', /\b(business intelligence|tableau|looker|power bi|analytics)\b/i],
  ['Technical writing', 'tech', /\btechnical writ/i],
  ['Developer relations', 'tech', /\b(developer relations|devrel|developer advocate)\b/i],
  ['Solutions engineering', 'tech', /\b(solutions engineer|sales engineer|forward deployed)\b/i],
  // --- work type (mirrors family, kept as tags so it competes for a click) --
  ['Backend', 'work', /\b(backend|back-end|server-side)\b/i],
  ['Frontend', 'work', /\b(frontend|front-end)\b/i],
  ['Full stack', 'work', /\bfull[- ]?stack\b/i],
  ['Infra/SRE/Platform', 'work', /\b(infrastructure engineer|site reliability|sre\b|platform engineer|devops)\b/i],
  ['Mobile', 'work', /\bmobile (engineer|developer)\b/i],
  ['Data engineering', 'work', /\bdata engineer\b/i],
  ['Data science', 'work', /\bdata scientist\b|\bdata science\b/i],
  ['Sales/GTM', 'work', /\b(account executive|sales manager|business development|quota)\b/i],
  ['Marketing', 'work', /\b(marketing manager|demand generation|brand manager|content marketing)\b/i],
  ['Customer success', 'work', /\b(customer success|account manager|technical support)\b/i],
  ['Operations', 'work', /\b(operations manager|program manager|project manager|chief of staff)\b/i],
  ['Recruiting/People', 'work', /\b(recruiter|talent acquisition|people operations|hr manager)\b/i],
  ['Finance/Legal', 'work', /\b(financial analyst|controller|accountant|legal counsel|compliance officer)\b/i],
  ['Engineering management', 'work', /\b(engineering manager|head of engineering|director of engineering|vp of engineering)\b/i],
  // --- domain --------------------------------------------------------------
  ['Fintech/Payments', 'domain', /\b(fintech|payments|banking|lending|insurance|trading|financial services)\b/i],
  ['Developer tools', 'domain', /\b(developer tool|devtool|developer platform|api platform|open source)\b/i],
  ['AI labs/Frontier', 'domain', /\b(agi|frontier model|ai safety|alignment research|ai lab)\b/i],
  // Bare "healthcare" matched the benefits paragraph of every posting that
  // offers private medical cover, so unrelated companies read as healthtech.
  // The Health insurance perk tag covers that sense now.
  ['Healthcare/Bio', 'domain', /\b(health ?tech|digital health|clinical (trials?|data|workflow)|patients?\b|biotech|medical device|life sciences|pharma|ehr\b|healthcare (platform|provider|system|company|industry))\b/i],
  ['E-commerce/Retail', 'domain', /\b(e-?commerce|marketplace|retail|shopper|merchandis)/i],
  ['Gaming', 'domain', /\b(game (developer|studio|design)|gaming|unreal engine|unity engine)\b/i],
  ['Climate/Energy', 'domain', /\b(climate|renewable|clean energy|sustainability|decarbon|solar|battery)\b/i],
  ['Education', 'domain', /\b(edtech|education technology|learners|curriculum|students)\b/i],
  ['Logistics/Mobility', 'domain', /\b(logistics|supply chain|fleet|mobility|autonomous vehicle|delivery network)\b/i],
  ['Media/Creator', 'domain', /\b(streaming|media platform|creator economy|publishing|advertising platform)\b/i],
  ['B2B SaaS', 'domain', /\b(b2b saas|enterprise software|saas platform)\b/i],
  ['Security products', 'domain', /\b(cybersecurity|security platform|zero trust|siem)\b/i],
  ['Government/Defence', 'domain', /\b(government|public sector|defen[cs]e|federal agency|national security)\b/i],
  // --- conditions ----------------------------------------------------------
  ['Visa sponsorship', 'condition', /\b(visa sponsorship|sponsor(ship)? (a |an )?visa|h-?1b sponsor|relocation support|work permit)\b/i],
  ['No sponsorship', 'condition', /\b(no (visa )?sponsorship|not (able|be able) to sponsor|unable to sponsor|must be authorized to work)\b/i],
  ['Equity', 'condition', /\b(equity|stock options|rsus|share options)\b/i],
  ['Relocation', 'condition', /\brelocation (package|assistance|support)\b/i],
  ['On-call', 'condition', /\b(on-?call rotation|pager duty|24\/7 support)\b/i],
  ['Security clearance', 'condition', /\b(security clearance|ts\/sci|top secret|polygraph)\b/i],
  ['Travel required', 'condition', /\b(travel (up to|requirement)|\d{2}% travel|frequent travel)\b/i],
  ['Greenfield/0-to-1', 'condition', /\b(greenfield|zero to one|0 to 1|from scratch|ground up)\b/i],
  ['Mentorship', 'condition', /\b(mentor(ing|ship)|coach(ing)? engineers|grow the team)\b/i],
  ['Fast-paced', 'condition', /\b(fast-?paced|move quickly|high growth|scrappy)\b/i],
  ['Cross-functional', 'condition', /\bcross-?functional\b/i],
  ['Ownership/Autonomy', 'condition', /\b(ownership|autonomy|own the|end-to-end ownership)\b/i],
  ['Customer-facing', 'condition', /\b(customer-?facing|client-?facing|stakeholder management)\b/i],
  ['Shift work', 'condition', /\b(shift work|night shift|weekend shift|rotating shift)\b/i],
  ['Contract/Temp', 'condition', /\b(contract role|fixed[- ]term|temporary position|freelance|contractor)\b/i],
  ['Part-time', 'condition', /\bpart[- ]time\b/i],
  ['German required', 'condition', /\b(german (language )?(skills|required)|fließend deutsch|deutschkenntnisse|sehr gute deutsch)\b/i],
  // --- company stage and size ----------------------------------------------
  // Absent entirely before this: nothing on a card distinguished a twelve-person
  // seed startup from a listed multinational, which is one of the first things
  // anyone actually screens on.
  ['Pre-seed/Seed', 'stage', /\b(pre-?seed|seed[- ]stage|seed round|just raised our seed)\b/i],
  ['Series A/B', 'stage', /\bseries [ab]\b/i],
  ['Series C+', 'stage', /\bseries [c-g]\b|\blate[- ]stage\b|\bgrowth[- ]stage\b/i],
  ['Public company', 'stage', /\b(publicly traded|nasdaq|nyse|listed company|fortune 500|ftse)\b/i],
  ['Bootstrapped/Profitable', 'stage', /\b(bootstrapped|profitable since|no outside funding|self-funded)\b/i],
  ['Unicorn/Scaleup', 'stage', /\b(unicorn|scale-?up|hypergrowth|hyper-growth)\b/i],
  ['Tiny team (<20)', 'stage', /\b(team of (\d|1\d)\b|fewer than 20|first \d+ (engineers|employees)|small team of)\b/i],
  ['Big company (1000+)', 'stage', /\b(\d{1,3},\d{3}\+? employees|thousands of employees|global (leader|organi[sz]ation) with)\b/i],
  ['Agency/Consultancy', 'stage', /\b(consultancy|consulting firm|digital agency|client projects|staffing)\b/i],
  ['Non-profit/Public good', 'stage', /\b(non-?profit|not-for-profit|ngo|charity|public good|social impact)\b/i],

  // --- benefits -------------------------------------------------------------
  // Only Equity existed. These are the terms people actually compare offers on.
  ['4-day week', 'perk', /\b(4-day (work )?week|four-day (work )?week|32-hour week)\b/i],
  ['Unlimited PTO', 'perk', /\b(unlimited (pto|vacation|holiday|time off)|take as much (vacation|holiday))\b/i],
  ['Generous leave (30d+)', 'perk', /\b(3[0-9]|[4-9][0-9]) days?\b[^.]{0,30}\b(holiday|vacation|annual leave|pto)\b/i],
  ['Parental leave', 'perk', /\b(parental leave|maternity|paternity|family leave)\b/i],
  ['Learning budget', 'perk', /\b(learning (budget|stipend|allowance)|training budget|conference budget|professional development budget|tuition reimbursement)\b/i],
  ['Home-office stipend', 'perk', /\b(home[- ]office (stipend|budget|allowance)|remote work stipend|equipment budget|wfh stipend)\b/i],
  ['Health insurance', 'perk', /\b(health (insurance|coverage|care plan)|medical (insurance|coverage)|dental|private healthcare)\b/i],
  ['Retirement match', 'perk', /\b(401\(?k\)? match|pension (scheme|contribution)|retirement match|superannuation)\b/i],
  ['Bonus/Commission', 'perk', /\b(annual bonus|performance bonus|commission structure|ote\b|profit[- ]sharing)\b/i],
  ['Wellness/Gym', 'perk', /\b(gym (membership|stipend)|wellness (budget|stipend|programme|program)|mental health support)\b/i],
  ['Sabbatical', 'perk', /\bsabbatical\b/i],
  ['Workation/Work abroad', 'perk', /\b(work from anywhere for|workation|work abroad for|\d+ (weeks|days) from anywhere)\b/i],

  // --- what the office actually costs you -----------------------------------
  // Remote / Hybrid / On-site is a three-way split derived from the location
  // string. "Hybrid" covers everything from one day a month to four a week, and
  // that difference decides whether a job is possible at all.
  ['Remote-first', 'office', /\b(remote-?first|fully (remote|distributed)|100% remote|all-remote)\b/i],
  ['1-2 days in office', 'office', /\b((1|2|one|two) days? (a|per) week in (the )?office|(1|2|one|two) days? on-?site)\b/i],
  ['3+ days in office', 'office', /\b((3|4|5|three|four|five) days? (a|per) week in (the )?office|(3|4|5|three|four|five) days? on-?site|mostly in[- ]office)\b/i],
  ['Timezone overlap', 'office', /\b(overlap with|core hours|timezone|time zone)[^.]{0,40}\b(cet|est|pst|utc|gmt|hours)\b/i],
  ['Async-friendly', 'office', /\b(async(hronous)?[- ](first|friendly|communication)|written culture|documentation[- ]first)\b/i],
  ['Flexible hours', 'office', /\b(flexible (working )?(hours|schedule)|flexitime|flex time|set your own hours)\b/i],
  ['Relocation expected', 'office', /\b(must relocate|relocation (is )?required|willing to relocate)\b/i],

  // --- stacks the tail was missing -----------------------------------------
  ['QA/Test automation', 'tech', /\b(test automation|qa engineer|sdet|playwright|cypress|selenium|appium)\b/i],
  ['Databricks', 'tech', w('databricks')],
  ['ClickHouse/OLAP', 'tech', /\b(clickhouse|druid|pinot|olap)\b/i],
  ['Flink/Streaming', 'tech', /\b(flink|beam|stream processing|kinesis|pulsar)\b/i],
  ['DynamoDB/Cassandra', 'tech', /\b(dynamodb|cassandra|scylla)\b/i],
  ['RabbitMQ/Queues', 'tech', /\b(rabbitmq|sqs|celery|message queue|nats)\b/i],
  ['Prometheus/Grafana', 'tech', /\b(prometheus|grafana|opentelemetry|datadog|new relic)\b/i],
  ['GitHub Actions/Jenkins', 'tech', /\b(github actions|gitlab ci|jenkins|circleci|buildkite)\b/i],
  ['Ansible/Config mgmt', 'tech', /\b(ansible|puppet|chef|saltstack)\b/i],
  ['Helm/ArgoCD', 'tech', /\b(helm|argo ?cd|flux ?cd|kustomize|gitops)\b/i],
  ['Service mesh/eBPF', 'tech', /\b(istio|linkerd|envoy|ebpf|cilium)\b/i],
  ['Solidity/Web3', 'tech', /\b(solidity|smart contracts?|web3|evm|ethereum)\b/i],
  ['Unity/Unreal', 'tech', /\b(unity|unreal engine|godot|game engine)\b/i],
  ['WebGL/Three.js', 'tech', /\b(webgl|three\.js|webgpu|shaders?)\b/i],
  ['WASM', 'tech', /\b(webassembly|wasm)\b/i],
  ['Tailwind', 'tech', w('tailwind')],
  ['Figma', 'tech', w('figma')],
  ['Salesforce', 'tech', /\b(salesforce|apex|sfdc)\b/i],
  ['SAP/ERP', 'tech', /\b(sap\b|erp\b|netsuite|workday)\b/i],
  ['Tableau/Looker/PowerBI', 'tech', /\b(tableau|looker|power ?bi|metabase|superset)\b/i],
  ['Haskell/FP', 'tech', /\b(haskell|ocaml|f#|clojure|erlang|purescript)\b/i],
  ['Robotics/ROS', 'tech', /\b(robotics|\bros2?\b|slam\b|motion planning|manipulator)\b/i],
  ['Hardware/Silicon', 'tech', /\b(fpga|verilog|vhdl|asic|silicon|pcb|rtl design)\b/i],
  ['Privacy/GDPR', 'tech', /\b(gdpr|ccpa|data privacy|privacy engineering|dpo\b)\b/i],
  ['SOC2/Compliance', 'tech', /\b(soc ?2|iso ?27001|hipaa|pci[- ]dss|audit readiness)\b/i],
  ['Growth engineering', 'tech', /\b(growth engineer|a\/b testing at scale|conversion optimi[sz]ation|cro\b|seo\b)\b/i],
  ['Lifecycle/CRM', 'tech', /\b(lifecycle marketing|crm\b|hubspot|marketo|braze|customer\.io)\b/i],
  ['Data governance', 'tech', /\b(data governance|data catalog|lineage|master data|data quality framework)\b/i],
  ['Payments/Ledgers', 'tech', /\b(double[- ]entry|ledger system|payment rails|pci\b|iso ?20022|reconciliation engine)\b/i],

  // --- industries the domain lane was missing -------------------------------
  ['Crypto/Web3 industry', 'domain', /\b(crypto(currency)?|defi|blockchain company|digital assets|exchange listing)\b/i],
  ['Insurance', 'domain', /\b(insur(ance|tech)|underwriting|actuarial|claims processing)\b/i],
  ['Real estate/Proptech', 'domain', /\b(real estate|proptech|property management|mortgage)\b/i],
  ['Travel/Hospitality', 'domain', /\b(travel (tech|industry)|hospitality|airline|hotel booking|tourism)\b/i],
  ['Legal tech', 'domain', /\b(legal ?tech|contract lifecycle|e-?discovery|law firm)\b/i],
  ['HR tech', 'domain', /\b(hr ?tech|payroll platform|applicant tracking|people analytics)\b/i],
  ['Adtech/Martech', 'domain', /\b(ad ?tech|mar ?tech|programmatic|dsp\b|ssp\b|attribution)\b/i],
  ['Telecom', 'domain', /\b(telecom(munications)?|5g\b|network operator|isp\b)\b/i],
  ['Manufacturing/Industrial', 'domain', /\b(manufacturing|industrial automation|factory|plc\b|iiot)\b/i],
  ['Space/Aerospace', 'domain', /\b(aerospace|satellite|space (industry|systems)|launch vehicle|avionics)\b/i],
  ['Agritech/Food', 'domain', /\b(agri ?(tech|culture)|food ?tech|farming|crop)\b/i],
  ['Sports/Fitness', 'domain', /\b(sports (tech|betting)|fitness app|athlete)\b/i],

  // --- language requirements beyond German ----------------------------------
  ['French required', 'condition', /\b(french (language )?(skills|required|fluent)|français courant|bilingue)\b/i],
  ['Spanish required', 'condition', /\b(spanish (language )?(skills|required|fluent)|español nativo)\b/i],
  ['Dutch required', 'condition', /\b(dutch (language )?(skills|required|fluent)|nederlands)\b/i],
  ['Japanese required', 'condition', /\b(japanese (language )?(skills|required|fluent)|business level japanese)\b/i],
  ['English only', 'condition', /\b(english (is )?the (only |sole )?(working|company) language|english-only)\b/i],

  // --- conditions the lane was missing --------------------------------------
  ['Rotational/Weekend', 'condition', /\b(weekend (work|shifts)|rotational shifts|standby duty)\b/i],
  ['Take-home assignment', 'condition', /\b(take[- ]home (assignment|exercise|task)|paid trial project)\b/i],
  ['Live coding interview', 'condition', /\b(live coding|pair programming interview|whiteboard interview)\b/i],
  ['No degree required', 'condition', /\b(no degree required|degree is not required|equivalent practical experience|self-taught welcome)\b/i],
  ['Degree required', 'condition', /\b(bachelor'?s degree (is )?required|must hold a (bachelor|master)|phd required)\b/i],
  ['Startup founding role', 'condition', /\b(founding (engineer|team member|designer)|employee number \d|first (engineering )?hire)\b/i],
  ['Manager of managers', 'condition', /\b(manage(r of|rs reporting)|second[- ]line manager|managing managers)\b/i],
  ['Individual contributor', 'condition', /\b(individual contributor|ic track|no direct reports)\b/i]
];

// Experience floors are worth an opinion of their own -- "8+ years" is a
// different job from "2+ years" even when everything else matches.
function experienceTag(body) {
  const match = body.match(/(\d{1,2})\s*\+?\s*(?:-\s*\d{1,2}\s*)?(?:years?|yrs?|jahre)\b[^.]{0,40}?(?:experience|erfahrung)/i);
  if (!match) return '';
  const years = Number(match[1]);
  if (!isFinite(years) || years <= 0 || years > 25) return '';
  if (years <= 1) return '0-1 years';
  if (years <= 3) return '2-3 years';
  if (years <= 5) return '4-5 years';
  if (years <= 8) return '6-8 years';
  return '9+ years';
}

/* ------------------------------------------------------------------ tagger */


const FAMILY_RULES = [
  ['Engineering - Frontend', /\b(frontend|front-end|ui engineer|web engineer)\b/i],
  ['Engineering - Backend', /\b(backend|back-end|server-side|api engineer)\b/i],
  ['Engineering - Full stack', /\b(full[- ]?stack)\b/i],
  ['Engineering - Mobile', /\b(ios|android|mobile engineer|react native)\b/i],
  ['Engineering - Infra/SRE', /\b(infrastructure|site reliability|sre|devops|platform engineer|cloud engineer)\b/i],
  ['Engineering - Security', /\b(security engineer|appsec|infosec|security research)\b/i],
  ['Engineering - Data', /\b(data engineer|analytics engineer|data platform)\b/i],
  ['ML / AI', /\b(machine learning|ml engineer|ai engineer|research scientist|research engineer|applied scientist)\b/i],
  ['Data Science', /\b(data scientist|data science)\b/i],
  ['Product', /\b(product manager|product lead|group product)\b/i],
  ['Design', /\b(designer|design lead|ux|product design)\b/i],
  ['Sales / GTM', /\b(account executive|sales|business development|partnerships)\b/i],
  ['Marketing', /\b(marketing|growth|content|brand)\b/i],
  ['Support / Success', /\b(customer success|support engineer|solutions architect)\b/i],
  ['Operations', /\b(operations|program manager|project manager|chief of staff|strategy)\b/i],
  ['People / Recruiting', /\b(recruiter|recruiting|people ops|talent)\b/i],
  ['Finance / Legal', /\b(finance|accounting|controller|legal|counsel|compliance)\b/i],
  ['Engineering - General', /\b(software engineer|engineer|developer)\b/i]
];

const SENIORITY_RULES = [
  ['Intern', /\b(intern|internship|co-?op)\b/i],
  ['New grad', /\b(new ?grad|university grad|entry[- ]level|early career)\b/i],
  ['Staff+', /\b(staff|principal|distinguished|fellow|architect)\b/i],
  ['Leadership', /\b(director|vp|vice president|head of|chief|manager)\b/i],
  ['Senior', /\b(senior|sr\.?|lead)\b/i],
  ['Junior', /\b(junior|associate)\b/i],
  ['Mid', /.*/]
];

function classifyLocation(text) {
  const t = String(text || '').toLowerCase();
  if (/\bhybrid\b/.test(t)) return 'Hybrid';
  if (/\bremote\b/.test(t)) return 'Remote';
  if (!t.trim()) return 'Unspecified';
  return 'On-site';
}

// Region is one of the five things you rate, so a posting it cannot place is a
// posting the Location facet can never learn from or score. The first version
// knew about a dozen cities and left 57% of a European pull unclassified, which
// made the whole facet close to useless outside the US.
//
// Nordics are deliberately their own region rather than part of Europe: they
// are a distinct destination with distinct pay and immigration, and lumping
// them into "Europe" would let a Berlin rating speak for Stockholm.
//
// Matching is by explicit country and city vocabulary. There is no clever
// inference here on purpose -- a wrong region is worse than no region, because
// it teaches the facet something false.
const REGION_PATTERNS = [
  ['Remote', /\b(remote|anywhere|work from home|distributed|worldwide|global)\b/i],
  ['India', /\b(india|bengaluru|bangalore|hyderabad|pune|delhi|gurgaon|gurugram|mumbai|chennai|noida|kolkata|ahmedabad|jaipur|indore|kochi|coimbatore|nagpur|chandigarh)\b/i],
  ['Nordics', /\b(sweden|norway|denmark|finland|iceland|stockholm|gothenburg|göteborg|malmö|malmo|oslo|bergen|trondheim|copenhagen|københavn|aarhus|helsinki|espoo|tampere|reykjavik|reykjavík)\b/i],
  ['ANZ', /\b(australia|new zealand|sydney|melbourne|brisbane|perth|adelaide|canberra|auckland|wellington|christchurch|queenstown)\b/i],
  ['UK', /\b(united kingdom|u\.k\.|england|scotland|wales|northern ireland|london|manchester|birmingham|edinburgh|glasgow|bristol|leeds|cambridge|oxford|belfast|cardiff|brighton|reading)\b/i],
  ['Canada', /\b(canada|toronto|vancouver|montreal|montréal|ottawa|calgary|edmonton|waterloo|québec|quebec city|halifax|winnipeg)\b/i],
  ['US', /\b(united states|u\.s\.a?\.?|usa|new york|nyc|san francisco|bay area|seattle|austin|boston|chicago|los angeles|denver|atlanta|miami|dallas|houston|philadelphia|phoenix|portland|san diego|san jose|washington,? d\.?c\.?|remote - us|minneapolis|detroit|nashville|salt lake|pittsburgh|raleigh|charlotte|columbus|kansas city|st\.? louis|new jersey|california|texas|florida|virginia|massachusetts|illinois|colorado|georgia|arizona|oregon|utah|north carolina|pennsylvania|washington state)\b/i],
  ['Europe', /\b(germany|deutschland|france|spain|españa|italy|italia|netherlands|nederland|holland|belgium|belgië|austria|österreich|switzerland|schweiz|suisse|poland|polska|portugal|ireland|czech|czechia|hungary|romania|greece|bulgaria|croatia|slovakia|slovenia|estonia|latvia|lithuania|luxembourg|malta|cyprus|serbia|ukraine|emea|europe|eu remote|berlin|münchen|munich|hamburg|frankfurt|köln|cologne|stuttgart|düsseldorf|dusseldorf|dortmund|essen|leipzig|dresden|bremen|hannover|hanover|nuremberg|nürnberg|münster|muenster|bonn|mannheim|karlsruhe|wiesbaden|heidelberg|augsburg|bielefeld|paris|lyon|marseille|toulouse|bordeaux|lille|nantes|nice|madrid|barcelona|valencia|sevilla|bilbao|málaga|malaga|milan|milano|rome|roma|turin|torino|bologna|florence|firenze|naples|napoli|amsterdam|rotterdam|utrecht|eindhoven|the hague|den haag|brussels|bruxelles|antwerp|ghent|vienna|wien|graz|salzburg|zurich|zürich|geneva|genève|basel|lausanne|bern|warsaw|warszawa|krakow|kraków|wrocław|wroclaw|gdansk|gdańsk|poznan|poznań|lisbon|lisboa|porto|dublin|cork|prague|praha|brno|budapest|bucharest|athens|sofia|zagreb|bratislava|ljubljana|tallinn|riga|vilnius)\b/i],
  ['APAC', /\b(singapore|japan|tokyo|osaka|kyoto|south korea|korea|seoul|hong kong|taiwan|taipei|china|shanghai|beijing|shenzhen|malaysia|kuala lumpur|indonesia|jakarta|thailand|bangkok|vietnam|hanoi|ho chi minh|philippines|manila|apac)\b/i],
  ['LatAm', /\b(brazil|brasil|são paulo|sao paulo|rio de janeiro|mexico|méxico|mexico city|argentina|buenos aires|chile|santiago|colombia|bogotá|bogota|peru|lima|uruguay|montevideo|costa rica|latam)\b/i],
  ['MEA', /\b(united arab emirates|uae|dubai|abu dhabi|saudi|riyadh|qatar|doha|israel|tel aviv|egypt|cairo|south africa|cape town|johannesburg|kenya|nairobi|nigeria|lagos|turkey|türkiye|istanbul)\b/i]
];

// Remote is checked first so "Remote - Germany" reads as remote, but a posting
// that is remote AND names a country keeps the country: the country is the
// thing you would be hired into, and it is what the Location facet should learn.
function regionOf(location) {
  const text = String(location || '');
  if (!text.trim()) return '';
  for (let i = 1; i < REGION_PATTERNS.length; i++) {
    if (REGION_PATTERNS[i][1].test(text)) return REGION_PATTERNS[i][0];
  }
  if (REGION_PATTERNS[0][1].test(text)) return 'Remote';
  return '';
}

// The third residual lane. These are working conditions rather than skills:
// where the job is, what it pays, what it demands of your life. CineLens calls
// this lane moods; the shape of the signal is the same.
function conditionTags(row, body) {
  const out = new Set();
  out.add('loc:' + classifyLocation(row.location + ' ' + body.slice(0, 400)));
  if (row.remote) out.add('loc:Remote');
  const region = regionOf(row.location);
  if (region) out.add('region:' + region);
  // The pay band comes from the PPP-converted figure so every posting is banded
  // in the same unit regardless of the currency it was advertised in.
  const salary = extractSalary(row, body);
  if (salary && salary.band) out.add(salary.band);
  if (/\b(equity|stock options|rsus)\b/i.test(body)) out.add('perk:equity');
  if (/\b(visa|sponsorship|h-?1b)\b/i.test(body)) out.add('perk:visa-sponsorship');
  if (/\b(security clearance|ts\/sci|top secret)\b/i.test(body)) out.add('req:clearance');
  if (/\b(on-?call rotation|pager)\b/i.test(body)) out.add('req:on-call');
  if (row.department) out.add('dept:' + row.department.trim().slice(0, 40));
  return Array.from(out);
}

const STOPWORD_SOURCE = 'a an the and or but if then else of for for to in on at by with from as is are was were be been ' +
  'you your we our us they their this that these those will would can could should may might must have has had do does ' +
  'did not no so than such very more most other some any all each own same too it its he she his her them who whom ' +
  'what which when where why how about into over under again further once here there both few only just also team ' +
  'work working role position job opportunity company candidate candidates experience years year strong ability able ' +
  'help helping build building works new great across within using use used including include includes etc ' +
  'please apply application applicants employer equal diversity inclusive benefits salary range compensation ' +
  'looking join hiring people world every make making like well right best good ensure drive support high level';
const STOPWORDS = new Set(STOPWORD_SOURCE.split(/\s+/));

/* --------------------------------------------------------- preference model */

// You rank TAGS, not jobs.
//
// Five fixed facets ran out of road exactly as predicted: after twenty postings
// you have said "Location: 4" twenty times, and each repetition carries less
// than the last. Worse, the things that actually separate two backend jobs --
// on-call, greenfield, visa sponsorship, the domain -- were only ever learned
// indirectly, through a tag lane that needed many ratings and a lot of contrast
// before it said anything.
//
// Clicking tags in preference order fixes the economics. A star was a statement
// about ONE posting. "Remote beats Python" is a statement about every posting
// carrying either tag, so it transfers across the whole corpus the moment it is
// made. Ranking three tags on a posting that carries eight yields eighteen
// pairwise constraints from three clicks.
//
// The learner is Bradley-Terry: every constraint "a should outrank b" nudges
// u[a] up and u[b] down by how surprised the model is, so a comparison it
// already predicts teaches almost nothing and a contradiction teaches a lot.
// Same maths as Elo. Utilities are stored, retrained from the stored events, so
// a ranking can be undone and the model rebuilt exactly.

const RANK_PASSES = 24;
const RANK_LEARNING_RATE = 0.16;
const RANK_DECAY = 0.94;
const RANK_REGULARIZATION = 0.012;
// A dismissal says "none of this appeals" without saying which part, so it is
// admitted as a weak negative across the posting's tags rather than a ranking.
const DISMISS_WEIGHT = 0.25;
// And its missing opposite. There was no way to say "this one, more like this"
// without picking apart which tag earned it -- so the only whole-posting verdict
// the model could learn from was a negative one, and a shortlist of jobs worth
// applying to taught it nothing at all.
//
// Weighted above a dismissal and well below a ranking. You dismiss in bulk on
// cards you barely read; you save one you actually considered, which is worth
// more. But it still names no tag, so it cannot rival an explicit order.
const LIKE_WEIGHT = 0.4;
// A tag on almost everything cannot discriminate; a tag on almost nothing is not
// worth a click. Only tags inside this band are offered for ranking.
const TAG_BAND_MIN = 0.004;
const TAG_BAND_MAX = 0.30;

// Only the tags the card actually offered are admitted. A tag outside the
// rankable band was never on screen, so a dismissal cannot be read as an
// opinion about it.
function rankingEvents() {
  const events = [];
  Object.values(state.jobs).forEach(job => {
    const pool = (job.tags || []).filter(tagIsRankable);
    const ranking = job.ranking;
    const explicit = ranking && ((ranking.order || []).length ||
                                 (ranking.bottom || []).length ||
                                 (ranking.disliked || []).length);
    if (explicit) {
      events.push({
        order: ranking.order || [],
        bottom: ranking.bottom || [],
        disliked: ranking.disliked || [],
        pool: pool,
        weight: 1
      });
    } else if (job.dismissed) {
      events.push({ order: [], bottom: [], disliked: pool, pool: pool, weight: DISMISS_WEIGHT });
    } else if (job.liked) {
      events.push({ order: [], bottom: [], liked: pool, pool: pool, weight: LIKE_WEIGHT });
    }
  });
  return events;
}

// The anchor. Bradley-Terry only ever compares two tags, so an event that
// names no winner produces no constraint at all -- which is exactly what "not
// for me" was: it disliked every tag on the posting, leaving nothing for them
// to lose to, so the model saw zero comparisons and the click did nothing but
// hide the card. The anchor is a synthetic tag pinned at utility 0 that every
// explicit negative loses to, which is what "below neutral" has to mean when
// there is no other reference point. It is never scored or displayed.
//
// The leading `!` keeps it out of the tag namespace: every real tag comes from
// TAG_ONTOLOGY or a structured field, and none of those start with punctuation.
const BASELINE = '!baseline';

// Every constraint the event implies, as [winner, loser, weight]. Three tiers,
// best to worst: left-clicked tags in click order, then everything untouched,
// then right-clicked tags -- which are ranked from the BOTTOM, so bottom[0] is
// the worst thing on the posting. Explicit dislikes sit below all of it.
function eventPairs(event) {
  const pairs = [];
  const order = event.order || [];
  const bottom = event.bottom || [];
  const disliked = event.disliked || [];
  // Reversed, so `tail` reads best-to-worst like `order` does and the two
  // blocks can be paired up the same way.
  const tail = bottom.slice().reverse();
  const claimed = new Set(order.concat(bottom, disliked));
  const rest = (event.pool || []).filter(tag => !claimed.has(tag));
  const weight = event.weight;
  for (let i = 0; i < order.length; i++) {
    for (let j = i + 1; j < order.length; j++) pairs.push([order[i], order[j], weight]);
    rest.forEach(tag => pairs.push([order[i], tag, weight * 0.7]));
    tail.forEach(tag => pairs.push([order[i], tag, weight]));
    disliked.forEach(tag => pairs.push([order[i], tag, weight]));
  }
  for (let i = 0; i < tail.length; i++) {
    for (let j = i + 1; j < tail.length; j++) pairs.push([tail[i], tail[j], weight]);
    rest.forEach(tag => pairs.push([tag, tail[i], weight * 0.7]));
    disliked.forEach(tag => pairs.push([tail[i], tag, weight]));
  }
  rest.forEach(tag => disliked.forEach(bad => pairs.push([tag, bad, event.weight * 0.5])));
  disliked.forEach(tag => pairs.push([BASELINE, tag, weight]));
  // The mirror: a saved posting puts every tag it carries above the anchor.
  (event.liked || []).forEach(tag => pairs.push([tag, BASELINE, weight]));
  return pairs;
}

let tagUtilityCache = null;

function trainTagUtilities() {
  const events = rankingEvents();
  const utility = {};
  const pairs = [];
  events.forEach(event => eventPairs(event).forEach(pair => pairs.push(pair)));
  if (!pairs.length) return { utility: utility, pairs: 0, events: 0, tags: 0 };

  pairs.forEach(pair => {
    if (!(pair[0] in utility)) utility[pair[0]] = 0;
    if (!(pair[1] in utility)) utility[pair[1]] = 0;
  });

  let rate = RANK_LEARNING_RATE;
  for (let pass = 0; pass < RANK_PASSES; pass++) {
    pairs.forEach(pair => {
      const a = pair[0], b = pair[1], weight = pair[2];
      // P(a beats b) under the current utilities. The update is the residual,
      // so a pair the model already gets right barely moves anything.
      const probability = 1 / (1 + Math.exp(-(utility[a] - utility[b])));
      const step = rate * weight * (1 - probability);
      // The anchor never moves: it is the fixed zero the negatives are pushed
      // below. Letting it drift would make it just another tag, and the
      // residual would fall to nothing after a few passes.
      if (a !== BASELINE) utility[a] += step;
      if (b !== BASELINE) utility[b] -= step;
    });
    // Shrink toward zero so a tag seen in one lopsided comparison cannot run
    // away to an extreme the evidence does not support.
    Object.keys(utility).forEach(tag => { utility[tag] *= (1 - RANK_REGULARIZATION); });
    rate *= RANK_DECAY;
  }
  delete utility[BASELINE];
  return { utility: utility, pairs: pairs.length, events: events.length, tags: Object.keys(utility).length };
}

function tagModel() {
  if (!tagUtilityCache) tagUtilityCache = trainTagUtilities();
  return tagUtilityCache;
}

// One cache line per posting, thrown away whenever the model or the library
// changes. Everything below reads scores through jobScore, so this is the only
// place staleness could enter.
let scoreCache = new Map();

function invalidateTaste() {
  tagUtilityCache = null;
  tagFrequencyCache = null;
  scoreCache = new Map();
}

function tagUtility(tag) {
  const value = tagModel().utility[tag];
  return value === undefined ? 0 : value;
}

// Rankable tags: inside the frequency band, so a click always moves a
// meaningful number of postings and never merely restates the obvious -- except
// for the structured facets, which are always offered. See STRUCTURAL_TAGS.
function tagIsRankable(tag) {
  const freq = tagFrequency();
  const count = freq.counts.get(tag) || 0;
  if (!count) return false;
  if (STRUCTURAL_TAGS.has(tag)) return true;
  const share = count / freq.total;
  return share >= TAG_BAND_MIN && share <= TAG_BAND_MAX;
}

function tagCoverage(tag) {
  return tagFrequency().counts.get(tag) || 0;
}

// A posting scores as the mean utility of the tags it carries, which keeps a
// twenty-tag posting from beating a six-tag one on volume alone. The resume
// still contributes, fading as real rankings arrive.
function jobScore(job) {
  const hit = scoreCache.get(job.id);
  if (hit) return hit;
  const tags = (job.tags || []).filter(tagIsRankable);
  const model = tagModel();
  let out;
  if (!tags.length) out = { score: 0, known: 0, rankable: 0 };
  else {
    // Hoisted: this was recomputed per tag inside resumeTagEffect and then
    // multiplied by itself again at the call site.
    const scale = resumeEvidenceScale(model.events);
    let total = 0, known = 0;
    tags.forEach(tag => {
      const learned = tagUtility(tag);
      total += learned + resumeTagEffect(tag, model.events) * scale * 0.5;
      if (learned !== 0) known++;
    });
    out = { score: total / tags.length, known: known, rankable: tags.length };
  }
  scoreCache.set(job.id, out);
  return out;
}

// Percentile, not a predicted rating. Ranking data carries no absolute scale --
// you never said a job was "4 out of 5", only that one tag beats another -- so
// the honest reading of a score is where it sits among the postings you could
// actually be shown, and that is what the card displays.
let scoreDistribution = null;

function setScoreDistribution(scores) {
  scoreDistribution = scores.slice().sort((a, b) => a - b);
}

function scorePercentile(score) {
  if (!scoreDistribution || !scoreDistribution.length) return null;
  // Every posting scoring the same means the model has nothing to say about any
  // of them, and a percentile over a flat distribution is not a weak signal but
  // a meaningless one -- it read "better than 0% of your pool" on every card
  // before anything had been ranked. The card renders a dash for null.
  if (scoreDistribution[0] === scoreDistribution[scoreDistribution.length - 1]) return null;
  let lo = 0, hi = scoreDistribution.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (scoreDistribution[mid] < score) lo = mid + 1; else hi = mid;
  }
  return Math.round((lo / scoreDistribution.length) * 100);
}

function predictFit(job) {
  const scored = jobScore(job);
  const model = tagModel();
  const percentile = scorePercentile(scored.score);
  return {
    score: scored.score,
    matchPct: percentile === null ? null : percentile,
    knownTags: scored.known,
    rankableTags: scored.rankable,
    usable: model.pairs > 0,
    events: model.events,
    pairs: model.pairs
  };
}

function tasteStatus() {
  const model = tagModel();
  const ranked = Object.values(state.jobs).filter(hasRanking).length;
  return {
    ranked: ranked,
    events: model.events,
    pairs: model.pairs,
    tags: model.tags,
    usable: model.pairs > 0
  };
}

/* ---------------------------------------------------- shared tag statistics */

// FIVE FACETS, not one star.
//
// A film rating is one coherent thing: how much you enjoyed it. A job rating is
// not. Rating a job 2 stars because it is in the wrong city taught the old model
// that you dislike `python`, `kubernetes`, that company and that seniority --
// one number supervising three lanes, with the model left to guess which of them
// earned the mark. It guessed badly, and every muddled weight then muddied every
// later prediction.
//
// Each facet now trains only the features it can actually speak to:
//
//   role      what the work is        tag weights learned from the description
//   level     seniority and scope     family + seniority
//   company   the employer            one effect per company
//   location  where and how           remote/hybrid/onsite + region
//   salary    the pay                 the KNOWN PPP figure, as an ordered curve
//
// The last two are the reason facets beat a single star by more than they first
// appear. Salary and location are objectively known for every posting, so rating
// them does not learn a per-job weight -- it fits a preference over a value the
// library already has, and that preference then applies to all 11,000 postings
// including every one you never look at. Two salary ratings teach a threshold.
//
// Facets are optional per job: rate what you can judge, leave the rest at zero.




// Dismissals stay cheap and numerous next to a considered star, so they keep
// the reduced weight they had.
// predictFit runs once per card and every card wants the same number, so this
// is memoised with the models. Recomputing it inline made each of ~1,600 cards
// rescan the whole library -- 2.7 million iterations per render, which was 5.6
// of the 5.8 seconds a single star click used to cost.
let ratedCountCache = null;

/* --- the role facet: the residual tag model, unchanged in substance -------- */

/* --- level, company, location: shrunk means over categories --------------- */

/* --- salary: the same, then forced to never fall as pay rises ------------- */

const facetModelCache = new Map();

/* --- prediction ----------------------------------------------------------- */

/* ---------------------------------------------------- shared tag statistics */

// Ported from CineLens trainTasteModel (app.js:10861) / predictTasteFit
// (app.js:11134). Three residual lanes run INSIDE the pass loop, each fitting
// what the previous lane left behind:
//
//   tags       specific skills and phrases      lambda 2.8, lr 0.38
//   broad      family + seniority               lambda 3.5, lr 0.24, damped
//   conditions location, comp, demands          lambda 3.5, lr 0.24, damped
//
// The lane order matters and the single clamp lands after the last lane, so no
// lane is silently truncated mid-pass.

// How often a tag appears across the whole library. A tag on nearly every
// posting carries almost no personal information, so its feature value shrinks
// -- but never to zero, since a common tag can still be mildly informative.
let tagFrequencyCache = null;
function tagFrequency() {
  if (tagFrequencyCache) return tagFrequencyCache;
  const counts = new Map();
  const jobs = Object.values(state.jobs);
  jobs.forEach(job => {
    new Set(job.tags || []).forEach(tag => counts.set(tag, (counts.get(tag) || 0) + 1));
  });
  tagFrequencyCache = { counts, total: Math.max(1, jobs.length) };
  return tagFrequencyCache;
}

function tagSpecificity(tag) {
  const freq = tagFrequency();
  const share = (freq.counts.get(tag) || 1) / freq.total;
  return clamp(1 - Math.log10(1 + share * 99) , 0.18, 1);
}

// CineLens tagFeatureValue: very common tags stay available to the model but
// cannot overwhelm a personal rating signal simply by appearing everywhere.
function tagFeatureValue(tag) {
  return Math.max(0.18, tagSpecificity(tag));
}

// Presentability, CineLens-style: a tag on more than 10% of the library is
// wallpaper and is not shown as an explanation chip. It still scores -- this
// governs display only.
function tagIsPresentable(tag) {
  const freq = tagFrequency();
  if ((freq.counts.get(tag) || 0) / freq.total > 0.10) return false;
  return tag.length > 2;
}

function tagFeatureMass(tags) {
  return tags.reduce((sum, tag) => sum + tagFeatureValue(tag), 0);
}

// Length normalisation. Job descriptions vary as widely as CineLens's films vs
// shows do (a terse startup posting against a 9,000-character enterprise one),
// and without this a verbose posting simply accumulates more tags and outranks
// a better-matched terse one on volume alone.
function tagMassLengthFactor(mass, pivot) {
  const p = pivot > 0 ? pivot : TAG_MASS_PIVOT_FALLBACK;
  if (mass <= 0) return 1;
  return clamp(Math.sqrt(p / mass), 0.55, 1.6);
}

// The resume's seat: CineLens's manualTagPreferenceEffect. There the unit is a
// flat constant, because a stated tag preference competes with a rating history
// that already exists. Here the resume is the ONLY signal on day one, and at the
// flat unit it moved predictions across a 9-point spread -- true to the model
// but useless to read. So the term is scaled by how little the ratings know:
// full strength at zero ratings, decaying to the CineLens nudge as evidence
// accumulates. It never grows with more resume text, only shrinks with more
// ratings, so it cannot outrun what was actually learned.
function resumeEvidenceScale(evidenceCount) {
  if (evidenceCount <= 0) return RESUME_COLD_START_GAIN;
  const decay = MIN_RATINGS_FOR_MODEL * 4;
  return 1 + (RESUME_COLD_START_GAIN - 1) * Math.exp(-evidenceCount / decay);
}

function resumeTagEffect(tag, evidenceCount) {
  const weight = Number(state.settings.resumeTags[tag] || 0);
  if (!weight) return 0;
  return clamp(weight, -4, 4) * TASTE_MODEL_RESUME_UNIT * resumeEvidenceScale(evidenceCount);
}

/* ------------------------------------------------------------------ resume */

// Minimal dependency-free PDF text extraction: pull the text-showing operators
// out of each content stream, inflating FlateDecode streams with the browser's
// own DecompressionStream. It handles ordinary text-layer PDFs, which is what a
// resume is. Scanned or heavily-subset PDFs will come back short or empty, and
// the caller says so rather than pretending it worked.
async function pdfToText(buffer) {
  const bytes = new Uint8Array(buffer);
  const latin = new TextDecoder('latin1').decode(bytes);
  const chunks = [];
  const streamRe = /stream\r?\n/g;
  let match;
  while ((match = streamRe.exec(latin))) {
    const start = match.index + match[0].length;
    const end = latin.indexOf('endstream', start);
    if (end === -1) continue;
    let data = bytes.subarray(start, end);
    const header = latin.slice(Math.max(0, match.index - 400), match.index);
    if (/FlateDecode/.test(header)) {
      try {
        const ds = new DecompressionStream('deflate');
        const stream = new Blob([data]).stream().pipeThrough(ds);
        data = new Uint8Array(await new Response(stream).arrayBuffer());
      } catch (err) { continue; }
    }
    chunks.push(new TextDecoder('latin1').decode(data));
  }
  const out = [];
  chunks.join('\n').replace(/\((?:\\.|[^()\\])*\)/g, literal => {
    out.push(literal.slice(1, -1).replace(/\\([()\\])/g, '$1'));
    return literal;
  });
  return out.join(' ').replace(/\s+/g, ' ').trim();
}

async function readResumeFile(file) {
  const name = (file.name || '').toLowerCase();
  if (name.endsWith('.pdf')) {
    const text = await pdfToText(await file.arrayBuffer());
    if (text.length < 120) {
      throw new Error('That PDF has no readable text layer (likely a scan). Paste the text instead.');
    }
    return text;
  }
  return file.text();
}

/* ----------------------------------------------------------------- refresh */

function setProgress(done, total, label) {
  const wrap = $('#progress');
  wrap.hidden = false;
  wrap.querySelector('.bar i').style.width = total ? (done / total * 100) + '%' : '0%';
  $('#progressText').textContent = label;
}

async function refreshPostings() {
  refreshAbort = false;
  $('#btnRefresh').disabled = true;
  $('#btnStop').hidden = false;
  const total = registry.length;
  let done = 0, added = 0, updated = 0;
  const failures = [];
  const queue = registry.slice();

  async function worker() {
    while (queue.length && !refreshAbort) {
      const entry = queue.shift();
      try {
        const rows = await fetchCompany(entry);
        const records = rows.map(tagPosting).map(record => {
          const existing = state.jobs[record.id];
          if (!existing) { added++; return record; }
          updated++;
          // Ratings and anything else the user set are theirs; a refresh
          // re-tags the posting but never overwrites what he decided about it.
          return Object.assign(record, {
            ranking: existing.ranking,
            ratedAt: existing.ratedAt,
            hidden: existing.hidden,
            liked: existing.liked,
            dismissed: existing.dismissed,
            firstSeen: existing.firstSeen
          });
        });
        records.forEach(r => { state.jobs[r.id] = r; });
        await saveJobs(records);
      } catch (err) {
        failures.push(entry.company + ': ' + err.message);
      }
      done++;
      setProgress(done, total, done + ' / ' + total + ' companies  ·  ' + added + ' new');
    }
  }

  await Promise.all(Array.from({ length: REFRESH_CONCURRENCY }, worker));
  state.meta.lastRefresh = new Date().toISOString();
  await saveMeta();
  invalidateTaste();
  repinOrder();
  $('#btnRefresh').disabled = false;
  $('#btnStop').hidden = true;
  setProgress(total, total,
    added + ' new, ' + updated + ' updated' + (failures.length ? '  ·  ' + failures.length + ' failed' : ''));
  if (failures.length) console.warn('JobLens refresh failures:', failures);
  setTimeout(() => { $('#progress').hidden = true; }, 6000);
  render();
}

/* ----------------------------------------------------------------- filters */

function daysAgo(iso) {
  if (!iso) return Infinity;
  const t = Date.parse(iso);
  return isNaN(t) ? Infinity : (Date.now() - t) / 86400000;
}

function relativeAge(iso) {
  const d = daysAgo(iso);
  if (!isFinite(d)) return 'undated';
  if (d < 1) return 'today';
  if (d < 2) return 'yesterday';
  if (d < 30) return Math.floor(d) + 'd ago';
  if (d < 365) return Math.floor(d / 30) + 'mo ago';
  return Math.floor(d / 365) + 'y ago';
}

// `context` is 'browse' (default) or 'rated'. The salary and hidden rules are
// DISCOVERY rules: they decide what gets put in front of you. They must not
// retroactively hide a posting you already rated -- a decision you made is
// yours to see, whether or not it stated a salary.
function passesFilters(job, context) {
  const f = state.filters;
  const rated = context === 'rated';
  if (job.hidden && !rated) return false;
  if (f.seniority && job.seniority !== f.seniority) return false;
  if (f.location && job.locationClass !== f.location) return false;
  if (f.age && daysAgo(job.postedAt) > f.age) return false;
  if (f.salary && !rated) {
    if (!job.salary) return false;
    if (f.salary !== 'has') {
      // Compared on the TOP of the range: a posting advertising 30-50L clears a
      // 40L floor, because that is the number you would be negotiating toward.
      if (job.salary.pppMax < Number(f.salary) * 100000) return false;
    }
  }
  if (f.text) {
    const needle = f.text.toLowerCase();
    const hay = (job.title + ' ' + job.company + ' ' + job.location + ' ' + (job.tags || []).join(' ')).toLowerCase();
    if (hay.indexOf(needle) === -1) return false;
  }
  return true;
}

// Every tag on a posting comes from the closed ontology or from a structured
// field. Nothing is mined from prose, so boilerplate cannot become a tag.
function ontologyTags(haystack) {
  const out = [];
  for (let i = 0; i < TAG_ONTOLOGY.length; i++) {
    if (TAG_ONTOLOGY[i][2].test(haystack)) out.push(TAG_ONTOLOGY[i][0]);
  }
  return out;
}

const TAG_CATEGORY_OF = (() => {
  const map = {};
  TAG_ONTOLOGY.forEach(entry => { map[entry[0]] = entry[1]; });
  return map;
})();

function tagCategory(tag) {
  if (TAG_CATEGORY_OF[tag]) return TAG_CATEGORY_OF[tag];
  if (/^(Remote|Hybrid|On-site)$/.test(tag)) return 'location';
  if (/^(US|UK|Europe|Nordics|ANZ|India|APAC|Canada|LatAm|MEA)$/.test(tag)) return 'location';
  if (/PPP$/.test(tag)) return 'pay';
  if (/years$/.test(tag)) return 'experience';
  if (FAMILY_NAMES.indexOf(tag) !== -1 || tag === 'Other') return 'family';
  return 'seniority';
}

function tagPosting(row) {
  const body = row.body || '';
  const haystack = (row.title + ' ' + body).toLowerCase();
  const salary = extractSalary(row, body);
  const locationClass = classifyLocation(row.location + ' ' + body.slice(0, 400));
  const region = regionOf(row.location);
  const seniorityRule = SENIORITY_RULES.find(r => r[1].test(row.title));
  const seniority = seniorityRule ? seniorityRule[0] : 'Mid';
  const familyRule = FAMILY_RULES.find(r => r[1].test(row.title)) ||
                     FAMILY_RULES.find(r => r[1].test(haystack));

  // Location, pay and seniority are tags like any other now, so they compete
  // for a click against Kubernetes and Greenfield instead of sitting in their
  // own permanent slots. That is the whole point of the change: you rank what
  // matters on THIS posting, not the same five dimensions forever.
  const family = familyRule ? familyRule[0] : 'Other';
  const derived = [locationClass, seniority, family];
  if (region) derived.push(region);
  if (salary && salary.band) derived.push(salary.band);
  const years = experienceTag(body);
  if (years) derived.push(years);

  const tags = Array.from(new Set(ontologyTags(haystack).concat(derived)));
  return {
    id: row.entry.ats + ':' + row.entry.slug + ':' + row.key,
    company: row.company || row.entry.company,
    ats: row.entry.ats,
    title: row.title || '(untitled)',
    url: row.url || '',
    location: row.location || '',
    locationClass: locationClass,
    region: region,
    postedAt: row.postedAt || '',
    family: family,
    seniority: seniority,
    salary: salary,
    tags: tags,
    excerpt: body.slice(0, 320),
    bodyChars: body.length,
    ranking: null,
    ratedAt: '',
    liked: false,
    dismissed: false,
    hidden: false,
    firstSeen: new Date().toISOString()
  };
}

function hasRanking(job) {
  if (job.liked) return true;
  const ranking = job.ranking;
  if (!ranking) return false;
  return !!((ranking.order || []).length || (ranking.bottom || []).length ||
            (ranking.disliked || []).length);
}

function rankedJobs() {
  return Object.values(state.jobs).filter(job => hasRanking(job) || job.dismissed || job.liked);
}

/* --------------------------------------------------------------- rendering */

// Rank order is shown as a number on the chip, so the click that produced it is
// visible and correctable. A left-ranked chip carries its position counted from
// the top; a right-ranked one carries a downward position counted from the
// bottom. The two are drawn as separate number lines rather than merged into
// one, because the middle of the card is deliberately left unranked.
function tagChipsHtml(job) {
  const ranking = job.ranking || { order: [], bottom: [], disliked: [] };
  const order = ranking.order || [];
  const bottom = ranking.bottom || [];
  const disliked = ranking.disliked || [];
  const rankable = (job.tags || []).filter(tagIsRankable);
  if (!rankable.length) return '<div class="tagline muted">No rankable tags on this posting.</div>';
  const model = tagModel();
  const chips = rankable.map(tag => {
    const rank = order.indexOf(tag);
    const low = bottom.indexOf(tag);
    const bad = disliked.indexOf(tag) !== -1;
    const utility = tagUtility(tag);
    const lean = utility > 0.05 ? ' lean-up' : utility < -0.05 ? ' lean-down' : '';
    const cls = rank !== -1 ? 'chip ranked' : low !== -1 ? 'chip bottom'
      : bad ? 'chip disliked' : 'chip' + lean;
    const title = tag + ' — on ' + tagCoverage(tag).toLocaleString() + ' postings' +
      (model.pairs ? ', learned score ' + utility.toFixed(2) : '') +
      (low !== -1 ? '  ·  ranked ' + (low + 1) + ' from the bottom; right-click again to unset'
        : rank !== -1 ? '  ·  right-click to rank it from the bottom instead'
        : '  ·  left-click ranks from the top, right-click from the bottom');
    // No third gesture. The middot that used to sit inside every chip was a
    // per-tag "never want this", which is a real distinction from right-click's
    // "worst thing on THIS posting" -- but three targets on one 80px chip, one
    // of them a bare dot, read as a stray dash rather than a control. The
    // whole-posting verdicts are the two buttons in the footer instead.
    // ranking.disliked stays in the model: dismissals fill it, and stored
    // records from v2-v5 still carry it, so the ✕ still renders.
    return '<button class="' + cls + '" data-tag="' + esc(tag) + '" data-job="' + esc(job.id) + '" ' +
      'title="' + esc(title) + '">' +
      (rank !== -1 ? '<b>' + (rank + 1) + '</b> '
        : low !== -1 ? '<b class="low">↓' + (low + 1) + '</b> '
        : bad ? '<b class="low">✕</b> ' : '') + esc(tag) + '</button>';
  }).join('');
  return '<div class="tagline">' + chips + '</div>';
}

function cardHtml(job, fit, alsoIn) {
  const pct = fit.matchPct;
  const cls = pct === null ? 'lo' : pct >= 80 ? 'hi' : pct >= 50 ? 'mid' : 'lo';
  const why = !fit.usable
    ? 'rank a few tags to start'
    : fit.knownTags + ' of ' + fit.rankableTags + ' tags learned';
  const ranking = job.ranking || { order: [], bottom: [], disliked: [] };
  const done = (ranking.order || []).length + (ranking.bottom || []).length +
               (ranking.disliked || []).length;
  const verdict = job.liked ? ' liked' : job.dismissed ? ' dismissed' : '';
  return '<article class="card' + verdict + '" data-card="' + esc(job.id) + '">' +
    '<h3><a href="' + esc(job.url) + '" target="_blank" rel="noopener">' + esc(job.title) + '</a></h3>' +
    '<div class="meta"><strong>' + esc(job.company) + '</strong>' +
      '<span class="dot">' + esc(job.location || job.locationClass) +
        (alsoIn ? ' +' + alsoIn + ' more' : '') + '</span>' +
      '<span class="dot">' + esc(relativeAge(job.postedAt)) + '</span></div>' +
    salaryHtml(job) +
    '<div class="fit"><span class="fitPct ' + cls + '">' +
      (pct === null ? '—' : pct + '<small>%</small>') + '</span>' +
      '<span class="fitWhy">' + (pct === null ? 'not ranked yet' : 'better than ' + pct + '% of your pool') +
      '<br>' + esc(why) + '</span></div>' +
    tagChipsHtml(job) +
    '<div class="cardFoot">' +
      '<span class="muted">' + (job.liked ? 'saved — counts for all its tags'
        : job.dismissed ? 'dismissed'
        : done ? done + ' ranked'
        : 'left-click tags best-first, right-click worst-first') + '</span>' +
      (job.dismissed || job.liked
        ? '<button data-restore="' + esc(job.id) + '">undo</button>'
        : (done ? '<button data-clear="' + esc(job.id) + '">clear</button>' : '') +
          '<button class="yes" data-like="' + esc(job.id) + '" title="Weak positive on all its ' +
            'tags at ' + LIKE_WEIGHT + ' weight, and keeps it as a shortlist entry in Rated">' +
            'more like this</button>' +
          '<button data-hide="' + esc(job.id) + '" title="Weak negative on all its tags at ' +
            DISMISS_WEIGHT + ' weight, and hides it">not for me</button>') +
    '</div></article>';
}

// The distribution has to span the whole candidate pool, because the card shows
// a percentile within it -- so every posting is scored even though only ~120 are
// drawn. jobScore is memoised, so the predictFit pass below is a cache hit each
// time rather than a second full scoring of the corpus.
function scoredList(jobs) {
  const entries = jobs.map(job => ({ job: job, fit: null }));
  setScoreDistribution(entries.map(entry => jobScore(entry.job).score));
  entries.forEach(entry => { entry.fit = predictFit(entry.job); });
  return entries;
}


// A company posts one role across many cities as separate ATS entries with
// separate ids, so an unfiltered For You fills its first screen with four copies
// of the same job. They are collapsed to the best-scoring one, which carries the
// count so the other locations are visible rather than discarded. Only the
// SURFACED lists collapse -- Pool and Rated show every record, and nothing is
// dropped from storage, because each posting is a real distinct application URL.
function collapseDuplicates(entries) {
  const best = new Map();
  entries.forEach(entry => {
    const key = entry.job.company + '|' + entry.job.title.toLowerCase().replace(/\s+/g, ' ').trim();
    const held = best.get(key);
    if (!held) { entry.alsoIn = 0; best.set(key, entry); return; }
    const winner = entry.fit.predicted > held.fit.predicted ? entry : held;
    const loser = winner === entry ? held : entry;
    winner.alsoIn = (held.alsoIn || 0) + 1;
    winner.alsoLocations = (held.alsoLocations || [held.job.location]).concat([loser.job.location]);
    best.set(key, winner);
  });
  return Array.from(best.values());
}

// The surfaced ORDER is pinned; the scores on it are not.
//
// Order has to be pinned because a ranked posting leaves the For You candidate
// pool the moment it is ranked -- so a re-sort on every click would pull the
// card out from under the cursor mid-ranking, and the next click would land on
// a different job. That was true with five facets and is still true now.
//
// What was wrong was freezing the NUMBERS along with the order. Only the clicked
// card was redrawn, so every other percentage on screen kept describing a model
// two or ten rankings out of date, with nothing to say so. Now a ranking
// schedules a full re-render (see scheduleRescore): same order, every visible
// percentage recomputed. Positions hold, values move.
//
// `pinnedDrift` counts how far the pinned order has fallen behind the scores, so
// the view can offer a re-sort instead of silently deciding for the user.
// Dismissed and hidden postings are dropped from the pin, because "not for me"
// is an explicit request to remove the card.
let pinnedOrder = { key: '', ids: [] };
let pinnedDrift = 0;

function viewKey() {
  const f = state.filters;
  return [state.view, f.text, f.seniority, f.location, f.age, f.salary].join('|');
}

function repinOrder() {
  pinnedOrder = { key: '', ids: [] };
  pinnedDrift = 0;
  // A rescore still in flight would land on the list a moment after it was
  // re-sorted or refiltered and quietly undo it.
  if (rescoreTimer) { clearTimeout(rescoreTimer); rescoreTimer = null; }
}

function pinnedList(entries) {
  const key = viewKey();
  const byId = new Map(entries.map(entry => [entry.job.id, entry]));
  if (pinnedOrder.key === key && pinnedOrder.ids.length) {
    const kept = [];
    pinnedOrder.ids.forEach(id => {
      const job = state.jobs[id];
      if (!job || job.hidden) return;
      const entry = byId.get(id) || { job: job, fit: predictFit(job) };
      kept.push(entry);
    });
    // `entries` arrives already sorted the way the view wants it, so the two
    // sequences differ exactly where the pin has gone stale. Cards absent from
    // the fresh list (just ranked, so out of the candidate pool) are skipped:
    // they are being held in place deliberately and are not drift.
    const fresh = entries.map(entry => entry.job.id).filter(id => {
      const job = state.jobs[id];
      return job && !job.hidden;
    });
    const held = kept.map(entry => entry.job.id).filter(id => byId.has(id));
    pinnedDrift = held.reduce((n, id, i) => n + (fresh[i] === id ? 0 : 1), 0);
    return kept;
  }
  pinnedOrder = { key: key, ids: entries.map(entry => entry.job.id) };
  pinnedDrift = 0;
  return entries;
}

// Offered rather than applied. The order is deliberately stable while you are
// ranking, so the re-sort is a thing you ask for -- but it has to be visible,
// because a list silently sorted two rankings ago looks exactly like a list
// that disagrees with you.
function resortHtml() {
  if (!pinnedDrift) return '';
  return ' <button class="resort" data-repin="1">re-sort \u2014 ' + pinnedDrift +
    ' card' + (pinnedDrift === 1 ? '' : 's') + ' moved</button>';
}

// Hard ceiling on what is ever put in the DOM at once. Each view slices to its
// own limit already; this is the backstop for the case where a stale pinned
// order hands back the whole candidate set, which once produced a 6.9MB grid.
const RENDER_CEILING = 200;

function renderGrid(entries, emptyMessage) {
  if (!entries.length) return '<div class="empty">' + esc(emptyMessage) + '</div>';
  if (entries.length > RENDER_CEILING) entries = entries.slice(0, RENDER_CEILING);
  return '<div class="grid">' + entries.map(e =>
    cardHtml(e.job, e.fit, e.alsoIn).replace('<article class="card"',
      '<article class="card" data-also-in="' + (e.alsoIn || 0) + '"')).join('') + '</div>';
}

// The resume seeds tag utilities before any ranking exists, using the same
// closed ontology, so what it produces is directly comparable with what you
// rank later rather than living in a separate vocabulary.
function resumeToTagWeights(text) {
  const haystack = String(text || '').toLowerCase();
  if (!haystack.trim()) return {};
  const weights = {};
  ontologyTags(haystack).forEach(tag => { weights[tag] = 1; });
  const years = experienceTag(haystack);
  if (years) weights[years] = 1;
  return weights;
}

function viewForYou() {
  const candidates = Object.values(state.jobs).filter(j => !hasRanking(j) && !j.hidden && passesFilters(j));
  if (!candidates.length) {
    return '<div class="empty">Nothing matches these filters. Loosen one, or refresh postings.</div>';
  }
  const scored = scoredList(candidates);
  const status = tasteStatus();
  if (!status.usable) {
    const byDate = pinnedList(collapseDuplicates(scored)
      .sort((a, b) => daysAgo(a.job.postedAt) - daysAgo(b.job.postedAt)));
    return '<p class="notice"><b>Nothing ranked yet — newest first.</b> On any card, ' +
      '<b>left-click</b> tags best-first; <b>right-click</b> ranks from the worst end. Every click is ' +
      'a comparison that applies to all ' + Object.keys(state.jobs).length.toLocaleString() +
      ' postings, not just that one.</p>' + renderGrid(byDate.slice(0, 120), '');
  }
  const ranked = pinnedList(collapseDuplicates(scored)
    .sort((a, b) => b.fit.score - a.fit.score ||
                    b.fit.knownTags - a.fit.knownTags ||
                    a.job.title.localeCompare(b.job.title)));
  return '<p class="notice">Ranked from ' + status.pairs.toLocaleString() + ' comparisons over ' +
    status.tags + ' tags. <span class="muted">% is position in this pool, not a rating.</span>' +
    resortHtml() + '</p>' + renderGrid(ranked.slice(0, 120), '');
}

// The postings that would teach the most: those carrying rankable tags the
// model has never seen a comparison for. Ranking a posting made entirely of
// tags it already understands confirms what it knows and adds nothing.
function viewRate() {
  const candidates = Object.values(state.jobs).filter(j => !hasRanking(j) && !j.hidden && passesFilters(j));
  if (!candidates.length) return '<div class="empty">Nothing to rank under these filters.</div>';
  const scored = scoredList(candidates);
  const model = tagModel();
  scored.forEach(entry => {
    const tags = (entry.job.tags || []).filter(tagIsRankable);
    const unseen = tags.filter(tag => !(tag in model.utility)).length;
    entry.novelty = unseen + Math.min(tags.length, 12) * 0.1;
  });
  const unique = collapseDuplicates(scored).sort((a, b) => b.novelty - a.novelty);
  const perFamily = new Map();
  const spread = [];
  unique.forEach(entry => {
    const n = perFamily.get(entry.job.family) || 0;
    if (n >= 3) return;
    perFamily.set(entry.job.family, n + 1);
    spread.push(entry);
  });
  const pinned = pinnedList(spread.slice(0, 30));
  return '<p class="notice">These carry the most tags never yet compared, so they teach the most. ' +
    '<span class="muted">Left-click best-first, right-click worst-first, <b>·</b> marks a tag you ' +
    'never want.</span>' + resortHtml() + '</p>' + renderGrid(pinned, 'Nothing left to rank here.');
}

function viewRated() {
  const entries = scoredList(rankedJobs().filter(job => passesFilters(job, 'rated')))
    .sort((a, b) => (b.job.ratedAt || '').localeCompare(a.job.ratedAt || ''));
  const dismissed = entries.filter(e => e.job.dismissed).length;
  const liked = entries.filter(e => e.job.liked).length;
  return '<p class="notice">Everything you have ranked — change anything here and the model ' +
    'retrains from scratch.' +
    (liked ? ' <b>' + liked + ' saved</b> with “more like this” — your shortlist, weak positive at ' +
      LIKE_WEIGHT + ' across all their tags.' : '') +
    (dismissed ? ' <span class="muted">' + dismissed +
      ' dismissed with “not for me” (weak negative at ' + DISMISS_WEIGHT +
      ').</span>' : '') + '</p>' +
    renderGrid(entries, 'Nothing ranked yet.');
}

function viewPool() {
  const entries = scoredList(Object.values(state.jobs).filter(passesFilters))
    .sort((a, b) => daysAgo(a.job.postedAt) - daysAgo(b.job.postedAt));
  return renderGrid(entries.slice(0, 200), 'Pool is empty — hit Refresh postings.');
}

// The audit. Every tag the model has an opinion about, what that opinion is,
// and how many postings it moves -- so a wrong weight is visible rather than
// buried in a percentage.
function viewTagBrain() {
  const model = tagModel();
  const status = tasteStatus();
  if (!status.usable) {
    return '<div class="empty">Nothing learned yet. Rank tags on a few postings and every ' +
      'comparison shows up here.</div>';
  }
  const rows = Object.keys(model.utility)
    .map(tag => [tag, model.utility[tag], tagCoverage(tag), tagCategory(tag)])
    .filter(row => row[2] > 0)
    .sort((a, b) => b[1] - a[1]);
  const table = list => '<table class="brain"><tr><th>tag</th><th>category</th>' +
    '<th>score</th><th>postings</th></tr>' + list.map(row =>
      '<tr><td>' + esc(row[0]) + '</td><td class="muted">' + esc(TAG_CATEGORIES[row[3]] || row[3]) +
      '</td><td class="w ' + (row[1] > 0 ? 'pos' : 'neg') + '">' + (row[1] > 0 ? '+' : '') +
      row[1].toFixed(2) + '</td><td class="w">' + row[2].toLocaleString() + '</td></tr>').join('') +
    '</table>';
  const wanted = rows.filter(row => row[1] > 0.02);
  const unwanted = rows.filter(row => row[1] < -0.02).reverse();
  return '<p class="muted">' + status.pairs.toLocaleString() + ' comparisons from ' + status.events +
    ' posting' + (status.events === 1 ? '' : 's') + ', over ' + status.tags + ' tags. A score is ' +
    'relative: it only means this tag beat or lost to others you ranked.</p>' +
    (wanted.length ? '<h3>What you want</h3>' + table(wanted.slice(0, 40)) : '') +
    (unwanted.length ? '<h3>What you do not</h3>' + table(unwanted.slice(0, 25)) : '');
}

/* ------------------------------------------------------------------ ranking */

function ensureRanking(job) {
  if (!job.ranking) job.ranking = { order: [], bottom: [], disliked: [] };
  if (!job.ranking.order) job.ranking.order = [];
  if (!job.ranking.bottom) job.ranking.bottom = [];
  if (!job.ranking.disliked) job.ranking.disliked = [];
  return job.ranking;
}

// Two orders per posting, filled from opposite ends.
//
// Left-click appends to `order`, so the first left-click is the best thing on
// the card. Right-click appends to `bottom`, so the first right-click is the
// WORST thing on the card and the second is the next-worst -- the mirror of the
// left-hand gesture, not a different kind of opinion. Naming the two tags you
// would refuse is often much easier than ordering the eight you would accept,
// and it yields the same pairwise constraints either way.
//
// Clicking a chip with the button that ranked it removes it. Clicking with the
// other button moves it across, because holding a tag in both orders at once
// would assert that it beats itself.
async function rankTag(jobId, tag, fromBottom) {
  const job = state.jobs[jobId];
  if (!job) return;
  const ranking = ensureRanking(job);
  const lane = fromBottom ? ranking.bottom : ranking.order;
  const other = fromBottom ? ranking.order : ranking.bottom;
  const at = lane.indexOf(tag);
  if (at !== -1) lane.splice(at, 1);
  else {
    lane.push(tag);
    const across = other.indexOf(tag);
    if (across !== -1) other.splice(across, 1);
    const bad = ranking.disliked.indexOf(tag);
    if (bad !== -1) ranking.disliked.splice(bad, 1);
  }
  job.ratedAt = new Date().toISOString();
  job.dismissed = false;
  job.hidden = false;
  invalidateTaste();
  if (!refreshCard(jobId)) render();
  renderHeadline();
  scheduleRescore();
  await saveJobs([job]);
}


async function clearRanking(id) {
  const job = state.jobs[id];
  if (!job) return;
  job.ranking = { order: [], bottom: [], disliked: [] };
  job.ratedAt = '';
  job.dismissed = false;
  job.liked = false;
  job.hidden = false;
  invalidateTaste();
  if (!refreshCard(id)) render();
  renderHeadline();
  scheduleRescore();
  await saveJobs([job]);
}

// "Not for me" says none of this appealed, without saying which part. It is
// admitted as a weak negative over the whole posting rather than a ranking,
// because guessing which tag was the problem is exactly the attribution error
// the old single-star model made.
async function dismissJob(id) {
  const job = state.jobs[id];
  if (!job) return;
  job.dismissed = true;
  job.liked = false;
  job.hidden = true;
  job.ratedAt = new Date().toISOString();
  invalidateTaste();
  render();
  await saveJobs([job]);
}

// The opposite verdict, and the same refusal to guess: every tag on the posting
// moves up together. Unlike a dismissal it does NOT hide the card -- the whole
// point is to keep it, so Rated doubles as the shortlist of jobs worth applying
// to. It leaves the For You candidate pool the way a ranked posting does.
async function likeJob(id) {
  const job = state.jobs[id];
  if (!job) return;
  job.liked = true;
  job.dismissed = false;
  job.hidden = false;
  job.ratedAt = new Date().toISOString();
  invalidateTaste();
  if (!refreshCard(id)) render();
  renderHeadline();
  scheduleRescore();
  await saveJobs([job]);
}

async function restoreJob(id) {
  const job = state.jobs[id];
  if (!job) return;
  job.dismissed = false;
  job.liked = false;
  job.hidden = false;
  job.ranking = { order: [], bottom: [], disliked: [] };
  job.ratedAt = '';
  invalidateTaste();
  render();
  await saveJobs([job]);
}

const VIEWS = { foryou: viewForYou, rate: viewRate, rated: viewRated, pool: viewPool, tags: viewTagBrain };

function fillSelect(sel, values, current, allLabel) {
  sel.innerHTML = '<option value="">' + allLabel + '</option>' +
    values.map(v => '<option' + (v === current ? ' selected' : '') + '>' + esc(v) + '</option>').join('');
}

// Rebuilt whenever the library changes size, not on every render: the uniq
// sweep is four passes over every posting, and at 11k postings that is not
// something to repeat on each star click. fillSelect re-selects the value held
// in state.filters, so a rebuild never silently drops the user's current
// choice. Built once at init the selects stay empty forever, since init runs
// before the first refresh has fetched anything.
let deckSignature = '';

// Seniority is a LADDER. Sorting it alphabetically puts Intern between Data and
// Junior and reads as nonsense; the only useful order is the career one, so it
// is stated here rather than derived. SENIORITY_RULES is already in this order
// apart from Staff+/Leadership sitting early for match precedence, so the
// display order is written out separately.
const SENIORITY_ORDER = ['Intern', 'New grad', 'Junior', 'Mid', 'Senior', 'Staff+', 'Leadership'];

// The structured facets -- role family, level, location mode, region, pay band,
// experience floor -- are exempt from the frequency band.
//
// They were being emitted as tags and then silently dropped again: `Mid` sits on
// 48% of postings and `On-site` on 86%, so the 30% ceiling threw both away, and
// with them every level and location chip on the card. The ceiling is the right
// rule for a skill tag (a tag on everything cannot separate two postings) but
// the wrong one here, because these are the dimensions a person actually opens a
// job board to filter on. Ranking `Remote` above `₹60L-1Cr PPP` is a statement
// worth making even when four postings in five are on-site.
//
// `Unspecified` and `Other` stay excluded: they are the absence of a fact, not a
// fact, so there is nothing to hold a preference about.
const FAMILY_NAMES = FAMILY_RULES.map(rule => rule[0]);
const PAY_BANDS = ['under ₹25L PPP', '₹25–40L PPP', '₹40–60L PPP',
  '₹60L–1Cr PPP', '₹1–1.5Cr PPP', '₹1.5Cr+ PPP'];
const EXPERIENCE_BANDS = ['0-1 years', '2-3 years', '4-5 years', '6-8 years', '9+ years'];
const LOCATION_MODES = ['Remote', 'Hybrid', 'On-site'];
const STRUCTURAL_TAGS = new Set(
  FAMILY_NAMES.concat(SENIORITY_ORDER, PAY_BANDS, EXPERIENCE_BANDS, LOCATION_MODES,
    REGION_PATTERNS.map(entry => entry[0])));

function renderDeck(force) {
  const jobs = Object.values(state.jobs);
  const signature = jobs.length + ':' + Object.keys(state.jobs).length;
  if (!force && signature === deckSignature) return;
  deckSignature = signature;
  const uniq = key => Array.from(new Set(jobs.map(j => j[key]).filter(Boolean))).sort();
  const present = new Set(jobs.map(job => job.seniority));
  const levels = SENIORITY_ORDER.filter(level => present.has(level))
    .concat(Array.from(present).filter(level => SENIORITY_ORDER.indexOf(level) === -1).sort());
  fillSelect($('#fSeniority'), levels, state.filters.seniority, 'All levels');
  fillSelect($('#fLocation'), uniq('locationClass'), state.filters.location, 'Anywhere');
}

// What is actually filtering the list, named, with each one its own undo. The
// filter row can be folded away, so the state it holds has to be legible from
// the bar itself -- and even unfolded, five selects gave no answer to "why am I
// only seeing 8,000 of 16,000 postings" without inspecting every one.
const FILTER_LABELS = {
  text: 'Search', seniority: 'Level', location: 'Location',
  salary: 'Salary', age: 'Posted'
};
// What "off" is for each control. Note salary: '' is Any, i.e. no filtering at
// all -- 'has' is merely the value it SHIPS with, which is a different thing.
// Comparing against the shipped value instead of against off listed Any as an
// active filter, so a pill appeared that could not be removed: clearing it set
// salary to '' and '' was what it already was.
const FILTER_OFF = { text: '', seniority: '', location: '', salary: '', age: 0 };

function filterValueText(key, value) {
  if (key === 'age') return value + 'd';
  if (key === 'salary') {
    if (value === 'has') return 'has salary';
    if (!value) return 'any';
    return '\u2265 \u20b9' + value + 'L PPP';
  }
  return String(value);
}

// 'Has salary only' ships on, so it is not something the user chose -- but it
// hides 7,869 of 16,228 postings, an effect far too large to leave unnamed. It
// is listed and clearable like any other filter.
function activeFilters() {
  return Object.keys(FILTER_LABELS)
    .filter(key => String(state.filters[key] || '') !== String(FILTER_OFF[key] || ''))
    .map(key => [key, state.filters[key]]);
}

function renderFilterState() {
  const active = activeFilters();
  const count = $('#filterCount');
  count.textContent = active.length;
  count.hidden = !active.length;
  $('#btnClearFilters').hidden = !active.length;
  $('#activePills').innerHTML = active.map(pair =>
    '<button class="pill" data-unfilter="' + esc(pair[0]) + '" title="Remove this filter">' +
    '<b>' + esc(FILTER_LABELS[pair[0]]) + '</b> ' + esc(filterValueText(pair[0], pair[1])) +
    ' <i>\u00d7</i></button>').join('');
}

async function setFilter(key, value) {
  state.filters[key] = value;
  const input = { text: '#fText', seniority: '#fSeniority', location: '#fLocation',
                  salary: '#fSalary', age: '#fAge' }[key];
  if (input) $(input).value = value;
  if (key === 'salary') {
    state.settings.salaryFilter = value;
    await saveMeta();
  }
  repinOrder();
  render();
}

async function clearAllFilters() {
  // Salary clears to Any, not back to 'Has salary only': someone pressing
  // "clear all" wants to stop hiding postings, not to restore a hiding rule.
  const inputs = { text: '#fText', seniority: '#fSeniority', location: '#fLocation',
                   age: '#fAge', salary: '#fSalary' };
  Object.keys(inputs).forEach(key => {
    state.filters[key] = FILTER_OFF[key];
    $(inputs[key]).value = FILTER_OFF[key];
  });
  state.settings.salaryFilter = '';
  await saveMeta();
  repinOrder();
  render();
}

function renderHeadline() {
  const jobs = Object.values(state.jobs);
  const status = tasteStatus();
  const shown = jobs.filter(job => !job.hidden && passesFilters(job)).length;
  // Leads with what the list in front of you actually contains. The old line
  // opened with the library total, which is the one number that never explains
  // anything about the screen -- and the count hidden by the salary filter now
  // lives on that filter's own pill.
  const parts = [shown.toLocaleString() + ' of ' + jobs.length.toLocaleString() + ' shown',
    status.pairs.toLocaleString() + ' comparisons', registry.length + ' sources'];
  if (state.settings.resumeSavedAt) parts.push('resume loaded');
  if (state.meta.lastRefresh) parts.push(relativeAge(state.meta.lastRefresh));
  if (storageDegraded) parts.push('NOT SAVING — ' + storageDegraded);
  $('#headline').textContent = parts.join('  ·  ');
}

function render() {
  document.querySelectorAll('.tab').forEach(tab => {
    const on = tab.dataset.view === state.view;
    tab.classList.toggle('active', on);
    // role=tab without aria-selected tells a screen reader there are five tabs
    // and nothing about which one you are on.
    tab.setAttribute('aria-selected', on ? 'true' : 'false');
    tab.tabIndex = on ? 0 : -1;
  });
  renderDeck();
  renderHeadline();
  renderFilterState();
  $('#main').innerHTML = (VIEWS[state.view] || viewForYou)();
}

/* ------------------------------------------------------------------- wiring */

// A ranking moves every score, so every card on screen goes stale, not only the
// one clicked. Both halves of that are now handled: the clicked card is redrawn
// at once, because that is the feedback for the click itself, and a full
// re-render is scheduled for when the burst of clicks stops -- same pinned
// order, every visible percentage recomputed.
//
// The old comment justified skipping this with "1.5s at 60 ratings". Re-measured
// at the size this actually runs at -- 16,224 postings, 300 rankings -- a full
// re-render is ~180ms, most of it retraining. It was ~490ms before jobScore was
// memoised, and the corpus was being scored twice per render to fill two fields
// (fit.positive / fit.negative) that nothing ever read.
const RESCORE_DELAY = 220;
let rescoreTimer = null;

function scheduleRescore() {
  if (rescoreTimer) clearTimeout(rescoreTimer);
  rescoreTimer = setTimeout(() => {
    rescoreTimer = null;
    render();
  }, RESCORE_DELAY);
}

function refreshCard(id) {
  const job = state.jobs[id];
  const safe = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(id) : String(id).replace(/"/g, '\\"');
  const node = document.querySelector('[data-card="' + safe + '"]');
  if (!job || !node) return false;
  const wrapper = document.createElement('div');
  wrapper.innerHTML = cardHtml(job, predictFit(job), Number(node.dataset.alsoIn || 0));
  const fresh = wrapper.firstElementChild;
  if (!fresh) return false;
  fresh.dataset.alsoIn = node.dataset.alsoIn || '0';
  node.replaceWith(fresh);
  return true;
}

document.addEventListener('click', async event => {
  const target = event.target.closest(
    '[data-tag],[data-clear],[data-like],[data-hide],[data-restore],[data-repin],' +
    '[data-unfilter],.tab');
  if (!target) return;
  if (target.classList.contains('tab')) {
    state.view = target.dataset.view;
    repinOrder();
    render();
  } else if (target.dataset.tag) {
    await rankTag(target.dataset.job, target.dataset.tag, false);
  } else if (target.dataset.clear) {
    await clearRanking(target.dataset.clear);
  } else if (target.dataset.like) {
    await likeJob(target.dataset.like);
  } else if (target.dataset.hide) {
    await dismissJob(target.dataset.hide);
  } else if (target.dataset.restore) {
    await restoreJob(target.dataset.restore);
  } else if (target.dataset.repin) {
    repinOrder();
    render();
  } else if (target.dataset.unfilter) {
    await setFilter(target.dataset.unfilter, FILTER_OFF[target.dataset.unfilter]);
  }
});

// Right-click ranks from the bottom. The browser menu is suppressed only over
// a chip, so a right-click anywhere else on the page still behaves normally --
// including on the posting's title link, where the menu is how you open a job
// in a new tab.
document.addEventListener('contextmenu', async event => {
  const chip = event.target.closest('[data-tag]');
  if (!chip) return;
  event.preventDefault();
  await rankTag(chip.dataset.job, chip.dataset.tag, true);
});

function bindFilter(sel, key, cast) {
  $(sel).addEventListener('input', event => {
    state.filters[key] = cast ? cast(event.target.value) : event.target.value;
    repinOrder();
    render();
  });
}

// A tablist is expected to move focus with the arrow keys, with the group
// occupying ONE tab stop. Five separate tab stops that ignore the arrows is
// what the markup did before role="tab" was on it, and adding the role without
// the behaviour is worse than not claiming it at all.
function bindTabs() {
  const tabs = Array.from(document.querySelectorAll('#tabs .tab'));
  $('#tabs').addEventListener('keydown', event => {
    const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    const jump = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : -1;
    if (!step && jump === -1) return;
    event.preventDefault();
    const at = tabs.indexOf(document.activeElement);
    const next = jump !== -1 ? jump
      : tabs[(at + step + tabs.length) % tabs.length] ? (at + step + tabs.length) % tabs.length : 0;
    tabs[next].focus();
    state.view = tabs[next].dataset.view;
    repinOrder();
    render();
  });
}

function bindFilterBar() {
  const deck = $('#deck');
  const toggle = $('#btnFilters');
  // Folded state is remembered, because whether you want the row is a property
  // of how you work, not of this page load.
  const stored = state.settings.filtersOpen;
  let open = stored === undefined ? true : !!stored;
  const paint = () => {
    deck.hidden = !open;
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  };
  paint();
  toggle.addEventListener('click', async () => {
    open = !open;
    state.settings.filtersOpen = open;
    paint();
    await saveMeta();
  });
  $('#btnClearFilters').addEventListener('click', clearAllFilters);
}

function bindResume() {
  const modal = $('#resumeModal');
  const drop = $('#resumeDrop');
  const summary = () => {
    const n = Object.keys(state.settings.resumeTags).length;
    $('#resumeSummary').textContent = state.settings.resumeSavedAt
      ? n + ' skills recognised from ' + state.settings.resumeChars.toLocaleString() +
        ' characters, saved ' + relativeAge(state.settings.resumeSavedAt) + '.'
      : 'Not saved yet.';
  };
  $('#btnResume').addEventListener('click', () => { modal.hidden = false; summary(); });
  $('#resumeClose').addEventListener('click', () => { modal.hidden = true; });
  $('#resumeSave').addEventListener('click', async () => {
    const text = $('#resumeText').value;
    state.settings.resumeTags = resumeToTagWeights(text);
    state.settings.resumeChars = text.length;
    state.settings.resumeSavedAt = new Date().toISOString();
    await saveMeta();
    invalidateTaste();
    summary();
    render();
  });
  $('#resumeClear').addEventListener('click', async () => {
    // Only the resume keys. Replacing the whole settings object also threw away
    // salaryFilter and the folded-filters preference, so clearing a resume
    // silently reset the salary filter to its default.
    state.settings.resumeTags = {};
    state.settings.resumeSavedAt = '';
    state.settings.resumeChars = 0;
    $('#resumeText').value = '';
    await saveMeta();
    invalidateTaste();
    summary();
    render();
  });
  ['dragenter', 'dragover'].forEach(type => drop.addEventListener(type, e => {
    e.preventDefault(); drop.classList.add('over');
  }));
  ['dragleave', 'drop'].forEach(type => drop.addEventListener(type, () => drop.classList.remove('over')));
  drop.addEventListener('drop', async event => {
    event.preventDefault();
    const file = event.dataTransfer.files[0];
    if (!file) return;
    drop.textContent = 'Reading ' + file.name + '…';
    try {
      $('#resumeText').value = await readResumeFile(file);
      drop.textContent = 'Read ' + file.name + ' — press Save.';
    } catch (err) {
      drop.textContent = err.message;
    }
  });
}

async function init() {
  $('#versionBadge').textContent = 'v' + APP_VERSION;
  try {
    registry = await (await fetch('registry.json')).json();
  } catch (err) {
    $('#headline').textContent = 'Could not load registry.json — serve this folder over http, not file://';
    return;
  }
  await loadState();
  bindFilter('#fText', 'text');
  bindFilter('#fSeniority', 'seniority');
  bindFilter('#fLocation', 'location');
  bindFilter('#fAge', 'age', Number);
  $('#fSalary').value = state.settings.salaryFilter || '';
  state.filters.salary = state.settings.salaryFilter || '';
  $('#fSalary').addEventListener('input', async event => {
    state.filters.salary = event.target.value;
    state.settings.salaryFilter = event.target.value;
    await saveMeta();
    repinOrder();
    render();
  });
  bindTabs();
  bindFilterBar();
  bindResume();
  $('#btnRefresh').addEventListener('click', refreshPostings);
  $('#btnStop').addEventListener('click', () => { refreshAbort = true; });
  renderDeck(true);
  render();
  if (!Object.keys(state.jobs).length) {
    $('#headline').textContent = 'Empty library — hit Refresh postings to pull from ' +
      registry.length + ' companies.';
  }
}

init();

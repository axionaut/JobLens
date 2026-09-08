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

const APP_VERSION = 2;

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
    if (!job.ranking) job.ranking = { order: [], disliked: [] };
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
  experience: 'Experience', location: 'Location', pay: 'Pay', condition: 'Conditions'
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
  ['Ruby', 'tech', /\bruby\b|\brails\b/i],
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
  ['Healthcare/Bio', 'domain', /\b(healthcare|clinical|patient|biotech|medical device|life sciences|pharma)\b/i],
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
  ['Greenfield/0-to-1', 'condition', /\b(greenfield|zero to one|0 to 1|from scratch|ground up|founding engineer)\b/i],
  ['Mentorship', 'condition', /\b(mentor(ing|ship)|coach(ing)? engineers|grow the team)\b/i],
  ['Fast-paced', 'condition', /\b(fast-?paced|move quickly|high growth|scrappy)\b/i],
  ['Cross-functional', 'condition', /\bcross-?functional\b/i],
  ['Ownership/Autonomy', 'condition', /\b(ownership|autonomy|own the|end-to-end ownership)\b/i],
  ['Customer-facing', 'condition', /\b(customer-?facing|client-?facing|stakeholder management)\b/i],
  ['Shift work', 'condition', /\b(shift work|night shift|weekend shift|rotating shift)\b/i],
  ['Contract/Temp', 'condition', /\b(contract role|fixed[- ]term|temporary position|freelance|contractor)\b/i],
  ['Part-time', 'condition', /\bpart[- ]time\b/i],
  ['German required', 'condition', /\b(german (language )?(skills|required)|fließend deutsch|deutschkenntnisse|sehr gute deutsch)\b/i]
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
// A tag on almost everything cannot discriminate; a tag on almost nothing is not
// worth a click. Only tags inside this band are offered for ranking.
const TAG_BAND_MIN = 0.004;
const TAG_BAND_MAX = 0.30;

function rankingEvents() {
  const events = [];
  Object.values(state.jobs).forEach(job => {
    if (job.ranking && (job.ranking.order || []).length) {
      events.push({ order: job.ranking.order, disliked: job.ranking.disliked || [], pool: job.tags || [], weight: 1 });
    } else if (job.dismissed) {
      events.push({ order: [], disliked: job.tags || [], pool: job.tags || [], weight: DISMISS_WEIGHT });
    }
  });
  return events;
}

// Every constraint the event implies, as [winner, loser, weight]. Clicked tags
// beat later-clicked ones, everything clicked beats everything unclicked, and
// anything explicitly disliked loses to both.
function eventPairs(event) {
  const pairs = [];
  const order = event.order || [];
  const disliked = event.disliked || [];
  const clicked = new Set(order);
  const down = new Set(disliked);
  const rest = (event.pool || []).filter(tag => !clicked.has(tag) && !down.has(tag));
  for (let i = 0; i < order.length; i++) {
    for (let j = i + 1; j < order.length; j++) pairs.push([order[i], order[j], event.weight]);
    rest.forEach(tag => pairs.push([order[i], tag, event.weight * 0.7]));
    disliked.forEach(tag => pairs.push([order[i], tag, event.weight]));
  }
  rest.forEach(tag => disliked.forEach(bad => pairs.push([tag, bad, event.weight * 0.5])));
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
      utility[a] += step;
      utility[b] -= step;
    });
    // Shrink toward zero so a tag seen in one lopsided comparison cannot run
    // away to an extreme the evidence does not support.
    Object.keys(utility).forEach(tag => { utility[tag] *= (1 - RANK_REGULARIZATION); });
    rate *= RANK_DECAY;
  }
  return { utility: utility, pairs: pairs.length, events: events.length, tags: Object.keys(utility).length };
}

function tagModel() {
  if (!tagUtilityCache) tagUtilityCache = trainTagUtilities();
  return tagUtilityCache;
}

function invalidateTaste() {
  tagUtilityCache = null;
  tagFrequencyCache = null;
}

function tagUtility(tag) {
  const value = tagModel().utility[tag];
  return value === undefined ? 0 : value;
}

// Rankable tags: inside the frequency band, so a click always moves a
// meaningful number of postings and never merely restates the obvious.
function tagIsRankable(tag) {
  const freq = tagFrequency();
  const share = (freq.counts.get(tag) || 0) / freq.total;
  return share >= TAG_BAND_MIN && share <= TAG_BAND_MAX;
}

function tagCoverage(tag) {
  return tagFrequency().counts.get(tag) || 0;
}

// A posting scores as the mean utility of the tags it carries, which keeps a
// twenty-tag posting from beating a six-tag one on volume alone. The resume
// still contributes, fading as real rankings arrive.
function jobScore(job) {
  const tags = (job.tags || []).filter(tagIsRankable);
  if (!tags.length) return { score: 0, known: 0, positive: [], negative: [] };
  const model = tagModel();
  const scale = resumeEvidenceScale(model.events);
  let total = 0, known = 0;
  const contributions = [];
  tags.forEach(tag => {
    const learned = tagUtility(tag);
    const resume = resumeTagEffect(tag, model.events) * scale * 0.5;
    const value = learned + resume;
    total += value;
    if (learned !== 0) known++;
    contributions.push([tag, value]);
  });
  contributions.sort((a, b) => b[1] - a[1]);
  return {
    score: total / tags.length,
    known: known,
    positive: contributions.filter(pair => pair[1] > 0.02),
    negative: contributions.filter(pair => pair[1] < -0.02).reverse()
  };
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
    positive: scored.positive,
    negative: scored.negative,
    usable: model.pairs > 0,
    events: model.events,
    pairs: model.pairs
  };
}

function tasteStatus() {
  const model = tagModel();
  const ranked = Object.values(state.jobs).filter(job => job.ranking && (job.ranking.order || []).length).length;
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
  const derived = [locationClass, seniority];
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
    family: familyRule ? familyRule[0] : 'Other',
    seniority: seniority,
    salary: salary,
    tags: tags,
    excerpt: body.slice(0, 320),
    bodyChars: body.length,
    ranking: null,
    ratedAt: '',
    dismissed: false,
    hidden: false,
    firstSeen: new Date().toISOString()
  };
}

function hasRanking(job) {
  return !!(job.ranking && (job.ranking.order || []).length) ||
         !!(job.ranking && (job.ranking.disliked || []).length);
}

function rankedJobs() {
  return Object.values(state.jobs).filter(job => hasRanking(job) || job.dismissed);
}

/* --------------------------------------------------------------- rendering */

// Rank order is shown as a number on the chip, so the click that produced it is
// visible and correctable. A second click on a ranked chip removes it from the
// order; the down-arrow marks it disliked.
function tagChipsHtml(job) {
  const ranking = job.ranking || { order: [], disliked: [] };
  const order = ranking.order || [];
  const disliked = ranking.disliked || [];
  const rankable = (job.tags || []).filter(tagIsRankable);
  if (!rankable.length) return '<div class="tagline muted">No rankable tags on this posting.</div>';
  const model = tagModel();
  const chips = rankable.map(tag => {
    const rank = order.indexOf(tag);
    const bad = disliked.indexOf(tag) !== -1;
    const utility = tagUtility(tag);
    const lean = utility > 0.05 ? ' lean-up' : utility < -0.05 ? ' lean-down' : '';
    const cls = rank !== -1 ? 'chip ranked' : bad ? 'chip disliked' : 'chip' + lean;
    const title = tag + ' — on ' + tagCoverage(tag).toLocaleString() + ' postings' +
      (model.pairs ? ', learned score ' + utility.toFixed(2) : '');
    return '<button class="' + cls + '" data-tag="' + esc(tag) + '" data-job="' + esc(job.id) + '" ' +
      'title="' + esc(title) + '">' +
      (rank !== -1 ? '<b>' + (rank + 1) + '</b> ' : '') + esc(tag) +
      '<span class="chipNo" data-dislike="' + esc(tag) + '" data-job="' + esc(job.id) + '" ' +
      'title="Mark as something you do not want">' + (bad ? '✕' : '·') + '</span></button>';
  }).join('');
  return '<div class="tagline">' + chips + '</div>';
}

function cardHtml(job, fit, alsoIn) {
  const pct = fit.matchPct;
  const cls = pct === null ? 'lo' : pct >= 80 ? 'hi' : pct >= 50 ? 'mid' : 'lo';
  const why = !fit.usable
    ? 'rank a few tags to start'
    : fit.knownTags + ' of ' + (job.tags || []).filter(tagIsRankable).length + ' tags learned';
  const ranking = job.ranking || { order: [], disliked: [] };
  const done = (ranking.order || []).length + (ranking.disliked || []).length;
  return '<article class="card" data-card="' + esc(job.id) + '">' +
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
      '<span class="muted">' + (done ? done + ' ranked' : 'click tags in the order you want them') + '</span>' +
      (job.dismissed
        ? '<button data-restore="' + esc(job.id) + '">undo</button>'
        : (done ? '<button data-clear="' + esc(job.id) + '">clear</button>' : '') +
          '<button data-hide="' + esc(job.id) + '" title="Weak negative on all its tags, and hides it">not for me</button>') +
    '</div></article>';
}

function scoredList(jobs) {
  const entries = jobs.map(job => ({ job: job, fit: null }));
  const scores = entries.map(entry => jobScore(entry.job).score);
  setScoreDistribution(scores);
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

// Rating re-renders, and a re-render re-sorts. With one star per card that was
// merely jarring; with five facets it breaks the interaction outright, because
// the moment you rate ONE facet the card stops being "unrated" and vanishes
// before you can rate the other four -- and in For You the remaining cards
// reorder under the cursor, so the next click lands on a different job.
//
// So the surfaced order is pinned. The first render of a view computes the
// order; subsequent renders reuse it, keeping cards in place and letting their
// stars fill in where they sit. It recomputes when the view or the filters
// change, which is the moment the user is asking for a fresh list anyway.
// Dismissed and hidden postings are dropped from the pin, because "not for me"
// is an explicit request to remove the card.
let pinnedOrder = { key: '', ids: [] };

function viewKey() {
  const f = state.filters;
  return [state.view, f.text, f.seniority, f.location, f.age, f.salary].join('|');
}

function repinOrder() {
  pinnedOrder = { key: '', ids: [] };
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
    return kept;
  }
  pinnedOrder = { key: key, ids: entries.map(entry => entry.job.id) };
  return entries;
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
    return '<p class="notice">Nothing ranked yet, so this is newest first. On any card, click the ' +
      'tags in the order you want them — first click is what appeals most. Three clicks on one posting ' +
      'already teaches the model a dozen comparisons, and every one applies to the whole pool, not ' +
      'just that job.</p>' + renderGrid(byDate.slice(0, 120), '');
  }
  const ranked = pinnedList(collapseDuplicates(scored)
    .sort((a, b) => b.fit.score - a.fit.score ||
                    b.fit.knownTags - a.fit.knownTags ||
                    a.job.title.localeCompare(b.job.title)));
  return '<p class="notice">Ranked from ' + status.pairs.toLocaleString() + ' tag comparisons across ' +
    status.events + ' posting' + (status.events === 1 ? '' : 's') + ', covering ' + status.tags +
    ' tags. Percentages are position in this pool, not a predicted rating — you ranked tags against ' +
    'each other, never scored a job out of five.</p>' + renderGrid(ranked.slice(0, 120), '');
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
  return '<p class="notice">These carry the most tags the model has never seen compared, so they ' +
    'teach the most. Click tags in preference order — you never have to rank them all, and the ' +
    '<b>·</b> on a chip marks a tag you actively do not want. ' + tasteStatus().pairs.toLocaleString() +
    ' comparisons learned so far.</p>' + renderGrid(pinned, 'Nothing left to rank here.');
}

function viewRated() {
  const entries = scoredList(rankedJobs().filter(job => passesFilters(job, 'rated')))
    .sort((a, b) => (b.job.ratedAt || '').localeCompare(a.job.ratedAt || ''));
  const dismissed = entries.filter(e => e.job.dismissed).length;
  return '<p class="notice">Everything you have ranked. Rankings can be changed here and the model ' +
    'retrains from scratch each time, so nothing is baked in.' +
    (dismissed ? ' ' + dismissed + ' were dismissed with "not for me", which counts as a weak negative ' +
      'across all that posting’s tags at ' + DISMISS_WEIGHT + ' weight — it says none of this appealed ' +
      'without claiming to know which part.' : '') + '</p>' +
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
  if (!job.ranking) job.ranking = { order: [], disliked: [] };
  if (!job.ranking.order) job.ranking.order = [];
  if (!job.ranking.disliked) job.ranking.disliked = [];
  return job.ranking;
}

// Clicking an unranked tag appends it to the order; clicking a ranked one
// removes it and everything keeps its relative order. A tag cannot be ranked
// and disliked at once.
async function rankTag(jobId, tag) {
  const job = state.jobs[jobId];
  if (!job) return;
  const ranking = ensureRanking(job);
  const at = ranking.order.indexOf(tag);
  if (at !== -1) ranking.order.splice(at, 1);
  else {
    ranking.order.push(tag);
    const bad = ranking.disliked.indexOf(tag);
    if (bad !== -1) ranking.disliked.splice(bad, 1);
  }
  job.ratedAt = new Date().toISOString();
  job.dismissed = false;
  job.hidden = false;
  invalidateTaste();
  if (!refreshCard(jobId)) render();
  renderHeadline();
  await saveJobs([job]);
}

async function dislikeTag(jobId, tag) {
  const job = state.jobs[jobId];
  if (!job) return;
  const ranking = ensureRanking(job);
  const at = ranking.disliked.indexOf(tag);
  if (at !== -1) ranking.disliked.splice(at, 1);
  else {
    ranking.disliked.push(tag);
    const ranked = ranking.order.indexOf(tag);
    if (ranked !== -1) ranking.order.splice(ranked, 1);
  }
  job.ratedAt = new Date().toISOString();
  invalidateTaste();
  if (!refreshCard(jobId)) render();
  renderHeadline();
  await saveJobs([job]);
}

async function clearRanking(id) {
  const job = state.jobs[id];
  if (!job) return;
  job.ranking = { order: [], disliked: [] };
  job.ratedAt = '';
  job.dismissed = false;
  job.hidden = false;
  invalidateTaste();
  if (!refreshCard(id)) render();
  renderHeadline();
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
  job.hidden = true;
  job.ratedAt = new Date().toISOString();
  invalidateTaste();
  render();
  await saveJobs([job]);
}

async function restoreJob(id) {
  const job = state.jobs[id];
  if (!job) return;
  job.dismissed = false;
  job.hidden = false;
  job.ranking = { order: [], disliked: [] };
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

function renderHeadline() {
  const jobs = Object.values(state.jobs);
  const status = tasteStatus();
  const parts = [jobs.length.toLocaleString() + ' postings', registry.length + ' sources',
    status.pairs.toLocaleString() + ' comparisons'];
  if (state.settings.resumeSavedAt) parts.push('resume loaded');
  if (state.meta.lastRefresh) parts.push('refreshed ' + relativeAge(state.meta.lastRefresh));
  if (state.filters.salary) {
    const noSalary = jobs.filter(job => !job.salary && !job.hidden).length;
    if (noSalary) parts.push(noSalary.toLocaleString() + ' hidden for no stated salary');
  }
  if (storageDegraded) parts.push('NOT SAVING — ' + storageDegraded);
  $('#headline').textContent = parts.join('  ·  ');
}

function render() {
  document.querySelectorAll('.tab').forEach(tab =>
    tab.classList.toggle('active', tab.dataset.view === state.view));
  renderDeck();
  renderHeadline();
  $('#main').innerHTML = (VIEWS[state.view] || viewForYou)();
}

/* ------------------------------------------------------------------- wiring */

// A rating changes the models, so in principle every card on screen is stale.
// Re-rendering all of them costs a full rescore of the candidate set -- 1.5s at
// 60 ratings, on every click -- and throws away the pinned order the user is
// mid-way through reading. So only the card just clicked is redrawn. The rest
// pick up the new model on the next full render, which is exactly when the user
// asks for a fresh list: switching view, changing a filter, or refreshing.
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
  const target = event.target.closest('[data-dislike],[data-tag],[data-clear],[data-hide],[data-restore],.tab');
  if (!target) return;
  if (target.classList.contains('tab')) {
    state.view = target.dataset.view;
    repinOrder();
    render();
  } else if (target.dataset.dislike) {
    // The dislike marker sits inside the chip, so it must claim the click
    // before the chip's own ranking handler sees it.
    event.stopPropagation();
    await dislikeTag(target.dataset.job, target.dataset.dislike);
  } else if (target.dataset.tag) {
    await rankTag(target.dataset.job, target.dataset.tag);
  } else if (target.dataset.clear) {
    await clearRanking(target.dataset.clear);
  } else if (target.dataset.hide) {
    await dismissJob(target.dataset.hide);
  } else if (target.dataset.restore) {
    await restoreJob(target.dataset.restore);
  }
});

function bindFilter(sel, key, cast) {
  $(sel).addEventListener('input', event => {
    state.filters[key] = cast ? cast(event.target.value) : event.target.value;
    repinOrder();
    render();
  });
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
    state.settings = { resumeTags: {}, resumeSavedAt: '', resumeChars: 0 };
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

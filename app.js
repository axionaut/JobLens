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

const APP_VERSION = 1;

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
  jobs.forEach(job => {
    if (!job.ratings) {
      job.ratings = { role: 0, level: 0, company: 0, location: 0, salary: 0 };
      if (Number(job.rating || 0) > 0) job.ratings.role = Number(job.rating);
    }
    delete job.rating;
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
  if (mid >= 15000000) return 'pay:1.5Cr+ ppp';
  if (mid >= 10000000) return 'pay:1-1.5Cr ppp';
  if (mid >= 6000000) return 'pay:60L-1Cr ppp';
  if (mid >= 4000000) return 'pay:40-60L ppp';
  if (mid >= 2500000) return 'pay:25-40L ppp';
  return 'pay:under-25L ppp';
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

/* ------------------------------------------------------------------ tagger */

// The skill vocabulary is matched literally against the posting body. This is
// the precision half of the tagger: a hit means the phrase is actually in the
// text, so a learned weight on it is always explainable back to real evidence.
// The recall half (extractKeyphrases below) picks up whatever the list misses.
// Same split CineLens runs between its dictionary and its local tag scorer.
const SKILL_VOCAB = [
  'python','javascript','typescript','golang','rust','java','kotlin','swift','ruby',
  'c++','scala','elixir','clojure','haskell','php','solidity',
  'react','next.js','vue','svelte','angular','tailwind','webgl','three.js',
  'react native','flutter','ios','android',
  'node.js','django','flask','fastapi','rails','spring','graphql','grpc',
  'postgres','postgresql','mysql','mongodb','redis','elasticsearch','cassandra','dynamodb',
  'kafka','rabbitmq','airflow','dbt','spark','hadoop','snowflake','databricks','clickhouse',
  'kubernetes','docker','terraform','aws','gcp','azure','jenkins','github actions',
  'observability','prometheus','grafana','datadog','linux','distributed systems',
  'microservices','serverless','site reliability',
  'machine learning','deep learning','pytorch','tensorflow','jax','computer vision',
  'large language model','transformers','fine-tuning','reinforcement learning',
  'recommendation systems','ranking','embeddings','mlops','data science','statistics',
  'cryptography','penetration testing','threat modeling','soc 2',
  'product management','user research','design systems','figma','accessibility',
  'experimentation','analytics','data pipeline','tableau',
  'technical writing','developer relations','solutions engineering','sales engineering',
  'pair programming','code review','on-call','mentorship','greenfield','zero to one',
  'open source','fast-paced','ownership','autonomy','cross-functional',
  'customer-facing','prototyping','migration'
];

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

// Recall half: repeated 2- and 3-word content phrases. The trap CineLens
// documents for names (spec 3.2.2) shows up here as company names and hiring
// boilerplate; the stopword list catches the boilerplate and the >10%
// presentability cut at scoring time catches whatever repeats across the
// library. A phrase must appear at least twice in one posting to count at all.
function extractKeyphrases(body, limit) {
  const words = body.toLowerCase().replace(/[^a-z0-9+#./ -]/g, ' ').split(/\s+/).filter(Boolean);
  const counts = new Map();
  for (let n = 2; n <= 3; n++) {
    for (let i = 0; i + n <= words.length; i++) {
      const gram = words.slice(i, i + n);
      let ok = true;
      for (const w of gram) {
        if (STOPWORDS.has(w) || w.length < 3 || /^\d+$/.test(w)) { ok = false; break; }
      }
      if (!ok) continue;
      const phrase = gram.join(' ');
      if (phrase.length > 34) continue;
      counts.set(phrase, (counts.get(phrase) || 0) + 1);
    }
  }
  return Array.from(counts.entries())
    .filter(pair => pair[1] >= 2)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit || 14)
    .map(pair => pair[0]);
}

function matchesSkill(haystack, term) {
  const t = term.toLowerCase();
  if (!/^[a-z0-9]/.test(t) || !/[a-z0-9]$/.test(t)) return haystack.indexOf(t) !== -1;
  const escaped = t.replace(/[.+*?^${}()|[\]\\]/g, '\\$&');
  return new RegExp('(^|[^a-z0-9])' + escaped + '([^a-z0-9]|$)').test(haystack);
}

function tagPosting(row) {
  const body = row.body || '';
  const haystack = (row.title + ' ' + body).toLowerCase();
  const skills = SKILL_VOCAB.filter(term => matchesSkill(haystack, term));
  const familyRule = FAMILY_RULES.find(r => r[1].test(row.title)) ||
                     FAMILY_RULES.find(r => r[1].test(haystack));
  const seniorityRule = SENIORITY_RULES.find(r => r[1].test(row.title));
  const tags = Array.from(new Set(skills.concat(extractKeyphrases(body, 14))));
  const salary = extractSalary(row, body);
  return {
    salary: salary,
    id: row.entry.ats + ':' + row.entry.slug + ':' + row.key,
    company: row.company || row.entry.company,
    ats: row.entry.ats,
    title: row.title || '(untitled)',
    url: row.url || '',
    location: row.location || '',
    locationClass: classifyLocation(row.location + ' ' + body.slice(0, 400)),
    region: regionOf(row.location),
    postedAt: row.postedAt || '',
    family: familyRule ? familyRule[0] : 'Other',
    seniority: seniorityRule ? seniorityRule[0] : 'Mid',
    tags: tags,
    conditions: conditionTags(row, body),
    // sourceShed, CineLens-style: the body produced the tags and is not needed
    // again. Keeping 11k full descriptions would run to ~100MB in IndexedDB for
    // no scoring benefit. Shed BYTES, never the record -- an unrated posting may
    // match well after a later tagger change, and the excerpt is enough to
    // re-read one by eye without a refetch.
    excerpt: body.slice(0, 320),
    bodyChars: body.length,
    ratings: { role: 0, level: 0, company: 0, location: 0, salary: 0 },
    ratedAt: '',
    dismissed: false,
    hidden: false,
    firstSeen: new Date().toISOString()
  };
}

/* ------------------------------------------------------------- taste model */

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

const FACET_KEYS = ['role', 'level', 'company', 'location', 'salary'];

const FACET_LABELS = {
  role: 'Role', level: 'Level', company: 'Company', location: 'Location', salary: 'Salary'
};

// Pay bands low to high. Order matters: the salary facet is ordinal, not
// categorical, and the monotone pass below relies on this sequence.
const PAY_BAND_ORDER = [
  'pay:under-25L ppp', 'pay:25-40L ppp', 'pay:40-60L ppp',
  'pay:60L-1Cr ppp', 'pay:1-1.5Cr ppp', 'pay:1.5Cr+ ppp'
];

// Shrinkage toward the global mean, in units of "ratings". A company you rated
// once sits mostly at the global mean; by the fifth rating it has largely moved
// to its own. Without this, one 5-star makes a company look like a certainty.
const CATEGORICAL_SHRINKAGE = 2.5;

function facetFeatures(job, facet) {
  switch (facet) {
    case 'role': return job.tags || [];
    case 'level': return broadFeatures(job);
    case 'company': return job.company ? ['company:' + job.company] : [];
    case 'location': {
      const out = [];
      if (job.locationClass) out.push('loc:' + job.locationClass);
      if (job.region) out.push('region:' + job.region);
      return out;
    }
    case 'salary': return job.salary && job.salary.band ? [job.salary.band] : [];
    default: return [];
  }
}

function facetRating(job, facet) {
  return Number((job.ratings || {})[facet] || 0);
}

function hasAnyRating(job) {
  return FACET_KEYS.some(facet => facetRating(job, facet) > 0);
}

function ratedJobs(excludeId) {
  const skip = String(excludeId || '');
  return Object.values(state.jobs).filter(job =>
    hasAnyRating(job) && (!skip || String(job.id) !== skip));
}

// Dismissals stay cheap and numerous next to a considered star, so they keep
// the reduced weight they had.
// predictFit runs once per card and every card wants the same number, so this
// is memoised with the models. Recomputing it inline made each of ~1,600 cards
// rescan the whole library -- 2.7 million iterations per render, which was 5.6
// of the 5.8 seconds a single star click used to cost.
let ratedCountCache = null;

function ratedCount() {
  if (ratedCountCache === null) ratedCountCache = ratedJobs('').length;
  return ratedCountCache;
}

function rowWeight(job) {
  return job.dismissed ? ROW_WEIGHT_DISMISSED : ROW_WEIGHT_RATED;
}

function facetRows(facet, excludeId) {
  const skip = String(excludeId || '');
  const rows = [];
  Object.values(state.jobs).forEach(job => {
    const rating = facetRating(job, facet);
    if (!rating) return;
    if (skip && String(job.id) === skip) return;
    rows.push({
      job: job,
      rating: rating,
      weight: rowWeight(job),
      features: facetFeatures(job, facet)
    });
  });
  return rows;
}

/* --- the role facet: the residual tag model, unchanged in substance -------- */

function trainRoleModel(rows) {
  const totalWeight = rows.reduce((sum, row) => sum + row.weight, 0);
  const baseline = totalWeight
    ? rows.reduce((sum, row) => sum + row.rating * row.weight, 0) / totalWeight
    : 3;
  const model = {
    kind: 'residual', baseline: baseline, effects: {}, evidenceCount: rows.length,
    calibrationSlope: 1, calibrationIntercept: 0,
    tagMassPivot: TAG_MASS_PIVOT_FALLBACK, degenerate: false
  };
  const ratings = rows.map(row => row.rating);
  model.degenerate = !ratings.length ||
    Math.max.apply(null, ratings) - Math.min.apply(null, ratings) === 0;
  if (rows.length < MIN_RATINGS_FOR_MODEL || model.degenerate) return model;

  const masses = rows.map(row => tagFeatureMass(row.features));
  const sorted = masses.slice().sort((a, b) => a - b);
  model.tagMassPivot = sorted[Math.floor(sorted.length / 2)] || TAG_MASS_PIVOT_FALLBACK;
  const lengthFactors = masses.map(mass => tagMassLengthFactor(mass, model.tagMassPivot));
  const predictions = rows.map(() => baseline);

  for (let pass = 0; pass < TASTE_MODEL_PASSES; pass++) {
    const stats = {};
    rows.forEach((row, index) => {
      const residual = row.rating - predictions[index];
      row.features.forEach(tag => {
        const feature = tagFeatureValue(tag) * lengthFactors[index];
        const stat = stats[tag] || (stats[tag] = { sum: 0, strength: 0 });
        stat.sum += residual * feature * row.weight;
        stat.strength += feature * feature * row.weight;
      });
    });
    const deltas = {};
    Object.keys(stats).forEach(tag => {
      const stat = stats[tag];
      const delta = clamp(
        (stat.sum / (stat.strength + TASTE_MODEL_TAG_REGULARIZATION)) * TASTE_MODEL_TAG_LEARNING_RATE,
        -0.42, 0.42);
      if (!delta) return;
      model.effects[tag] = (model.effects[tag] || 0) + delta;
      deltas[tag] = delta;
    });
    rows.forEach((row, index) => {
      row.features.forEach(tag => {
        predictions[index] += (deltas[tag] || 0) * tagFeatureValue(tag) * lengthFactors[index];
      });
      predictions[index] = clamp(predictions[index], 1, 5);
    });
  }

  const meanRaw = predictions.reduce((sum, v, i) => sum + v * rows[i].weight, 0) / totalWeight;
  const meanActual = rows.reduce((sum, r) => sum + r.rating * r.weight, 0) / totalWeight;
  let variance = 0, covariance = 0;
  predictions.forEach((value, index) => {
    const d = value - meanRaw;
    variance += d * d * rows[index].weight;
    covariance += d * (rows[index].rating - meanActual) * rows[index].weight;
  });
  if (variance > 0.001) {
    model.calibrationSlope = clamp(covariance / variance, 0.45, 2.4);
    model.calibrationIntercept = meanActual - model.calibrationSlope * meanRaw;
  }
  return model;
}

/* --- level, company, location: shrunk means over categories --------------- */

// These features are few and repeat often, so there is nothing to regress: the
// weighted mean rating of a category IS the estimate, pulled toward the global
// mean by however little evidence supports it.
function trainCategoricalModel(rows) {
  const totalWeight = rows.reduce((sum, row) => sum + row.weight, 0);
  const baseline = totalWeight
    ? rows.reduce((sum, row) => sum + row.rating * row.weight, 0) / totalWeight
    : 3;
  const model = { kind: 'categorical', baseline: baseline, effects: {}, evidenceCount: rows.length };
  const stats = {};
  rows.forEach(row => {
    row.features.forEach(key => {
      const stat = stats[key] || (stats[key] = { sum: 0, weight: 0, count: 0 });
      stat.sum += row.rating * row.weight;
      stat.weight += row.weight;
      stat.count += 1;
    });
  });
  Object.keys(stats).forEach(key => {
    const stat = stats[key];
    model.effects[key] = (stat.sum + CATEGORICAL_SHRINKAGE * baseline) /
                         (stat.weight + CATEGORICAL_SHRINKAGE);
  });
  return model;
}

/* --- salary: the same, then forced to never fall as pay rises ------------- */

// More money is never worse. Ratings are sparse enough that you might rate one
// band and skip the one above it, and an unsmoothed estimate would then claim
// you prefer 40L to 1Cr purely because you never rated 1Cr. A running maximum up
// the band order removes that artefact, and it is safe precisely because the
// ordering is real -- this would be wrong for location, which has no such order.
function trainSalaryModel(rows) {
  const model = trainCategoricalModel(rows);
  model.kind = 'ordinal';
  let running = -Infinity;
  PAY_BAND_ORDER.forEach(band => {
    const value = model.effects[band];
    if (value === undefined) {
      if (running > -Infinity) model.effects[band] = running;
      return;
    }
    running = Math.max(running, value);
    model.effects[band] = running;
  });
  // Bands below the lowest rated one inherit the lowest estimate, so a posting
  // paying less than anything you rated is not treated as unknown.
  let backfill;
  for (let i = PAY_BAND_ORDER.length - 1; i >= 0; i--) {
    const band = PAY_BAND_ORDER[i];
    if (model.effects[band] !== undefined) backfill = model.effects[band];
    else if (backfill !== undefined) model.effects[band] = backfill;
  }
  return model;
}

function trainFacet(facet, excludeId) {
  const rows = facetRows(facet, excludeId);
  if (facet === 'role') return trainRoleModel(rows);
  if (facet === 'salary') return trainSalaryModel(rows);
  return trainCategoricalModel(rows);
}

const facetModelCache = new Map();

function getFacetModel(facet, excludeId) {
  const key = facet + '|' + String(excludeId || '__full__');
  if (!facetModelCache.has(key)) facetModelCache.set(key, trainFacet(facet, excludeId));
  return facetModelCache.get(key);
}

function invalidateTaste() {
  facetModelCache.clear();
  tagFrequencyCache = null;
  ratedCountCache = null;
}

/* --- prediction ----------------------------------------------------------- */

function facetImportance(facet) {
  const table = state.settings.facetImportance;
  const stored = table ? Number(table[facet]) : NaN;
  return isFinite(stored) && stored >= 0 ? stored : 1;
}

// One facet's predicted 1-5 for one job, or null when that facet has nothing to
// say -- either no ratings yet, or this posting carries no feature it knows
// (a posting with no stated salary can never get a salary prediction).
function predictFacet(job, facet, excludeId) {
  const model = getFacetModel(facet, excludeId);
  const features = facetFeatures(job, facet);
  if (!model.evidenceCount || !features.length) return null;

  if (model.kind === 'residual') {
    if (model.degenerate || model.evidenceCount < MIN_RATINGS_FOR_MODEL) return null;
    const lengthFactor = tagMassLengthFactor(tagFeatureMass(features), model.tagMassPivot);
    let raw = model.baseline;
    const positive = [], negative = [];
    features.forEach(tag => {
      const contribution =
        (Number(model.effects[tag] || 0) + resumeTagEffect(tag, model.evidenceCount)) *
        tagFeatureValue(tag) * lengthFactor;
      raw += contribution;
      if (contribution > 0.015) positive.push([tag, contribution]);
      else if (contribution < -0.015) negative.push([tag, contribution]);
    });
    raw = clamp(model.calibrationSlope * clamp(raw, 1, 5) + model.calibrationIntercept, 1, 5);
    positive.sort((a, b) => b[1] - a[1]);
    negative.sort((a, b) => a[1] - b[1]);
    return { value: raw, positive: positive, negative: negative, evidence: model.evidenceCount };
  }

  // Categorical and ordinal: average the known category estimates. Unknown
  // categories are skipped rather than counted as neutral, so one known signal
  // is not diluted by a feature the model has never seen.
  let sum = 0, seen = 0;
  const parts = [];
  features.forEach(key => {
    const value = model.effects[key];
    if (value === undefined) return;
    sum += value; seen++;
    parts.push([key, value - model.baseline]);
  });
  if (!seen) return null;
  const value = clamp(sum / seen, 1, 5);
  parts.sort((a, b) => b[1] - a[1]);
  return {
    value: value,
    positive: parts.filter(p => p[1] > 0.05),
    negative: parts.filter(p => p[1] < -0.05).reverse(),
    evidence: model.evidenceCount
  };
}

// Rated postings predict leave-one-out, as before: a posting may not improve its
// own displayed fit by contributing its own ratings to the model. The exclusion
// is per facet, since a job rated only on salary contributed nothing to role.
function predictFit(job) {
  const excludeId = hasAnyRating(job) ? job.id : '';
  const facets = {};
  let weighted = 0, weight = 0;
  let positive = [], negative = [];

  FACET_KEYS.forEach(facet => {
    const prediction = predictFacet(job, facet, excludeId);
    facets[facet] = prediction;
    if (!prediction) return;
    const importance = facetImportance(facet);
    if (!importance) return;
    weighted += prediction.value * importance;
    weight += importance;
    positive = positive.concat(prediction.positive || []);
    negative = negative.concat(prediction.negative || []);
  });

  const known = FACET_KEYS.filter(facet => facets[facet]);
  const predicted = weight ? weighted / weight : 3;
  positive.sort((a, b) => b[1] - a[1]);
  negative.sort((a, b) => a[1] - b[1]);

  return {
    predicted: predicted,
    matchPct: Math.round(((predicted - 1) / 4) * 100),
    facets: facets,
    knownFacets: known,
    usable: known.length > 0,
    positive: positive,
    negative: negative,
    positiveScore: positive.reduce((sum, p) => sum + p[1], 0),
    negativePenalty: negative.reduce((sum, p) => sum + Math.abs(p[1]), 0),
    evidenceCount: ratedCount(),
    leaveOneOut: hasAnyRating(job)
  };
}

// How much the model actually knows, for the messages that have to explain
// themselves. A facet counts as live once it has any rating behind it, and the
// role facet additionally needs contrast before it can learn anything at all.
function tasteStatus() {
  const rated = ratedCount();
  const live = FACET_KEYS.filter(facet => {
    const model = getFacetModel(facet, '');
    if (!model.evidenceCount) return false;
    if (model.kind === 'residual') {
      return !model.degenerate && model.evidenceCount >= MIN_RATINGS_FOR_MODEL;
    }
    return true;
  });
  const perFacet = {};
  FACET_KEYS.forEach(facet => { perFacet[facet] = getFacetModel(facet, '').evidenceCount; });
  return { rated: rated, live: live, perFacet: perFacet, usable: live.length > 0 };
}

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

function broadFeatures(job) {
  const out = [];
  if (job.family) out.push('family:' + job.family);
  if (job.seniority) out.push('seniority:' + job.seniority);
  return out;
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

// Asked once. It never leaves the browser: the text is turned into tag weights
// here and only the weights are stored, so the resume itself is not sitting in
// IndexedDB waiting to be exfiltrated by anything that can read this origin.
function resumeToTagWeights(text) {
  const haystack = String(text || '').toLowerCase();
  if (!haystack.trim()) return {};
  const weights = {};
  SKILL_VOCAB.forEach(term => {
    if (!matchesSkill(haystack, term)) return;
    // Repetition in a resume is a real signal of emphasis, but a bounded one.
    const escaped = term.toLowerCase().replace(/[.+*?^${}()|[\]\\]/g, '\\$&');
    const hits = (haystack.match(new RegExp(escaped, 'g')) || []).length;
    weights[term] = clamp(1 + Math.log2(hits || 1), 1, 3);
  });
  extractKeyphrases(haystack, 20).forEach(phrase => {
    if (!weights[phrase]) weights[phrase] = 1;
  });
  return weights;
}

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
            ratings: existing.ratings,
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

/* --------------------------------------------------------------- rendering */

function chipHtml(entry, kind) {
  const label = entry[0].replace(/^(family|seniority|loc|region|comp|perk|req|dept):/, '');
  return '<span class="chip ' + kind + '" data-tag="' + esc(entry[0]) + '" title="' +
    esc(entry[0] + '  ' + (entry[1] > 0 ? '+' : '') + entry[1].toFixed(3)) + '">' + esc(label) + '</span>';
}

// Five facet rows. Each shows what that facet predicts for this posting until
// you rate it, then shows your rating -- so the row is both the model's guess
// and the place you correct it. A facet with nothing to say shows no guess
// rather than a neutral-looking three stars it has not earned.
function facetRowsHtml(job, fit) {
  return '<div class="facets">' + FACET_KEYS.map(facet => {
    const mine = facetRating(job, facet);
    const guess = fit.facets[facet];
    const stars = [1, 2, 3, 4, 5].map(n => {
      const on = mine >= n;
      const predicted = !mine && guess && Math.round(guess.value) >= n;
      return '<button class="star' + (on ? ' on' : predicted ? ' guess' : '') +
        '" data-rate="' + n + '" data-facet="' + facet + '" data-id="' + esc(job.id) +
        '" title="' + esc(FACET_LABELS[facet] + ': ' + n + ' star' + (on ? ' (click to clear)' : '')) +
        '">' + (on ? '★' : predicted ? '★' : '☆') + '</button>';
    }).join('');
    const note = mine ? 'you'
      : guess ? 'predicted ' + guess.value.toFixed(1)
      : 'no signal';
    return '<div class="facetRow"><span class="facetName">' + esc(FACET_LABELS[facet]) + '</span>' +
      '<span class="facetStars">' + stars + '</span>' +
      '<span class="facetNote' + (mine ? ' mine' : '') + '">' + esc(note) + '</span></div>';
  }).join('') + '</div>';
}

function cardHtml(job, fit, alsoIn) {
  const cls = fit.matchPct >= 70 ? 'hi' : fit.matchPct >= 45 ? 'mid' : 'lo';
  const chips = fit.positive.filter(p => tagIsPresentable(p[0]) || p[0].indexOf(':') !== -1).slice(0, 5)
    .map(p => chipHtml(p, 'pos'))
    .concat(fit.negative.filter(p => tagIsPresentable(p[0]) || p[0].indexOf(':') !== -1).slice(0, 3)
      .map(p => chipHtml(p, 'neg')))
    .join('');
  const why = fit.usable
    ? 'from ' + fit.knownFacets.map(f => FACET_LABELS[f].toLowerCase()).join(', ')
    : 'nothing rated yet';
  const rated = hasAnyRating(job);
  return '<article class="card" data-card="' + esc(job.id) + '">' +
    '<h3><a href="' + esc(job.url) + '" target="_blank" rel="noopener">' + esc(job.title) + '</a></h3>' +
    '<div class="meta"><strong>' + esc(job.company) + '</strong>' +
      '<span class="dot">' + esc(job.location || job.locationClass) +
        (alsoIn ? ' +' + alsoIn + ' more location' + (alsoIn > 1 ? 's' : '') : '') + '</span>' +
      '<span class="dot">' + esc(relativeAge(job.postedAt)) + '</span></div>' +
    salaryHtml(job) +
    '<div class="fit"><span class="fitPct ' + cls + '">' + (fit.usable ? fit.matchPct + '%' : '—') + '</span>' +
      '<span class="fitWhy">predicted fit<br>' + esc(why) + '</span></div>' +
    (chips ? '<div class="chips">' + chips + '</div>' : '') +
    '<div class="meta">' + esc(job.family) + ' · ' + esc(job.seniority) +
      (job.dismissed ? ' · <strong class="dismissed">not for me</strong>' : '') + '</div>' +
    facetRowsHtml(job, fit) +
    '<div class="cardFoot">' +
      (job.dismissed
        ? '<button data-restore="' + esc(job.id) + '">undo</button>'
        : (rated ? '<button data-clear="' + esc(job.id) + '">clear all</button>' : '') +
          '<button data-hide="' + esc(job.id) + '" title="Rates the role 1 star and hides it">not for me</button>') +
    '</div>' +
    '</article>';
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

function scoredList(jobs) {
  return jobs.map(job => ({ job: job, fit: predictFit(job) }));
}

function renderGrid(entries, emptyMessage) {
  if (!entries.length) return '<div class="empty">' + esc(emptyMessage) + '</div>';
  return '<div class="grid">' + entries.map(e =>
    cardHtml(e.job, e.fit, e.alsoIn).replace('<article class="card"',
      '<article class="card" data-also-in="' + (e.alsoIn || 0) + '"')).join('') + '</div>';
}

function viewForYou() {
  const candidates = Object.values(state.jobs).filter(j => !hasAnyRating(j) && passesFilters(j));
  void candidates;
  const scored = scoredList(candidates);
  const status = tasteStatus();

  if (!candidates.length) {
    return '<div class="empty">Nothing matches these filters. Loosen one, or refresh postings.</div>';
  }

  // Nothing learned on any facet yet: rank by recency and say what is missing.
  // Ranking by a model that knows nothing would be ordering by noise while
  // implying it means something.
  if (!status.usable) {
    const note = status.rated
      ? 'You have rated ' + status.rated + ' posting' + (status.rated === 1 ? '' : 's') +
        ', but not yet enough on any single facet for it to predict. Salary and Location need only ' +
        'a couple each, because they fit a preference over numbers the library already holds. ' +
        'Until then this is newest first.'
      : 'Rate a few postings and these start ranking by predicted fit. Facets are independent, so ' +
        'rating just Salary and Location is already enough to order this list. ' +
        'Until then this is newest first.';
    const byDate = pinnedList(collapseDuplicates(scored)
      .sort((a, b) => daysAgo(a.job.postedAt) - daysAgo(b.job.postedAt)));
    return '<p class="notice">' + esc(note) + '</p>' + renderGrid(byDate.slice(0, 120), '');
  }

  const ranked = pinnedList(collapseDuplicates(scored)
    .sort((a, b) => b.fit.predicted - a.fit.predicted ||
                    b.fit.knownFacets.length - a.fit.knownFacets.length ||
                    a.job.title.localeCompare(b.job.title)));

  const live = status.live.map(f => FACET_LABELS[f].toLowerCase()).join(', ');
  const dormant = FACET_KEYS.filter(f => status.live.indexOf(f) === -1);
  const hint = dormant.length
    ? ' Nothing rated yet on ' + dormant.map(f => FACET_LABELS[f].toLowerCase()).join(', ') +
      ', so those do not count toward the ranking.'
    : '';
  return '<p class="notice">Ranked on ' + esc(live) + '.' + esc(hint) + '</p>' +
    renderGrid(ranked.slice(0, 120), '');
}

// Deliberately not the top of For You. The model learns most from the postings
// it is least sure about, so this surfaces the ones nearest the middle of the
// scale, spread across families so one lane cannot dominate the early ratings.
function viewRate() {
  const candidates = Object.values(state.jobs).filter(j => !hasAnyRating(j) && passesFilters(j));
  const scored = scoredList(candidates);
  const status = tasteStatus();
  const unique = collapseDuplicates(scored);
  if (status.usable) {
    unique.forEach(e => {
      e.uncertainty = Math.abs(e.fit.predicted - 3) - e.fit.knownFacets.length;
    });
    unique.sort((a, b) => a.uncertainty - b.uncertainty);
  } else {
    unique.sort((a, b) => daysAgo(a.job.postedAt) - daysAgo(b.job.postedAt));
  }
  const perFamily = new Map();
  const spread = [];
  unique.forEach(e => {
    const n = perFamily.get(e.job.family) || 0;
    if (n >= 3) return;
    perFamily.set(e.job.family, n + 1);
    spread.push(e);
  });
  const counts = FACET_KEYS.map(f => FACET_LABELS[f] + ' ' + status.perFacet[f]).join('  ·  ');
  const pinned = pinnedList(spread.slice(0, 30));
  return '<p class="notice">Rate these. They sit closest to the middle of the scale, so each rating ' +
    'teaches the most. Rate only the facets you can actually judge — a posting rated on Salary ' +
    'alone is still useful, and clicking a star you already set clears it. ' +
    'Ratings so far: ' + esc(counts) + '</p>' +
    renderGrid(pinned, 'No unrated postings under these filters.');
}

function viewRated() {
  const entries = scoredList(ratedJobs('').filter(job => passesFilters(job, 'rated')))
    .sort((a, b) => (b.job.ratedAt || '').localeCompare(a.job.ratedAt || ''));
  const dismissed = entries.filter(e => e.job.dismissed).length;
  return '<p class="notice">Every card predicts leave-one-out, per facet: the model is retrained ' +
    'without this posting, then asked to predict it. A facet you rated 5 that predicts low is the ' +
    'model telling you it has not learned why yet.' +
    (dismissed ? ' ' + dismissed + ' of these were dismissed with "not for me", which records 1 star ' +
      'on Role only, at ' + ROW_WEIGHT_DISMISSED + ' the weight of a star you chose.' : '') + '</p>' +
    renderGrid(entries, 'Nothing rated yet.');
}

function viewPool() {
  const entries = scoredList(Object.values(state.jobs).filter(passesFilters))
    .sort((a, b) => daysAgo(a.job.postedAt) - daysAgo(b.job.postedAt));
  return renderGrid(entries.slice(0, 200), 'Pool is empty — hit Refresh postings.');
}

function viewTagBrain() {
  const status = tasteStatus();
  if (!status.usable) {
    return '<div class="empty">Nothing learned yet. ' +
      (status.rated
        ? 'You have rated ' + status.rated + ' posting' + (status.rated === 1 ? '' : 's') +
          ', but no facet has enough behind it to predict.'
        : 'Rate a few postings first.') + '</div>';
  }
  const sections = FACET_KEYS.map(facet => {
    const model = getFacetModel(facet, '');
    const head = '<h3>' + esc(FACET_LABELS[facet]) + '</h3>';
    if (!model.evidenceCount) {
      return head + '<p class="muted">Nothing rated on this facet yet.</p>';
    }
    if (model.kind === 'residual' && (model.degenerate || model.evidenceCount < MIN_RATINGS_FOR_MODEL)) {
      return head + '<p class="muted">' + model.evidenceCount + ' rating' +
        (model.evidenceCount === 1 ? '' : 's') +
        (model.degenerate
          ? ', but all the same, so there is no difference for it to learn from.'
          : ', needs ' + MIN_RATINGS_FOR_MODEL + '.') + '</p>';
    }
    // The tag lane holds signed offsets already; categorical and ordinal facets
    // hold absolute 1-5 estimates. Both are shown against that facet's own
    // baseline so the column means the same thing on every table.
    const rows = Object.keys(model.effects).map(key => [
      key,
      model.kind === 'residual' ? model.effects[key] : model.effects[key] - model.baseline
    ]).filter(pair => Math.abs(pair[1]) > 0.004).sort((a, b) => b[1] - a[1]);
    if (!rows.length) return head + '<p class="muted">No separation learned yet.</p>';
    const shown = rows.length > 40 ? rows.slice(0, 30).concat(rows.slice(-10)) : rows;
    const body = shown.map(pair => {
      const label = pair[0].replace(/^(company|loc|region|family|seniority|pay):/, '');
      return '<tr><td>' + esc(label) + '</td><td class="w ' + (pair[1] > 0 ? 'pos' : 'neg') + '">' +
        (pair[1] > 0 ? '+' : '') + pair[1].toFixed(3) + '</td><td class="w">' +
        (tagFrequency().counts.get(pair[0]) || '—') + '</td></tr>';
    }).join('');
    return '<h3>' + esc(FACET_LABELS[facet]) + ' <span class="muted">' + model.evidenceCount +
      ' ratings · baseline ' + model.baseline.toFixed(2) + ' / 5</span></h3>' +
      '<table class="brain"><tr><th>feature</th><th>vs baseline</th><th>seen in</th></tr>' +
      body + '</table>';
  }).join('');
  return '<p class="muted">What each facet has learned, against that facet’s own baseline. ' +
    'This is the audit: if a weight here is wrong, the ranking is wrong for that reason.</p>' +
    sections;
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
  const rated = ratedJobs('').length;
  const parts = [jobs.length.toLocaleString() + ' postings', registry.length + ' companies', rated + ' rated'];
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
  const node = document.querySelector('[data-card="' + (window.CSS && CSS.escape ? CSS.escape(id) : id) + '"]');
  if (!job || !node) return false;
  const wrapper = document.createElement('div');
  wrapper.innerHTML = cardHtml(job, predictFit(job), Number(node.dataset.alsoIn || 0));
  const fresh = wrapper.firstElementChild;
  if (!fresh) return false;
  fresh.dataset.alsoIn = node.dataset.alsoIn || '0';
  node.replaceWith(fresh);
  return true;
}

async function rateFacet(id, facet, rating) {
  const job = state.jobs[id];
  if (!job || FACET_KEYS.indexOf(facet) === -1) return;
  job.ratings = job.ratings || { role: 0, level: 0, company: 0, location: 0, salary: 0 };
  // Clicking the star already set clears it, so a mis-click is one click to undo.
  job.ratings[facet] = job.ratings[facet] === rating ? 0 : rating;
  job.ratedAt = hasAnyRating(job) ? new Date().toISOString() : '';
  // A deliberate facet rating outranks a one-click dismissal: the posting comes
  // back into view at full weight, because you have now actually looked at it.
  if (job.ratings[facet]) { job.dismissed = false; job.hidden = false; }
  invalidateTaste();
  // Redraw first, persist after: an IndexedDB write is not something a star
  // click should wait on.
  if (!refreshCard(id)) render();
  renderHeadline();
  await saveJobs([job]);
}

// Teaches AND hides. It records a 1 on ROLE only, not on all five: "not for me"
// on a card you barely read is a judgement about the kind of work, and claiming
// it also means "this company is bad" or "this salary is bad" would invent
// opinions from one click -- expensive, since a company blacklisted by three
// glances is hard to notice and harder to undo. Say more by rating a facet.
async function dismissJob(id) {
  const job = state.jobs[id];
  if (!job) return;
  job.ratings = job.ratings || { role: 0, level: 0, company: 0, location: 0, salary: 0 };
  job.ratings.role = DISMISSAL_RATING;
  job.ratedAt = new Date().toISOString();
  job.dismissed = true;
  job.hidden = true;
  await saveJobs([job]);
  invalidateTaste();
  render();
}

async function restoreJob(id) {
  const job = state.jobs[id];
  if (!job) return;
  job.ratings = { role: 0, level: 0, company: 0, location: 0, salary: 0 };
  job.ratedAt = '';
  job.dismissed = false;
  job.hidden = false;
  await saveJobs([job]);
  invalidateTaste();
  render();
}

document.addEventListener('click', async event => {
  const target = event.target.closest('[data-rate],[data-clear],[data-hide],[data-restore],.tab,.chip');
  if (!target) return;
  if (target.classList.contains('tab')) {
    state.view = target.dataset.view;
    repinOrder();
    render();
  } else if (target.dataset.rate) {
    await rateFacet(target.dataset.id, target.dataset.facet, Number(target.dataset.rate));
  } else if (target.dataset.clear) {
    await restoreJob(target.dataset.clear);
  } else if (target.dataset.hide) {
    await dismissJob(target.dataset.hide);
  } else if (target.dataset.restore) {
    await restoreJob(target.dataset.restore);
  } else if (target.classList.contains('chip')) {
    $('#fText').value = state.filters.text = target.dataset.tag.replace(/^[a-z]+:/, '');
    render();
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

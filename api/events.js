/**
 * /api/events – Smart Reenio event fetcher
 *
 * SETUP (one-time):
 *   1. Go to reenio.com/en/admin/#/settings/api
 *   2. Generate API key
 *   3. In Vercel dashboard → project → Settings → Environment Variables:
 *      REENIO_API_KEY = <your key>
 *      REENIO_SYSTEM  = lets-beach   (your subdomain)
 *
 * How it works:
 *   Tries the official Reenio REST API, auto-discovers which endpoint works,
 *   then applies multi-layer filtering to return only real public group events.
 *   Falls back to safe placeholder data if API is unavailable.
 */

// ─── CONFIG ──────────────────────────────────────────────────────────────────

const API_KEY    = process.env.REENIO_API_KEY;
const SYSTEM     = process.env.REENIO_SYSTEM || 'lets-beach';
const BASE       = 'https://reenio.com/en/api/v1/admin';
const MAX_EVENTS = 5;

// Cache results for 10 minutes (avoid hammering the API)
const CACHE_TTL = 600;

// ─── FILTERING RULES ─────────────────────────────────────────────────────────

/**
 * Patterns that EXCLUDE an event (private/custom slots).
 * Be conservative – only exclude if clearly private.
 */
const EXCLUDE_PATTERNS = [
  /\bfor\s+you\b/i,
  /\bfor\s+me\b/i,
  /organized.*training.*for/i,
  /training.*for\s+you/i,
  /soukrom/i,           // Czech for "private"
  /\bprivate\b/i,
  /\bindividual\s+slot\b/i,
];

/**
 * Minimum required fields for an event to be considered valid.
 * Prevents showing half-formed or corrupted data.
 */
function isValidEvent(raw) {
  if (!raw || typeof raw !== 'object') return false;
  // Must have some kind of name
  const name = extractName(raw);
  if (!name || name.length < 2 || name.length > 120) return false;
  // Must have some kind of date
  const date = extractDate(raw);
  if (!date) return false;
  // Must be in the future (within 1 year)
  const ts = new Date(date).getTime();
  const now = Date.now();
  if (isNaN(ts)) return false;
  if (ts < now - 3600000) return false;          // more than 1h in the past → skip
  if (ts > now + 365 * 24 * 3600000) return false; // more than 1 year ahead → suspicious
  // Must not match private patterns
  if (EXCLUDE_PATTERNS.some(p => p.test(name))) return false;
  return true;
}

// ─── DATA EXTRACTION (handles different Reenio API response shapes) ──────────

function extractName(raw) {
  return raw.name
    || raw.title
    || raw.service_name
    || raw.service?.name
    || raw.event_name
    || null;
}

function extractDate(raw) {
  return raw.starts_at
    || raw.start
    || raw.date
    || raw.start_date
    || raw.datetime
    || raw.from
    || null;
}

function extractEndDate(raw) {
  return raw.ends_at || raw.end || raw.end_date || raw.to || null;
}

function extractPrice(raw) {
  const p = raw.price ?? raw.price_amount ?? raw.amount ?? null;
  if (p === null || p === undefined) return null;
  const num = parseFloat(p);
  if (isNaN(num) || num === 0) return null;
  return `CZK ${Math.round(num)}`;
}

function extractSpots(raw) {
  return raw.capacity_remaining
    ?? raw.spots_remaining
    ?? raw.available_capacity
    ?? raw.free_capacity
    ?? raw.remaining
    ?? null;
}

function extractTag(raw) {
  const name = extractName(raw) || '';
  if (/camp|kemp/i.test(name)) return 'Camp · Prague';
  if (/workshop/i.test(name)) return 'Workshop · Prague';
  if (/surf/i.test(name)) return 'Trip · Sea';
  if (/tournament|turnaj|štvanic|open/i.test(name)) return 'Tournament · Prague';
  return 'Group · Prague';
}

/**
 * Format a raw event into a clean, consistent shape for the frontend.
 */
function normalise(raw) {
  const dateStr = extractDate(raw);
  const date = new Date(dateStr);
  const endDate = extractEndDate(raw);

  const dateLabel = date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  const dayLabel  = date.toLocaleDateString('en-GB', { weekday: 'short' });
  const timeLabel = date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  const endLabel  = endDate
    ? new Date(endDate).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
    : null;

  const price  = extractPrice(raw);
  const spots  = extractSpots(raw);
  const metaParts = [
    timeLabel + (endLabel ? ` – ${endLabel}` : ''),
    price,
    spots != null ? `${spots} spots` : null,
  ].filter(Boolean);

  return {
    id:      raw.id || raw.uuid || Math.random().toString(36).slice(2),
    name:    extractName(raw),
    date:    dateLabel,
    day:     dayLabel,
    meta:    metaParts.join(' · '),
    tag:     extractTag(raw),
    bookUrl: `https://lets-beach.reenio.com`,
  };
}

/**
 * Deduplicate recurring events – keep only the NEXT occurrence of each event name.
 * e.g. "Wake up and Let's Beach" appears every weekday – show it just once.
 */
function deduplicateRecurring(events) {
  const seen = new Map();
  // Events are already sorted ascending by date from the API
  return events.filter(e => {
    const key = (e.name || '').trim().toLowerCase();
    if (seen.has(key)) return false;
    seen.set(key, true);
    return true;
  });
}

// ─── REENIO API STRATEGIES ───────────────────────────────────────────────────

const today   = new Date().toISOString().split('T')[0];
const in90    = new Date(Date.now() + 90 * 86400000).toISOString().split('T')[0];

const ENDPOINTS = [
  // Different API endpoint guesses – we try them in order
  `${BASE}/terms?from=${today}&to=${in90}&limit=50`,
  `${BASE}/schedule?from=${today}&to=${in90}&limit=50`,
  `${BASE}/events?from=${today}&to=${in90}&limit=50`,
  `${BASE}/reservations?from=${today}&to=${in90}&limit=50`,
  `${BASE}/services/upcoming?limit=50`,
];

async function fetchReenioEvents() {
  const headers = {
    'Authorization': `Bearer ${API_KEY}`,
    'Content-Type': 'application/json',
    'Accept': 'application/json',
  };

  for (const url of ENDPOINTS) {
    try {
      const res = await fetch(url, { headers });
      if (!res.ok) continue; // try next endpoint

      const json = await res.json();

      // Handle different response shapes: array, {data: []}, {items: []}, {results: []}
      const raw = Array.isArray(json)
        ? json
        : json.data ?? json.items ?? json.results ?? json.terms
          ?? json.events ?? json.schedule ?? null;

      if (!Array.isArray(raw) || raw.length === 0) continue;

      // Filter → normalise → deduplicate → limit
      const events = raw
        .filter(isValidEvent)
        .sort((a, b) => new Date(extractDate(a)) - new Date(extractDate(b)))
        .map(normalise)
        .filter(e => e.name); // final sanity check

      const deduped = deduplicateRecurring(events).slice(0, MAX_EVENTS);

      if (deduped.length > 0) {
        return { events: deduped, source: 'reenio', endpoint: url };
      }
    } catch {
      continue; // try next endpoint
    }
  }

  return null; // all endpoints failed
}

// ─── HANDLER ─────────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', `s-maxage=${CACHE_TTL}, stale-while-revalidate=60`);

  // No API key → return placeholder immediately
  if (!API_KEY) {
    return res.status(200).json({
      events: PLACEHOLDER,
      source: 'placeholder',
      note: 'Set REENIO_API_KEY env var in Vercel to enable live events.',
    });
  }

  try {
    const result = await fetchReenioEvents();
    if (result) {
      return res.status(200).json(result);
    }
    // API returned no valid events → safe fallback
    return res.status(200).json({ events: PLACEHOLDER, source: 'placeholder' });
  } catch (err) {
    console.error('events API error:', err.message);
    return res.status(200).json({ events: PLACEHOLDER, source: 'placeholder' });
  }
}

// ─── PLACEHOLDER DATA ────────────────────────────────────────────────────────

const PLACEHOLDER = [
  {
    id: 'p1', name: 'Wake up and Let\'s Beach',
    date: 'Daily', day: 'Mon–Sat',
    meta: '7:00 – 8:30 AM · CZK 240 · 8 spots',
    tag: 'Group · Prague', bookUrl: 'https://lets-beach.reenio.com',
  },
  {
    id: 'p2', name: 'Baden Baden Štvanice',
    date: '7 Jun', day: 'Sun',
    meta: '10:00 – 12:00 · 8 spots',
    tag: 'Tournament · Prague', bookUrl: 'https://lets-beach.reenio.com',
  },
  {
    id: 'p3', name: 'Summer Beach Camp',
    date: 'Summer', day: '2025',
    meta: '5–7 days · max. 8 players',
    tag: 'Camp · Prague', bookUrl: 'https://lets-beach.reenio.com',
  },
  {
    id: 'p4', name: 'Surf & Beach Trip',
    date: '2025', day: 'Sea',
    meta: '7–10 days · small group',
    tag: 'Trip · Sea', bookUrl: 'https://lets-beach.reenio.com',
  },
  {
    id: 'p5', name: 'Beach Weekend Workshop',
    date: 'Weekend', day: 'Sat+Sun',
    meta: 'max. 6 players · technique focus',
    tag: 'Workshop · Prague', bookUrl: 'https://lets-beach.reenio.com',
  },
];

/**
 * /api/events – Smart Reenio event scraper (no API key needed)
 *
 * Caching strategy:
 *   - CDN (Vercel Edge): s-maxage=86400 → cached 24h across all users
 *   - In-memory module cache: 23h fallback for warm function containers
 *   → Reenio is called at most once per day per region
 *
 * Filtering logic (reliable):
 *   - reservationType === 1  →  ALWAYS private (individual booking slot) → exclude
 *   - reservationType === 2  →  group/public event → include
 *   - maxCapacity === 1       →  extra safety → exclude
 *
 * Deduplication:
 *   - Dedup only on (id + start) to prevent the same slot appearing twice
 *   - Same name, different date/time = different events → all shown
 *   - e.g. "Wake up and Let's Beach" Mon + Tue + Wed = 3 separate rows ✓
 */

const REENIO_BASE  = 'https://lets-beach.reenio.com/en/api/Term';
const MAX_EVENTS   = 5;
const TZ           = 'Europe/Prague';

// ─── IN-MEMORY CACHE (survives warm container restarts within ~hours) ────────
let _cache     = null;
let _cacheTime = 0;
const CACHE_TTL_MS = 23 * 60 * 60 * 1000; // 23 hours

// ─── MAIN HANDLER ────────────────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  // CDN caches for 24h; stale for another hour while revalidating in background
  res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate=3600');

  // Serve from in-memory cache if fresh
  if (_cache && Date.now() - _cacheTime < CACHE_TTL_MS) {
    return res.status(200).json({ events: _cache, source: 'reenio-live', cached: true });
  }

  try {
    const events = await fetchAndFilter();
    _cache     = events;
    _cacheTime = Date.now();
    return res.status(200).json({ events, source: 'reenio-live' });
  } catch (err) {
    console.error('Reenio scrape error:', err.message);
    // Return stale cache if available, otherwise placeholder
    const fallback = _cache || PLACEHOLDER;
    return res.status(200).json({ events: fallback, source: _cache ? 'reenio-stale' : 'placeholder' });
  }
}

// ─── FETCH + FILTER ───────────────────────────────────────────────────────────

async function fetchAndFilter() {
  const now    = new Date();
  const allRaw = [];

  // Reenio returns ~3 days per request (current day view).
  // Strategy: daily for first 14 days (catches all near-future slots),
  // then weekly for days 14-56 (catches camps/special events further out).
  // All fired in parallel → ~200ms total.
  const dates = new Set();
  for (let d = 0; d < 14; d++) {           // daily: next 2 weeks
    const dt = new Date(now.getTime() + d * 86400000);
    dates.add(dt.toISOString().split('T')[0]);
  }
  for (let w = 2; w < 8; w++) {            // weekly: weeks 3-8
    const dt = new Date(now.getTime() + w * 7 * 86400000);
    dates.add(dt.toISOString().split('T')[0]);
  }
  const requests = Array.from(dates).map(dateStr => ({
    dateStr,
    endMonthStr: dateStr.slice(0, 7),       // YYYY-MM
  }));

  // Fire all requests in parallel (faster, ~200ms total vs 200ms×8)
  const results = await Promise.allSettled(
    requests.map(({ dateStr, endMonthStr }) =>
      fetch(`${REENIO_BASE}/List`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Accept': 'application/json',
          'X-Requested-With': 'XMLHttpRequest',
          'User-Agent': 'Mozilla/5.0',
        },
        body: new URLSearchParams({ date: dateStr, endDate: endMonthStr }).toString(),
      }).then(r => r.ok ? r.json() : null)
    )
  );

  for (const r of results) {
    if (r.status === 'fulfilled' && r.value?.data?.events) {
      allRaw.push(...r.value.data.events);
    }
  }

  if (allRaw.length === 0) throw new Error('No data returned from Reenio');

  // ── FILTER ──
  const publicEvents = allRaw.filter(e => {
    if (!e || typeof e !== 'object') return false;
    // Key rule: reservationType 1 = private individual slot
    if (e.reservationType === 1) return false;
    // Extra safety: maxCapacity of 1 = individual
    if (e.maxCapacity === 1) return false;
    // Must have a valid future start time
    if (!e.start) return false;
    const start = new Date(e.start);
    if (isNaN(start.getTime())) return false;
    if (start < new Date(Date.now() - 3600000)) return false; // exclude past (1h grace)
    // Must have some displayable info
    const name = getEventName(e);
    if (!name || name.length < 2) return false;
    // Final check: name-based exclusion as extra safety net
    if (/\bfor\s+you\b|\bfor\s+me\b|soukrom/i.test(name)) return false;
    return true;
  });

  // ── SORT by date ascending ──
  publicEvents.sort((a, b) => new Date(a.start) - new Date(b.start));

  // ── DEDUPLICATE only exact same slot (id + start) ──
  // Same name, different date/time = keep all (e.g. Wake up Mon + Tue + Wed)
  // Same id + same start = API returned duplicate entry → remove
  const seenSlots = new Set();
  const deduped   = [];

  for (const e of publicEvents) {
    const slotKey = `${e.id}::${e.start}`;
    if (seenSlots.has(slotKey)) continue;
    seenSlots.add(slotKey);
    deduped.push(e);
    if (deduped.length >= MAX_EVENTS) break;
  }

  // ── NORMALISE ──
  return deduped.map(normalise);
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────

function getEventName(e) {
  // eventResources[0].name is the primary name
  const resName = e.eventResources?.[0]?.name;
  if (resName && resName.trim().length > 1) return resName.trim();
  // Fallback: place name
  const placeName = e.eventResources?.[0]?.place?.name;
  if (placeName && placeName.trim().length > 1) return placeName.trim();
  // Fallback: service name
  const svcName = e.eventResources?.[0]?.service?.name;
  if (svcName && svcName.trim().length > 1) return svcName.trim();
  return '';
}

function getTag(e) {
  const name  = getEventName(e).toLowerCase();
  const place = (e.eventResources?.[0]?.place?.name || '').toLowerCase();
  const svc   = (e.eventResources?.[0]?.service?.name || '').toLowerCase();
  const all   = `${name} ${place} ${svc}`;
  if (/camp|kemp/i.test(all))        return 'Camp · Prague';
  if (/workshop/i.test(all))         return 'Workshop · Prague';
  if (/surf/i.test(all))             return 'Trip · Sea';
  if (/tournament|turnaj|open/i.test(all)) return 'Tournament · Prague';
  if (/king/i.test(all))             return 'King of the Beach';
  if (/afternoon/i.test(svc))        return 'Afternoon · Prague';
  return 'Group · Prague';
}

function normalise(e) {
  const start = new Date(e.start);
  const end   = e.end ? new Date(e.end) : null;

  const dateLabel = start.toLocaleDateString('en-GB', { timeZone: TZ, day: 'numeric', month: 'short' });
  const dayLabel  = start.toLocaleDateString('en-GB', { timeZone: TZ, weekday: 'short' });
  const timeStart = start.toLocaleTimeString('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
  const timeEnd   = end ? end.toLocaleTimeString('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit' }) : null;

  const reserved = Array.isArray(e.reservations) ? e.reservations.length : (e.reservations || 0);
  const capacity = e.maxCapacity || null;
  const remaining = capacity !== null ? capacity - reserved : null;

  const metaParts = [
    timeStart + (timeEnd ? ` – ${timeEnd}` : ''),
    remaining !== null ? `${remaining} spots` : null,
  ].filter(Boolean);

  return {
    id:      String(e.id),
    name:    getEventName(e),
    date:    dateLabel,
    day:     dayLabel,
    meta:    metaParts.join(' · '),
    tag:     getTag(e),
    color:   e.color || null,
    bookUrl: 'https://lets-beach.reenio.com',
  };
}

// ─── PLACEHOLDER (shown if Reenio is unreachable) ────────────────────────────

const PLACEHOLDER = [
  { id:'p1', name:"Wake up and Let's Beach", date:'Daily', day:'Mon–Sat',
    meta:'7:00 – 8:30 AM · 8 spots', tag:'Group · Prague', bookUrl:'https://lets-beach.reenio.com' },
  { id:'p2', name:"Good Afternoon Let's Beach", date:'Daily', day:'Mon–Sat',
    meta:'3:00 – 5:00 PM · 8 spots', tag:'Afternoon · Prague', bookUrl:'https://lets-beach.reenio.com' },
  { id:'p3', name:"King of Let's Beach", date:'Daily', day:'Mon–Sat',
    meta:'6:00 – 10:00 PM · 12 spots', tag:'King of the Beach', bookUrl:'https://lets-beach.reenio.com' },
  { id:'p4', name:'Summer Beach Camp', date:'Summer', day:'2025',
    meta:'5–7 days · max. 8 players', tag:'Camp · Prague', bookUrl:'https://lets-beach.reenio.com' },
  { id:'p5', name:'Beach Weekend Workshop', date:'Weekend', day:'Sat+Sun',
    meta:'max. 6 players', tag:'Workshop · Prague', bookUrl:'https://lets-beach.reenio.com' },
];

/**
 * /api/events – Smart Reenio event scraper (no API key needed)
 *
 * How it works:
 *   Calls Reenio's internal public API (the same endpoint the booking page uses),
 *   then applies smart filtering to return only real public group events.
 *
 * Filtering logic (reliable):
 *   - reservationType === 1  →  ALWAYS private (individual booking slot) → exclude
 *   - reservationType === 2  →  group/public event → include
 *   - maxCapacity === 1       →  extra safety: individual slot → exclude
 *   - Deduplicates recurring: same event ID may repeat daily/weekly → show once (next occurrence)
 *
 * No dependencies. No API key. Works out of the box.
 */

const REENIO_BASE = 'https://lets-beach.reenio.com/en/api/Term';
const MAX_EVENTS  = 5;
const MONTHS_AHEAD = 3; // look 3 months forward

// Prague is UTC+1/UTC+2. Use 'Europe/Prague' for display.
const TZ = 'Europe/Prague';

// ─── MAIN HANDLER ────────────────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=60');

  try {
    const events = await fetchAndFilter();
    return res.status(200).json({ events, source: 'reenio-live' });
  } catch (err) {
    console.error('Reenio scrape error:', err.message);
    return res.status(200).json({ events: PLACEHOLDER, source: 'placeholder' });
  }
}

// ─── FETCH + FILTER ───────────────────────────────────────────────────────────

async function fetchAndFilter() {
  const now   = new Date();
  const allRaw = [];

  // Fetch 3 months of data (one request per month)
  for (let m = 0; m < MONTHS_AHEAD; m++) {
    const d = new Date(now.getFullYear(), now.getMonth() + m, m === 0 ? now.getDate() : 1);
    const dateStr     = d.toISOString().split('T')[0];              // YYYY-MM-DD
    const endMonthStr = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`; // YYYY-MM

    const body = new URLSearchParams({ date: dateStr, endDate: endMonthStr });

    const resp = await fetch(`${REENIO_BASE}/List`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
        'User-Agent': 'Mozilla/5.0',
      },
      body: body.toString(),
    });

    if (!resp.ok) continue;
    const json = await resp.json();
    const events = json?.data?.events;
    if (Array.isArray(events)) allRaw.push(...events);
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

  // ── SORT by date ──
  publicEvents.sort((a, b) => new Date(a.start) - new Date(b.start));

  // ── DEDUPLICATE recurring events ──
  // Same event ID repeats daily/weekly → keep only next occurrence
  const seenIds  = new Set();
  const seenNames = new Set();
  const deduped  = [];

  for (const e of publicEvents) {
    const name = getEventName(e).trim().toLowerCase();
    // Use event ID for dedup (same recurring template)
    if (seenIds.has(e.id)) continue;
    // Also dedup by name (different IDs but same event type)
    if (seenNames.has(name)) continue;
    seenIds.add(e.id);
    seenNames.add(name);
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

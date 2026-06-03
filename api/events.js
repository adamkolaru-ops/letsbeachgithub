/**
 * Vercel Serverless Function – /api/events
 * Fetches upcoming public events from Reenio API (Premium)
 *
 * SETUP:
 * 1. Go to: https://reenio.com/en/admin/#/settings/api
 * 2. Generate API key
 * 3. Add to Vercel environment variables:
 *    REENIO_API_KEY=your_key_here
 *    REENIO_SYSTEM_ID=lets-beach  (your Reenio subdomain)
 *
 * Once set up, the homepage will automatically show live events from Reenio.
 */

const REENIO_API_KEY = process.env.REENIO_API_KEY;
const REENIO_SYSTEM_ID = process.env.REENIO_SYSTEM_ID || 'lets-beach';

// Events to exclude (private/custom slots)
const PRIVATE_KEYWORDS = ['for you', 'organized training'];

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=300'); // cache 5 min

  // If no API key yet, return placeholder data
  if (!REENIO_API_KEY) {
    return res.status(200).json({ events: PLACEHOLDER_EVENTS, source: 'placeholder' });
  }

  try {
    const today = new Date().toISOString().split('T')[0];
    const future = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

    const response = await fetch(
      `https://reenio.com/en/api/v1/admin/reservations?from=${today}&to=${future}`,
      {
        headers: {
          'Authorization': `Bearer ${REENIO_API_KEY}`,
          'Content-Type': 'application/json',
        }
      }
    );

    if (!response.ok) {
      throw new Error(`Reenio API error: ${response.status}`);
    }

    const data = await response.json();

    // Filter out private slots
    const publicEvents = (data.reservations || data.items || data || [])
      .filter(event => {
        const name = (event.name || event.title || event.service_name || '').toLowerCase();
        return !PRIVATE_KEYWORDS.some(kw => name.includes(kw));
      })
      .slice(0, 5)
      .map(event => ({
        id: event.id,
        name: event.name || event.title || event.service_name,
        date: event.starts_at || event.date,
        end: event.ends_at || event.end,
        price: event.price,
        spots: event.capacity_remaining || event.spots_remaining,
        tag: event.category || 'Event',
        bookUrl: `https://lets-beach.reenio.com`,
      }));

    return res.status(200).json({ events: publicEvents, source: 'reenio' });

  } catch (error) {
    console.error('Reenio API error:', error);
    // Fallback to placeholder on error
    return res.status(200).json({ events: PLACEHOLDER_EVENTS, source: 'placeholder' });
  }
}

// Placeholder events shown until API key is configured
const PLACEHOLDER_EVENTS = [
  {
    id: 'p1',
    name: 'Wake up and Let\'s Beach',
    date: 'Daily Mon–Sat',
    end: '8:30 AM',
    price: 'CZK 240',
    spots: 8,
    tag: 'Group · Prague',
    bookUrl: 'https://lets-beach.reenio.com',
  },
  {
    id: 'p2',
    name: 'Summer Beach Camp',
    date: 'Summer 2025',
    price: null,
    spots: 8,
    tag: 'Camp · Prague',
    bookUrl: 'https://lets-beach.reenio.com',
  },
  {
    id: 'p3',
    name: 'Beach Weekend Workshop',
    date: 'Weekend',
    price: null,
    spots: 6,
    tag: 'Workshop · Prague',
    bookUrl: 'https://lets-beach.reenio.com',
  },
];

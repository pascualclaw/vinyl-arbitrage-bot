import { VinylListing, DiscogsMarketListing } from '../types.js';

const DISCOGS_API_BASE = 'https://api.discogs.com';
const DISCOGS_TOKEN = process.env.DISCOGS_TOKEN || '';
const MIN_PRICE = Number(process.env.MIN_LISTING_PRICE ?? 25);

// Genres to monitor
const TARGET_GENRES = ['Jazz', 'Hip Hop', 'Rock', 'Soul', 'Funk / Soul', 'R&B'];

// Simple delay helper for rate limiting
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function discogsGet(path: string): Promise<unknown> {
  // Enforce ~55 requests/min pacing with a simple delay between calls
  const url = `${DISCOGS_API_BASE}${path}`;
  const res = await fetch(url, {
    headers: {
      'Authorization': `Discogs token=${DISCOGS_TOKEN}`,
      'User-Agent': 'VinylArbitrageBot/1.0 +https://github.com/pascualclaw/vinyl-arbitrage-bot',
    },
  });

  if (res.status === 429) {
    console.warn('[discogs-market] Rate limited — waiting 10s');
    await sleep(10_000);
    return discogsGet(path); // retry once
  }

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Discogs API ${res.status}: ${body.slice(0, 200)}`);
  }

  return res.json();
}

async function pollGenre(genre: string): Promise<DiscogsMarketListing[]> {
  const params = new URLSearchParams({
    format: 'Vinyl',
    genre,
    country: 'United States',
    currency: 'USD',
    status: 'For Sale',
    sort: 'listed,desc',
    per_page: '50',
    page: '1',
  });

  try {
    const data = await discogsGet(`/marketplace/search?${params.toString()}`) as any;
    const listings: DiscogsMarketListing[] = data.listings ?? [];
    await sleep(1_200); // pace between genre calls
    return listings;
  } catch (err) {
    console.error(`[discogs-market] Error polling genre "${genre}":`, err);
    return [];
  }
}

/**
 * Poll Discogs marketplace for new vinyl listings across target genres.
 * Returns listings that pass basic filters (US seller, price, format).
 */
export async function pollDiscogs(): Promise<VinylListing[]> {
  if (!DISCOGS_TOKEN) {
    console.warn('[discogs-market] DISCOGS_TOKEN not set — skipping Discogs poll');
    return [];
  }

  const allListings: DiscogsMarketListing[] = [];

  for (const genre of TARGET_GENRES) {
    const listings = await pollGenre(genre);
    console.log(`[discogs-market] Genre "${genre}": ${listings.length} raw listings`);
    allListings.push(...listings);
  }

  // Deduplicate by listing ID across genres
  const seen = new Set<number>();
  const unique = allListings.filter(l => {
    if (seen.has(l.id)) return false;
    seen.add(l.id);
    return true;
  });

  console.log(`[discogs-market] ${unique.length} unique listings before price filter`);

  const results: VinylListing[] = [];

  for (const listing of unique) {
    // Price filter (USD)
    const price = listing.price?.value ?? 0;
    if (price < MIN_PRICE) continue;

    // Shipping (assume $5 if not provided)
    const shipping = listing.shipping_price?.value ?? 5;
    const totalCost = price + shipping;

    // Seller info
    const sellerUsername = listing.seller?.username ?? 'unknown';
    const feedbackRating = listing.seller?.stats?.rating
      ? parseFloat(listing.seller.stats.rating)
      : undefined;
    const feedbackCount = listing.seller?.stats?.total;

    // Release metadata
    const release = listing.release;
    const releaseId = String(release.id);

    // Determine genre from release
    const genre = release.genres?.[0];

    // Parse artist/title from description (format: "Artist - Title")
    let artist: string | undefined;
    let album: string | undefined;
    const desc = release.description ?? listing.release.description ?? '';
    const dashIdx = desc.indexOf(' - ');
    if (dashIdx > 0) {
      artist = desc.slice(0, dashIdx).trim();
      album = desc.slice(dashIdx + 3).trim();
    }

    results.push({
      source: 'discogs',
      listingId: String(listing.id),
      url: `https://www.discogs.com${listing.uri}`,
      title: desc,
      artist,
      album,
      year: release.year,
      label: release.labels?.[0]?.name,
      condition: listing.condition ?? 'Unknown',
      price,
      shipping,
      totalCost,
      sellerUsername,
      sellerFeedbackPercent: feedbackRating,
      sellerFeedbackCount: feedbackCount,
      releaseId,
      genre,
    });
  }

  console.log(`[discogs-market] ${results.length} listings passed price filter`);
  return results;
}

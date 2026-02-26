/**
 * Discogs marketplace source.
 *
 * Reads from data/watchlist.json (built by watchlist/builder.ts).
 * For each release in the watchlist, checks current marketplace listings
 * for cheap copies. processListing() in index.ts handles spread/threshold.
 */

import { VinylListing } from '../types.js';
import { loadWatchlist } from '../watchlist/builder.js';

const DISCOGS_TOKEN = process.env.DISCOGS_TOKEN!;
const MIN_LISTING_PRICE = parseFloat(process.env.MIN_LISTING_PRICE ?? '25');
const BASE = 'https://api.discogs.com';

// How many releases to check per poll cycle (rotate through the watchlist)
// Full watchlist might be 1000+ releases — don't check all every 25min
// Instead check a rotating window so every release gets checked ~every few hours
const RELEASES_PER_CYCLE = 150;

let watchlistOffset = 0;

function sleep(ms: number) {
  return new Promise(r => setTimeout(r, ms));
}

async function discogsGet(path: string): Promise<any> {
  const url = path.startsWith('http') ? path : `${BASE}${path}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Discogs token=${DISCOGS_TOKEN}`,
      'User-Agent': 'VinylArbitrageBot/1.0 +https://github.com/pascualclaw/vinyl-arbitrage-bot',
    },
  });
  if (res.status === 429) {
    console.warn('[discogs-market] Rate limited — waiting 12s');
    await sleep(12_000);
    return discogsGet(path);
  }
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Discogs API ${res.status}: ${body.slice(0, 120)}`);
  }
  return res.json();
}

/** Get current cheap marketplace listings for a release (US sellers, sorted by price asc). */
async function getListingsForRelease(releaseId: number): Promise<VinylListing[]> {
  const params = new URLSearchParams({
    status: 'For Sale',
    ships_from: 'United States',
    sort: 'price',
    sort_order: 'asc',
    per_page: '10',
    page: '1',
  });

  const data = await discogsGet(`/releases/${releaseId}/marketplace/listings?${params}`);
  const raw = data.listings ?? [];
  const results: VinylListing[] = [];

  for (const l of raw) {
    const price = parseFloat(l.price?.value ?? '0');
    const shipping = parseFloat(l.shipping_price?.value ?? '5');
    const totalCost = price + shipping;
    const feedbackRaw = parseFloat(l.seller?.stats?.rating ?? '0');
    const feedbackPct = feedbackRaw * 100;

    if (price < MIN_LISTING_PRICE) continue;
    if (feedbackPct < 95) continue;

    results.push({
      source: 'discogs',
      listingId: String(l.id),
      url: `https://www.discogs.com/sell/item/${l.id}`,
      title: l.release?.description ?? 'Unknown',
      artist: l.release?.artist ?? undefined,
      album: l.release?.title ?? undefined,
      year: l.release?.year ?? undefined,
      label: l.release?.labels?.[0]?.name ?? undefined,
      condition: l.condition ?? 'Unknown',
      price,
      shipping,
      totalCost,
      sellerUsername: l.seller?.username ?? 'Unknown',
      sellerFeedbackPercent: feedbackPct,
      sellerFeedbackCount: l.seller?.stats?.total ?? 0,
      releaseId: String(releaseId),
    });
  }

  return results;
}

/**
 * Poll a rotating window of the watchlist for underpriced listings.
 * Each poll cycle covers RELEASES_PER_CYCLE releases, rotating through the full list.
 */
export async function pollDiscogs(): Promise<VinylListing[]> {
  const watchlist = loadWatchlist();

  if (!watchlist || watchlist.releases.length === 0) {
    console.log('[discogs-market] No watchlist yet — skipping (build in progress)');
    return [];
  }

  const total = watchlist.releases.length;
  const slice = watchlist.releases.slice(watchlistOffset, watchlistOffset + RELEASES_PER_CYCLE);

  // Advance offset for next cycle (wraps around)
  watchlistOffset = (watchlistOffset + RELEASES_PER_CYCLE) % total;

  console.log(
    `[discogs-market] Checking ${slice.length} releases ` +
    `(offset ${watchlistOffset - slice.length < 0 ? total + watchlistOffset - slice.length : watchlistOffset - slice.length}/${total}, ` +
    `full rotation every ~${Math.ceil(total / RELEASES_PER_CYCLE)} cycles)`
  );

  const results: VinylListing[] = [];

  for (const entry of slice) {
    try {
      const listings = await getListingsForRelease(entry.releaseId);
      await sleep(1_100);

      for (const l of listings) {
        results.push({ ...l, genre: entry.genre });
      }
    } catch {
      // non-fatal
    }
  }

  console.log(`[discogs-market] ${results.length} candidate listings from this cycle`);
  return results;
}

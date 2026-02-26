/**
 * Discogs marketplace source.
 *
 * Strategy: search the Discogs DATABASE for popular releases in target genres
 * (sorted by "most collected" = liquid market), then check each release's
 * current marketplace listings for cheap copies.
 *
 * processListing() in index.ts handles the spread/threshold checks.
 */

import { VinylListing } from '../types.js';

const DISCOGS_TOKEN = process.env.DISCOGS_TOKEN!;
const MIN_LISTING_PRICE = parseFloat(process.env.MIN_LISTING_PRICE ?? '25');
const BASE = 'https://api.discogs.com';

const TARGET_GENRES = ['Jazz', 'Hip Hop', 'Rock', 'Funk / Soul'];
const RELEASES_PER_GENRE = 12;

function sleep(ms: number) {
  return new Promise(r => setTimeout(r, ms));
}

async function discogsGet(path: string): Promise<any> {
  const url = path.startsWith('http') ? path : `${BASE}${path}`;
  const res = await fetch(url, {
    headers: {
      'Authorization': `Discogs token=${DISCOGS_TOKEN}`,
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

/** Search DB for popular releases in a genre. Returns release IDs. */
async function getPopularReleaseIds(genre: string): Promise<number[]> {
  const params = new URLSearchParams({
    genre,
    format: 'Vinyl',
    type: 'release',
    sort: 'have',
    sort_order: 'desc',
    per_page: String(RELEASES_PER_GENRE),
    page: '1',
  });

  const data = await discogsGet(`/database/search?${params}`);
  return (data.results ?? []).map((r: any) => Number(r.id)).filter(Boolean);
}

/** Get current marketplace listings for a release, US sellers only, sorted by price. */
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
    const feedbackRaw = l.seller?.stats?.rating;
    const feedbackPct = feedbackRaw ? parseFloat(feedbackRaw) * 100 : 0;

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
      genre: TARGET_GENRES[0], // will be overwritten per genre loop
    });
  }

  return results;
}

/** Main poll: find cheap Discogs listings across target genres. */
export async function pollDiscogs(): Promise<VinylListing[]> {
  const results: VinylListing[] = [];
  const seenListingIds = new Set<string>();

  for (const genre of TARGET_GENRES) {
    try {
      const releaseIds = await getPopularReleaseIds(genre);
      console.log(`[discogs-market] Genre "${genre}": scanning ${releaseIds.length} popular releases`);
      await sleep(1_100);

      for (const id of releaseIds) {
        try {
          const listings = await getListingsForRelease(id);
          await sleep(1_100);

          for (const l of listings) {
            if (seenListingIds.has(l.listingId)) continue;
            seenListingIds.add(l.listingId);
            results.push({ ...l, genre });
          }
        } catch {
          // non-fatal — skip this release
        }
      }
    } catch (err) {
      console.error(`[discogs-market] Error scanning genre "${genre}":`, err);
    }
  }

  console.log(`[discogs-market] ${results.length} candidate listings before spread filter`);
  return results;
}

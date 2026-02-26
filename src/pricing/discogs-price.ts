import { PriceStats } from '../types.js';

const DISCOGS_API_BASE = 'https://api.discogs.com';
const DISCOGS_TOKEN = process.env.DISCOGS_TOKEN || '';

// Discogs rate limit: 60 req/min (authenticated). We'll pace at 55/min to be safe.
// That's ~1 request per 1.09 seconds. We track a simple sliding window.
class RateLimiter {
  private queue: Array<() => void> = [];
  private requestTimes: number[] = [];
  private readonly maxPerMinute: number;
  private timer: NodeJS.Timeout | null = null;

  constructor(maxPerMinute: number = 55) {
    this.maxPerMinute = maxPerMinute;
  }

  async acquire(): Promise<void> {
    return new Promise((resolve) => {
      this.queue.push(resolve);
      this.pump();
    });
  }

  private pump(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      const now = Date.now();
      // Remove timestamps older than 60s
      this.requestTimes = this.requestTimes.filter(t => now - t < 60_000);
      while (this.queue.length > 0 && this.requestTimes.length < this.maxPerMinute) {
        const resolve = this.queue.shift()!;
        this.requestTimes.push(now);
        resolve();
      }
      if (this.queue.length === 0) {
        clearInterval(this.timer!);
        this.timer = null;
      }
    }, 200);
  }
}

const rateLimiter = new RateLimiter(55);

async function discogsGet(path: string): Promise<unknown> {
  await rateLimiter.acquire();
  const url = `${DISCOGS_API_BASE}${path}`;
  const res = await fetch(url, {
    headers: {
      'Authorization': `Discogs token=${DISCOGS_TOKEN}`,
      'User-Agent': 'VinylArbitrageBot/1.0 +https://github.com/pascualclaw/vinyl-arbitrage-bot',
    },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Discogs API error ${res.status}: ${body.slice(0, 200)}`);
  }

  return res.json();
}

/**
 * Fetch median sale price for a release from Discogs price guide / stats.
 * Uses /marketplace/stats/{release_id} which returns community price data.
 *
 * Note: The Discogs API /marketplace/stats endpoint returns community statistics
 * including lowest price and number for sale. For actual sale history (median),
 * we use the /marketplace/price_suggestions endpoint or parse from stats.
 * As of the current API, median_price is available via price_suggestions for
 * releases in the database.
 */
export async function getReleasePrice(releaseId: string): Promise<PriceStats | null> {
  try {
    // First get marketplace stats
    const stats = await discogsGet(`/marketplace/stats/${releaseId}`) as any;

    // The stats endpoint returns:
    // { lowest_price, num_for_sale, blocked_from_sale }
    // For median price we need price_suggestions (requires auth as a seller)
    // OR we can compute from the release's price history via undocumented endpoint.
    //
    // Best available: use /marketplace/price_suggestions/{release_id}
    // This returns suggested prices by condition (not historical median).
    //
    // Alternatively, the /releases/{id}/stats endpoint in the database API
    // returns community have/want counts but not sale prices.
    //
    // The actual sale history median is only available via:
    // GET /marketplace/stats/{release_id} — which does return median_price
    // when the user has it enabled in their account settings.
    //
    // We'll use a combination: stats for num_for_sale/lowest_price,
    // and price_suggestions for per-condition pricing as our "median proxy".

    if (stats.blocked_from_sale) {
      console.log(`[price] Release ${releaseId} is blocked from sale`);
      return null;
    }

    // Try to get price suggestions (proxy for median per condition)
    let medianPrice: number | null = null;
    let saleCount = 0;

    try {
      const suggestions = await discogsGet(`/marketplace/price_suggestions/${releaseId}`) as any;
      // Returns: { "Very Good Plus (VG+)": { currency, value }, ... }
      // We'll average VG and VG+ as a proxy for "typical" condition
      const conditionPrices: number[] = [];
      for (const [condition, data] of Object.entries(suggestions)) {
        if (typeof data === 'object' && data !== null && 'value' in data) {
          conditionPrices.push((data as any).value as number);
        }
      }
      if (conditionPrices.length > 0) {
        conditionPrices.sort((a, b) => a - b);
        const mid = Math.floor(conditionPrices.length / 2);
        medianPrice = conditionPrices[mid];
      }
    } catch (err) {
      // price_suggestions may 404 for some releases or require seller account
      console.log(`[price] price_suggestions unavailable for ${releaseId}, using lowest_price`);
    }

    // Fallback: use lowest_price * 1.5 as rough median estimate
    if (medianPrice === null && stats.lowest_price) {
      medianPrice = stats.lowest_price.value * 1.5;
    }

    if (medianPrice === null) {
      console.log(`[price] No price data for release ${releaseId}`);
      return null;
    }

    saleCount = stats.num_for_sale ?? 0;

    return {
      releaseId,
      median: medianPrice,
      saleCount,
      currency: stats.lowest_price?.currency ?? 'USD',
    };
  } catch (err) {
    console.error(`[price] Error fetching price for release ${releaseId}:`, err);
    return null;
  }
}

/**
 * Search Discogs database for a release by artist + album + optional year/label.
 * Returns the best matching release ID.
 */
export async function searchDiscogsRelease(
  artist: string,
  album: string,
  year?: number,
  label?: string
): Promise<string | null> {
  try {
    const params = new URLSearchParams({
      artist,
      release_title: album,
      type: 'release',
      format: 'vinyl',
      per_page: '5',
      page: '1',
    });
    if (year) params.set('year', String(year));
    if (label) params.set('label', label);

    const data = await discogsGet(`/database/search?${params.toString()}`) as any;
    const results = data.results ?? [];

    if (results.length === 0) {
      console.log(`[price] No Discogs results for "${artist} - ${album}"`);
      return null;
    }

    // Return the first (most relevant) result's ID
    return String(results[0].id);
  } catch (err) {
    console.error(`[price] Error searching Discogs for "${artist} - ${album}":`, err);
    return null;
  }
}

import { VinylListing, EbayTokenResponse, EbayItemSummary } from '../types.js';
import { parseEbayTitle } from '../matcher/claude-match.js';
import { searchDiscogsRelease } from '../pricing/discogs-price.js';

const EBAY_API_BASE = 'https://api.ebay.com';
const EBAY_CLIENT_ID = process.env.EBAY_CLIENT_ID || '';
const EBAY_CLIENT_SECRET = process.env.EBAY_CLIENT_SECRET || '';

// eBay vinyl/records category ID
const VINYL_CATEGORY_ID = '176985';
const MIN_PRICE = Number(process.env.MIN_LISTING_PRICE ?? 25);
const MIN_FEEDBACK = Number(process.env.EBAY_MIN_SELLER_FEEDBACK ?? 95);

interface TokenCache {
  token: string;
  expiresAt: number;
}

let tokenCache: TokenCache | null = null;

async function getEbayToken(): Promise<string> {
  if (tokenCache && Date.now() < tokenCache.expiresAt - 60_000) {
    return tokenCache.token;
  }

  const credentials = Buffer.from(`${EBAY_CLIENT_ID}:${EBAY_CLIENT_SECRET}`).toString('base64');
  const res = await fetch(`${EBAY_API_BASE}/identity/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials&scope=https%3A%2F%2Fapi.ebay.com%2Foauth%2Fapi_scope',
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`eBay OAuth error ${res.status}: ${body.slice(0, 200)}`);
  }

  const data = await res.json() as EbayTokenResponse;
  tokenCache = {
    token: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  };

  console.log('[ebay] OAuth token refreshed');
  return tokenCache.token;
}

function parseSeller(item: EbayItemSummary): {
  username: string;
  feedbackPercent: number;
  feedbackCount: number;
} | null {
  const pct = parseFloat(item.seller?.feedbackPercentage ?? '0');
  const count = item.seller?.feedbackScore ?? 0;
  const username = item.seller?.username ?? 'unknown';
  if (!username || username === 'unknown') return null;
  return { username, feedbackPercent: pct, feedbackCount: count };
}

function parseShipping(item: EbayItemSummary): number {
  if (!item.shippingOptions?.length) return 5; // default estimate
  const first = item.shippingOptions[0];
  if (!first.shippingCost) return 0; // free shipping
  const val = parseFloat(first.shippingCost.value ?? '0');
  return isNaN(val) ? 5 : val;
}

/**
 * Poll eBay BIN listings for vinyl records.
 * Returns listings that pass basic filters (US seller, price, BIN, feedback).
 * Each result has releaseId populated via Claude + Discogs search.
 */
export async function pollEbay(): Promise<VinylListing[]> {
  if (!EBAY_CLIENT_ID || !EBAY_CLIENT_SECRET) {
    console.warn('[ebay] EBAY_CLIENT_ID or EBAY_CLIENT_SECRET not set — skipping eBay poll');
    return [];
  }

  let token: string;
  try {
    token = await getEbayToken();
  } catch (err) {
    console.error('[ebay] Failed to get OAuth token:', err);
    return [];
  }

  // eBay Browse API search
  const params = new URLSearchParams({
    q: 'vinyl record LP',
    category_ids: VINYL_CATEGORY_ID,
    filter: [
      'buyingOptions:{FIXED_PRICE}',
      `price:[${MIN_PRICE}..5000]`,
      'priceCurrency:USD',
      'itemLocationCountry:US',
    ].join(','),
    sort: 'newlyListed',
    limit: '50',
    fieldgroups: 'EXTENDED',
  });

  let items: EbayItemSummary[] = [];
  try {
    const res = await fetch(
      `${EBAY_API_BASE}/buy/browse/v1/item_summary/search?${params.toString()}`,
      {
        headers: {
          'Authorization': `Bearer ${token}`,
          'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US',
          'Content-Type': 'application/json',
        },
      }
    );

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`eBay Browse API error ${res.status}: ${body.slice(0, 300)}`);
    }

    const data = await res.json() as any;
    items = data.itemSummaries ?? [];
    console.log(`[ebay] Fetched ${items.length} raw listings`);
  } catch (err) {
    console.error('[ebay] Poll failed:', err);
    return [];
  }

  const results: VinylListing[] = [];

  for (const item of items) {
    // Must be BIN
    if (!item.buyingOptions?.includes('FIXED_PRICE')) continue;

    const seller = parseSeller(item);
    if (!seller) continue;

    // Seller feedback check
    if (seller.feedbackPercent < MIN_FEEDBACK) {
      console.log(`[ebay] Skipping ${item.itemId} — seller feedback ${seller.feedbackPercent}% < ${MIN_FEEDBACK}%`);
      continue;
    }

    const price = parseFloat(item.price?.value ?? '0');
    if (isNaN(price) || price < MIN_PRICE) continue;

    const shipping = parseShipping(item);
    const totalCost = price + shipping;

    // Use Claude to parse the title
    const match = await parseEbayTitle(item.title);
    if (!match) {
      console.log(`[ebay] Claude returned null for: "${item.title}"`);
      continue;
    }

    if (match.confidence === 'low') {
      console.log(`[ebay] Low confidence match for: "${item.title}" — skipping`);
      continue;
    }

    // Search Discogs for the release ID
    const releaseId = await searchDiscogsRelease(
      match.artist,
      match.album,
      match.year,
      match.label
    );

    if (!releaseId) {
      console.log(`[ebay] No Discogs match for: "${match.artist} - ${match.album}"`);
      continue;
    }

    results.push({
      source: 'ebay',
      listingId: item.itemId,
      url: item.itemWebUrl,
      title: item.title,
      artist: match.artist,
      album: match.album,
      year: match.year,
      label: match.label,
      condition: item.condition ?? 'Unknown',
      price,
      shipping,
      totalCost,
      sellerUsername: seller.username,
      sellerFeedbackPercent: seller.feedbackPercent,
      sellerFeedbackCount: seller.feedbackCount,
      releaseId,
    });
  }

  console.log(`[ebay] ${results.length} listings passed filters and matched Discogs`);
  return results;
}

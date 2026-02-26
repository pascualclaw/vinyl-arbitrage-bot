/**
 * Craigslist RSS feed parser for vinyl records.
 *
 * Fetches RSS feeds from multiple Craigslist cities (musical instruments + general for-sale).
 * No browser needed — just HTTP + XML parsing.
 * Rate-limits to 1 city per second to avoid hammering CL.
 */

import { VinylListing } from '../types.js';
import { parseEbayTitle } from '../matcher/claude-match.js';
import { searchDiscogsRelease } from '../pricing/discogs-price.js';

const MIN_PRICE = Number(process.env.MIN_LISTING_PRICE ?? 25);

// Default cities if env var not set
const DEFAULT_CITIES = [
  'newyork', 'losangeles', 'chicago', 'sfbay', 'miami',
  'boston', 'seattle', 'portland', 'denver', 'austin',
  'philadelphia', 'atlanta',
];

function getCities(): string[] {
  const envCities = process.env.CRAIGSLIST_CITIES;
  if (envCities) {
    return envCities.split(',').map(c => c.trim()).filter(Boolean);
  }
  return DEFAULT_CITIES;
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

interface RawCLListing {
  title: string;
  url: string;
  description: string;
  price: number;
  listingId: string;
  city: string;
}

/**
 * Naive but effective XML text extractor — no external deps needed.
 * Pulls text content between XML/HTML tags.
 */
function extractTag(xml: string, tag: string): string {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const m = xml.match(re);
  if (!m) return '';
  // Strip CDATA wrapper if present
  return m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim();
}

function extractAllTags(xml: string, tag: string): string[] {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'gi');
  const results: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    results.push(m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim());
  }
  return results;
}

/**
 * Split RSS feed XML into individual <item> blocks.
 */
function splitItems(xml: string): string[] {
  const re = /<item>([\s\S]*?)<\/item>/gi;
  const items: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    items.push(m[1]);
  }
  return items;
}

/**
 * Extract price from listing title or description.
 * Looks for $NNN or $N,NNN patterns.
 */
function extractPrice(text: string): number | null {
  const m = text.match(/\$\s*([\d,]+(?:\.\d{1,2})?)/);
  if (!m) return null;
  const val = parseFloat(m[1].replace(/,/g, ''));
  return isNaN(val) ? null : val;
}

/**
 * Extract Craigslist listing ID from URL.
 * CL URLs look like: https://newyork.craigslist.org/brk/msd/d/brooklyn-jazz-records/1234567890.html
 */
function extractListingId(url: string): string | null {
  // Try to get the numeric ID from the URL path
  const m = url.match(/\/(\d{7,})\.html/);
  if (m) return m[1];
  // Fallback: use last path segment without extension
  const parts = url.split('/').filter(Boolean);
  const last = parts[parts.length - 1];
  return last?.replace(/\.html$/, '') ?? null;
}

/**
 * Fetch and parse an RSS feed. Returns raw listing data.
 */
async function fetchRssFeed(city: string, category: string): Promise<RawCLListing[]> {
  const url = `https://${city}.craigslist.org/search/${category}?format=rss&query=vinyl+record`;

  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'VinylArbitrageBot/1.0 +https://github.com/pascualclaw/vinyl-arbitrage-bot',
        'Accept': 'application/rss+xml, application/xml, text/xml, */*',
      },
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      if (res.status === 404 || res.status === 403) {
        // City may not have this category — silent skip
        return [];
      }
      console.warn(`[craigslist] ${city}/${category} returned ${res.status}`);
      return [];
    }

    const xml = await res.text();
    const itemBlocks = splitItems(xml);
    const results: RawCLListing[] = [];

    for (const block of itemBlocks) {
      const title = extractTag(block, 'title');
      const link = extractTag(block, 'link') || extractTag(block, 'guid');
      const description = extractTag(block, 'description') || extractTag(block, 'content:encoded');

      if (!title || !link) continue;

      // Try to find price in title first, then description
      const price = extractPrice(title) ?? extractPrice(description);
      if (price === null) continue; // skip listings with no price

      const listingId = extractListingId(link);
      if (!listingId) continue;

      results.push({
        title: title.replace(/<[^>]+>/g, '').trim(), // strip any HTML tags
        url: link,
        description: description.replace(/<[^>]+>/g, '').trim().slice(0, 500),
        price,
        listingId,
        city,
      });
    }

    return results;
  } catch (err: any) {
    if (err?.name === 'TimeoutError') {
      console.warn(`[craigslist] Timeout fetching ${city}/${category}`);
    } else {
      console.warn(`[craigslist] Error fetching ${city}/${category}:`, (err as Error).message);
    }
    return [];
  }
}

/**
 * Poll Craigslist RSS feeds across multiple cities.
 * Searches both musical instruments (msa) and general for-sale (sss) categories.
 */
export async function pollCraigslist(): Promise<VinylListing[]> {
  const cities = getCities();
  console.log(`[craigslist] Polling ${cities.length} cities (msa + sss categories)`);

  // Collect raw listings from all cities
  const rawMap = new Map<string, RawCLListing>(); // dedup by listingId

  for (const city of cities) {
    for (const category of ['msa', 'sss']) {
      const listings = await fetchRssFeed(city, category);
      for (const l of listings) {
        if (!rawMap.has(l.listingId)) {
          rawMap.set(l.listingId, l);
        }
      }
    }
    // Rate limit: 1 city per second (2 requests, but we still wait between cities)
    await sleep(1000);
  }

  const allRaw = Array.from(rawMap.values());
  console.log(`[craigslist] ${allRaw.length} unique raw listings across all cities`);

  // Filter by minimum price
  const priced = allRaw.filter(l => l.price >= MIN_PRICE);
  console.log(`[craigslist] ${priced.length} listings >= $${MIN_PRICE}`);

  const results: VinylListing[] = [];

  for (const raw of priced) {
    // Parse title with Claude
    const match = await parseEbayTitle(raw.title);
    if (!match) {
      console.log(`[craigslist] Claude returned null for: "${raw.title}"`);
      continue;
    }
    if (match.confidence === 'low') {
      console.log(`[craigslist] Low confidence for: "${raw.title}" — skipping`);
      continue;
    }

    // Search Discogs for releaseId
    const releaseId = await searchDiscogsRelease(match.artist, match.album, match.year, match.label);
    if (!releaseId) {
      console.log(`[craigslist] No Discogs match for: "${match.artist} - ${match.album}"`);
      continue;
    }

    // Small delay between Discogs lookups
    await sleep(1_100);

    results.push({
      source: 'craigslist',
      listingId: raw.listingId,
      url: raw.url,
      title: raw.title,
      artist: match.artist,
      album: match.album,
      year: match.year,
      label: match.label,
      condition: 'Unknown', // CL listings rarely state condition
      price: raw.price,
      shipping: 0,           // local pickup assumed
      totalCost: raw.price,
      sellerUsername: `cl-${raw.city}`,
      releaseId,
    });
  }

  console.log(`[craigslist] ${results.length} listings passed filters and matched Discogs`);
  return results;
}

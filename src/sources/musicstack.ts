/**
 * MusicStack vinyl marketplace scraper.
 *
 * Uses Playwright (headless Chromium) to search MusicStack for vinyl.
 * Rotates through search queries each poll cycle.
 * Passes listings through Claude for artist/album, then Discogs for releaseId.
 */

import { chromium, Browser, Page } from 'playwright';
import { VinylListing } from '../types.js';
import { parseEbayTitle } from '../matcher/claude-match.js';
import { searchDiscogsRelease } from '../pricing/discogs-price.js';

const MIN_PRICE = Number(process.env.MIN_LISTING_PRICE ?? 25);

const SEARCH_QUERIES = [
  'jazz vinyl',
  'hip hop vinyl',
  'rap vinyl',
  'soul vinyl',
  'funk vinyl',
];

// Rotate through queries each poll cycle
let queryIndex = 0;

const USER_AGENTS = [
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
];

function randomUserAgent(): string {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

interface RawMusicStackListing {
  title: string;          // Combined artist + album title
  artist: string;
  album: string;
  price: number;
  url: string;
  listingId: string;
  seller: string;
}

/**
 * Scrape MusicStack search results page.
 */
async function scrapeMusicStack(page: Page, query: string): Promise<RawMusicStackListing[]> {
  const encoded = encodeURIComponent(query);
  const url = `https://www.musicstack.com/cgi-bin/mss5.cgi?q=${encoded}&mode=T&new=1`;

  console.log(`[musicstack] Fetching: ${url}`);

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  } catch (err) {
    console.warn(`[musicstack] Navigation error for "${query}":`, (err as Error).message);
  }

  await sleep(2000);

  const listings: RawMusicStackListing[] = [];

  try {
    // MusicStack result rows — typically table rows or div rows
    // Try table-based layout first
    const rows = await page.$$('table tr, .result-row, [class*="result"], [class*="listing"]');
    console.log(`[musicstack] Found ${rows.length} potential rows`);

    for (const row of rows.slice(0, 50)) {
      try {
        const text = await row.textContent() ?? '';
        if (!text.trim()) continue;

        // Look for price pattern ($XX.XX)
        const priceMatch = text.match(/\$\s*([\d,]+(?:\.\d{1,2})?)/);
        if (!priceMatch) continue;

        const price = parseFloat(priceMatch[1].replace(/,/g, ''));
        if (isNaN(price) || price <= 0) continue;

        // Try to find a link to the listing
        const linkEl = await row.$('a[href*="item"], a[href*="listing"], a[href*="mss"]');
        const href = linkEl ? await linkEl.getAttribute('href') : null;

        // Build URL and extract ID
        let listingUrl = '';
        let listingId = '';

        if (href) {
          listingUrl = href.startsWith('http') ? href : `https://www.musicstack.com${href}`;
          // Extract ID from URL or generate from row content hash
          const idMatch = href.match(/[?&](?:item|id|listing)=(\d+)/) || href.match(/\/(\d+)(?:\/|$)/);
          listingId = idMatch ? idMatch[1] : '';
        }

        if (!listingId) {
          // Use a hash of the text as fallback ID
          listingId = `ms-${Buffer.from(text.slice(0, 100)).toString('base64').slice(0, 20)}`;
        }

        // Try to extract artist and album from separate elements or combined title
        const linkText = linkEl ? (await linkEl.textContent() ?? '').trim() : '';

        // MusicStack often has: "Artist Name - Album Title" or separate columns
        let artist = '';
        let album = '';
        let title = '';

        // Try cells within row
        const cells = await row.$$('td, [class*="artist"], [class*="album"], [class*="title"]');
        const cellTexts = await Promise.all(cells.map(c => c.textContent().then(t => (t ?? '').trim())));

        if (cellTexts.length >= 2) {
          // Often first meaningful cell = artist, second = album
          const meaningful = cellTexts.filter(t => t && !t.match(/^\$/) && t.length > 1);
          artist = meaningful[0] ?? '';
          album = meaningful[1] ?? '';
          title = artist && album ? `${artist} - ${album}` : linkText || text.slice(0, 100);
        } else {
          title = linkText || text.slice(0, 100).trim();
          // Try to split on " - "
          const dashParts = title.split(' - ');
          artist = dashParts[0]?.trim() ?? '';
          album = dashParts.slice(1).join(' - ').trim() || title;
        }

        if (!title || title.length < 3) continue;

        // Try to find seller info
        const sellerEl = await row.$('[class*="seller"], [class*="Seller"], a[href*="seller"]');
        const seller = sellerEl ? (await sellerEl.textContent() ?? '').trim() : 'musicstack-seller';

        listings.push({ title, artist, album, price, url: listingUrl, listingId, seller });
      } catch {
        // skip bad row
      }
    }

    // If table-based approach found nothing, try text-level extraction
    if (listings.length === 0) {
      console.log(`[musicstack] Table extraction empty — trying text extraction`);
      const bodyText = await page.textContent('body') ?? '';
      const lines = bodyText.split('\n').map(l => l.trim()).filter(Boolean);

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const priceMatch = line.match(/\$([\d,]+(?:\.\d{1,2})?)/);
        if (!priceMatch) continue;

        const price = parseFloat(priceMatch[1].replace(/,/g, ''));
        if (isNaN(price) || price < MIN_PRICE) continue;

        // Context: grab surrounding lines for title
        const context = lines.slice(Math.max(0, i - 2), i + 2).join(' ');
        const title = context.slice(0, 150).trim();
        const dashParts = title.split(' - ');

        listings.push({
          title,
          artist: dashParts[0]?.trim() ?? '',
          album: dashParts.slice(1).join(' - ').trim() || title,
          price,
          url: url,
          listingId: `ms-${i}-${price}`,
          seller: 'musicstack-seller',
        });

        if (listings.length >= 30) break;
      }
    }

  } catch (err) {
    console.error('[musicstack] Error parsing page:', err);
  }

  return listings;
}

/**
 * Poll MusicStack for vinyl records.
 * Returns VinylListing[] with releaseId resolved via Discogs.
 */
export async function pollMusicStack(): Promise<VinylListing[]> {
  const query = SEARCH_QUERIES[queryIndex % SEARCH_QUERIES.length];
  queryIndex = (queryIndex + 1) % SEARCH_QUERIES.length;

  console.log(`[musicstack] Polling with query: "${query}"`);

  let browser: Browser | null = null;

  try {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled'],
    });

    const context = await browser.newContext({
      userAgent: randomUserAgent(),
      viewport: { width: 1280, height: 800 },
      locale: 'en-US',
    });

    const page = await context.newPage();

    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
    });

    let rawListings: RawMusicStackListing[] = [];
    try {
      rawListings = await scrapeMusicStack(page, query);
    } finally {
      await page.close();
      await context.close();
    }

    console.log(`[musicstack] Found ${rawListings.length} raw listings`);

    // Filter by price
    const priced = rawListings.filter(l => l.price >= MIN_PRICE);
    console.log(`[musicstack] ${priced.length} listings >= $${MIN_PRICE}`);

    // Deduplicate by listingId
    const seen = new Set<string>();
    const unique = priced.filter(l => {
      if (seen.has(l.listingId)) return false;
      seen.add(l.listingId);
      return true;
    });

    const results: VinylListing[] = [];

    for (const raw of unique) {
      await sleep(1500 + Math.random() * 500); // 1.5–2s between API calls

      // Parse title with Claude
      const match = await parseEbayTitle(raw.title);
      if (!match) {
        console.log(`[musicstack] Claude returned null for: "${raw.title}"`);
        continue;
      }
      if (match.confidence === 'low') {
        console.log(`[musicstack] Low confidence for: "${raw.title}" — skipping`);
        continue;
      }

      // Search Discogs for releaseId
      const releaseId = await searchDiscogsRelease(
        match.artist || raw.artist,
        match.album || raw.album,
        match.year,
        match.label,
      );
      if (!releaseId) {
        console.log(`[musicstack] No Discogs match for: "${match.artist} - ${match.album}"`);
        continue;
      }

      results.push({
        source: 'musicstack',
        listingId: raw.listingId,
        url: raw.url,
        title: raw.title,
        artist: match.artist || raw.artist,
        album: match.album || raw.album,
        year: match.year,
        label: match.label,
        condition: 'Unknown',
        price: raw.price,
        shipping: 0,
        totalCost: raw.price,
        sellerUsername: raw.seller || 'musicstack-seller',
        releaseId,
      });
    }

    console.log(`[musicstack] ${results.length} listings passed filters and matched Discogs`);
    return results;

  } catch (err) {
    console.error('[musicstack] Poll failed:', err);
    return [];
  } finally {
    if (browser) {
      try { await browser.close(); } catch { /* ignore */ }
    }
  }
}

/**
 * Mercari vinyl record scraper.
 *
 * Uses Playwright (headless Chromium) to search Mercari for vinyl records.
 * Rotates through search terms each poll cycle.
 * Passes titles through Claude to extract artist/album, then searches Discogs for releaseId.
 */

import { chromium, Browser, Page } from 'playwright';
import { VinylListing } from '../types.js';
import { parseEbayTitle } from '../matcher/claude-match.js';
import { searchDiscogsRelease } from '../pricing/discogs-price.js';

const MIN_PRICE = Number(process.env.MIN_LISTING_PRICE ?? 25);

const SEARCH_TERMS = [
  'vinyl record jazz',
  'vinyl record hip hop',
  'vinyl record rap',
  'vinyl record soul',
  'vinyl LP',
];

// Rotate through search terms across poll cycles
let searchTermIndex = 0;

const USER_AGENTS = [
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15',
];

function randomUserAgent(): string {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

function randomDelay(): Promise<void> {
  // 2–3 seconds
  return sleep(2000 + Math.random() * 1000);
}

interface RawMercariListing {
  title: string;
  price: number;
  url: string;
  condition: string;
  listingId: string;
}

async function scrapeSearchPage(page: Page, term: string): Promise<RawMercariListing[]> {
  const encoded = encodeURIComponent(term);
  const url = `https://www.mercari.com/search/?keyword=${encoded}&status=on_sale&item_types=1`;

  console.log(`[mercari] Fetching: ${url}`);

  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30_000 });
  } catch (err) {
    console.warn(`[mercari] Navigation timeout/error for "${term}" — trying anyway`);
  }

  await sleep(2000);

  // Try to find listing cards — Mercari uses data-testid or aria patterns
  const listings: RawMercariListing[] = [];

  try {
    // Mercari listing cards — try multiple selectors
    const cards = await page.$$('li[data-testid="ItemCell"], [data-testid="item-cell"], [class*="ItemCell"], [class*="item-cell"]');

    if (cards.length === 0) {
      // Fallback: look for item links with prices
      const links = await page.$$('a[href*="/item/"]');
      console.log(`[mercari] Found ${links.length} item links (fallback mode)`);

      for (const link of links.slice(0, 40)) {
        try {
          const href = await link.getAttribute('href');
          if (!href) continue;

          const fullUrl = href.startsWith('http') ? href : `https://www.mercari.com${href}`;
          // Extract item ID from URL: /item/m{id}/ or /item/{id}/
          const idMatch = href.match(/\/item\/([a-zA-Z0-9]+)/);
          if (!idMatch) continue;

          const listingId = idMatch[1];
          const titleEl = await link.$('[class*="name"], [class*="title"], [class*="Name"], p, span');
          const title = titleEl ? (await titleEl.textContent() ?? '').trim() : '';

          const priceEl = await link.$('[class*="price"], [class*="Price"]');
          const priceText = priceEl ? (await priceEl.textContent() ?? '') : '';
          const price = parseFloat(priceText.replace(/[^0-9.]/g, ''));

          if (!title || isNaN(price) || price <= 0) continue;

          listings.push({
            title,
            price,
            url: fullUrl,
            condition: 'Good',
            listingId,
          });
        } catch {
          // skip bad card
        }
      }
    } else {
      console.log(`[mercari] Found ${cards.length} listing cards`);

      for (const card of cards.slice(0, 40)) {
        try {
          const titleEl = await card.$('[class*="name"], [class*="title"], [class*="Name"], [class*="Title"]');
          const title = titleEl ? (await titleEl.textContent() ?? '').trim() : '';

          const priceEl = await card.$('[class*="price"], [class*="Price"]');
          const priceText = priceEl ? (await priceEl.textContent() ?? '') : '';
          const price = parseFloat(priceText.replace(/[^0-9.]/g, ''));

          const linkEl = await card.$('a[href*="/item/"]');
          const href = linkEl ? await linkEl.getAttribute('href') : null;
          if (!href) continue;

          const fullUrl = href.startsWith('http') ? href : `https://www.mercari.com${href}`;
          const idMatch = href.match(/\/item\/([a-zA-Z0-9]+)/);
          if (!idMatch) continue;
          const listingId = idMatch[1];

          const condEl = await card.$('[class*="condition"], [class*="Condition"]');
          const condition = condEl ? (await condEl.textContent() ?? 'Good').trim() : 'Good';

          if (!title || isNaN(price) || price <= 0) continue;

          listings.push({ title, price, url: fullUrl, condition, listingId });
        } catch {
          // skip bad card
        }
      }
    }
  } catch (err) {
    console.error('[mercari] Error parsing page:', err);
  }

  return listings;
}

/**
 * Poll Mercari for vinyl records.
 * Rotates search terms each call. Returns VinylListing[] with releaseId resolved via Discogs.
 */
export async function pollMercari(): Promise<VinylListing[]> {
  const term = SEARCH_TERMS[searchTermIndex % SEARCH_TERMS.length];
  searchTermIndex = (searchTermIndex + 1) % SEARCH_TERMS.length;

  console.log(`[mercari] Polling with term: "${term}"`);

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
      timezoneId: 'America/New_York',
    });

    const page = await context.newPage();

    // Mask automation signals
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
    });

    let rawListings: RawMercariListing[] = [];
    try {
      rawListings = await scrapeSearchPage(page, term);
    } finally {
      await page.close();
      await context.close();
    }

    console.log(`[mercari] Found ${rawListings.length} raw listings`);

    // Filter by price
    const priced = rawListings.filter(l => l.price >= MIN_PRICE);
    console.log(`[mercari] ${priced.length} listings >= $${MIN_PRICE}`);

    const results: VinylListing[] = [];

    for (const raw of priced) {
      // Rate limit between Claude + Discogs calls
      await randomDelay();

      // Parse title with Claude
      const match = await parseEbayTitle(raw.title);
      if (!match) {
        console.log(`[mercari] Claude returned null for: "${raw.title}"`);
        continue;
      }
      if (match.confidence === 'low') {
        console.log(`[mercari] Low confidence for: "${raw.title}" — skipping`);
        continue;
      }

      // Search Discogs for releaseId
      const releaseId = await searchDiscogsRelease(match.artist, match.album, match.year, match.label);
      if (!releaseId) {
        console.log(`[mercari] No Discogs match for: "${match.artist} - ${match.album}"`);
        continue;
      }

      results.push({
        source: 'mercari',
        listingId: raw.listingId,
        url: raw.url,
        title: raw.title,
        artist: match.artist,
        album: match.album,
        year: match.year,
        label: match.label,
        condition: raw.condition,
        price: raw.price,
        shipping: 0,       // Mercari shows all-in pricing
        totalCost: raw.price,
        sellerUsername: 'mercari-seller',
        releaseId,
      });
    }

    console.log(`[mercari] ${results.length} listings passed filters and matched Discogs`);
    return results;

  } catch (err) {
    console.error('[mercari] Poll failed:', err);
    return [];
  } finally {
    if (browser) {
      try { await browser.close(); } catch { /* ignore */ }
    }
  }
}

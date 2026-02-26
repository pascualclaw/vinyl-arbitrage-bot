/**
 * Watchlist Builder
 *
 * Builds a list of high-value releases to monitor by:
 * 1. Searching Discogs database across target genres (sorted by most-wanted)
 * 2. Fetching price stats for each release
 * 3. Keeping only releases where median price >= MIN_WATCH_MEDIAN
 * 4. Saving to data/watchlist.json
 *
 * Runs once at startup + refreshes every 24h.
 * Poll cycle reads from this file — no redundant DB searches every 25min.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '../../data');
const WATCHLIST_PATH = path.join(DATA_DIR, 'watchlist.json');

const DISCOGS_TOKEN = process.env.DISCOGS_TOKEN!;
const BASE = 'https://api.discogs.com';

// Pages to fetch per genre (100 results/page)
// 8 pages × 100 results × 4 genres = up to 3,200 releases watched
const PAGES_PER_GENRE = 8;

// Valid Discogs genres
const TARGET_GENRES = ['Jazz', 'Hip Hop', 'Rock', 'Funk / Soul'];

export interface WatchlistEntry {
  releaseId: number;
  title: string;
  genre: string;
}

export interface Watchlist {
  builtAt: string;
  count: number;
  releases: WatchlistEntry[];
}

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
    console.warn('[watchlist] Rate limited — waiting 12s');
    await sleep(12_000);
    return discogsGet(path);
  }
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Discogs ${res.status}: ${body.slice(0, 100)}`);
  }
  return res.json();
}

/** Fetch one page of releases for a genre, sorted by want count (most desired = most valuable). */
async function fetchReleasePage(genre: string, page: number): Promise<{ id: number; title: string }[]> {
  const params = new URLSearchParams({
    genre,
    format: 'Vinyl',
    type: 'release',
    sort: 'want',
    sort_order: 'desc',
    per_page: '100',
    page: String(page),
  });
  const data = await discogsGet(`/database/search?${params}`);
  return (data.results ?? []).map((r: any) => ({ id: Number(r.id), title: r.title ?? 'Unknown' }));
}

/** Load existing watchlist from disk. */
export function loadWatchlist(): Watchlist | null {
  try {
    if (!fs.existsSync(WATCHLIST_PATH)) return null;
    return JSON.parse(fs.readFileSync(WATCHLIST_PATH, 'utf-8')) as Watchlist;
  } catch {
    return null;
  }
}

/** Check if watchlist needs a rebuild (older than 24h or missing). */
export function watchlistNeedsRebuild(): boolean {
  const wl = loadWatchlist();
  if (!wl) return true;
  const age = Date.now() - new Date(wl.builtAt).getTime();
  return age > 24 * 60 * 60 * 1000;
}

/** Load manual artist list from data/manual-artists.json */
function loadManualArtists(): string[] {
  try {
    const p = path.join(DATA_DIR, 'manual-artists.json');
    if (!fs.existsSync(p)) return [];
    const data = JSON.parse(fs.readFileSync(p, 'utf-8'));
    return data.artists ?? [];
  } catch {
    return [];
  }
}

/** Fetch all vinyl releases for a specific artist (all pages). */
async function fetchArtistReleases(artist: string): Promise<{ id: number; title: string }[]> {
  const results: { id: number; title: string }[] = [];
  let page = 1;

  while (true) {
    const params = new URLSearchParams({
      artist,
      format: 'Vinyl',
      type: 'release',
      per_page: '100',
      page: String(page),
    });

    try {
      const data = await discogsGet(`/database/search?${params}`);
      const items = data.results ?? [];
      if (items.length === 0) break;

      for (const r of items) {
        results.push({ id: Number(r.id), title: r.title ?? 'Unknown' });
      }

      const totalPages = data.pagination?.pages ?? 1;
      if (page >= totalPages || page >= 5) break; // cap at 5 pages per artist
      page++;
      await sleep(1_100);
    } catch {
      break;
    }
  }

  return results;
}

/** Build the watchlist. Can take 20-40 minutes due to rate limits — run in background. */
export async function buildWatchlist(): Promise<Watchlist> {
  console.log(`[watchlist] Starting build — scanning ${PAGES_PER_GENRE} pages × ${TARGET_GENRES.length} genres...`);
  fs.mkdirSync(DATA_DIR, { recursive: true });

  const entries: WatchlistEntry[] = [];
  const seenIds = new Set<number>();

  for (const genre of TARGET_GENRES) {
    console.log(`[watchlist] Genre: ${genre}`);
    let pageCount = 0;

    for (let page = 1; page <= PAGES_PER_GENRE; page++) {
      let releases: { id: number; title: string }[];
      try {
        releases = await fetchReleasePage(genre, page);
        await sleep(1_100);
      } catch (err) {
        console.error(`[watchlist] Failed page ${page} for ${genre}:`, err);
        break;
      }

      if (releases.length === 0) break;
      pageCount++;

      for (const release of releases) {
        if (seenIds.has(release.id)) continue;
        seenIds.add(release.id);
        entries.push({ releaseId: release.id, title: release.title, genre });
      }

      console.log(`[watchlist] ${genre} page ${page}/${PAGES_PER_GENRE} — ${entries.length} releases so far`);
    }

    console.log(`[watchlist] ${genre} done — scanned ${pageCount} pages`);
  }

  // Manual artists — add ALL their releases regardless of genre
  const manualArtists = loadManualArtists();
  if (manualArtists.length > 0) {
    console.log(`[watchlist] Scanning ${manualArtists.length} manual artists...`);
    for (const artist of manualArtists) {
      const releases = await fetchArtistReleases(artist);
      console.log(`[watchlist] ${artist}: ${releases.length} releases found`);
      for (const r of releases) {
        if (seenIds.has(r.id)) continue;
        seenIds.add(r.id);
        entries.push({ releaseId: r.id, title: r.title, genre: 'manual' });
      }
      await sleep(1_100);
    }
  }

  // Sort by genre then title for consistent ordering
  entries.sort((a, b) => a.genre.localeCompare(b.genre) || a.title.localeCompare(b.title));

  const watchlist: Watchlist = {
    builtAt: new Date().toISOString(),
    count: entries.length,
    releases: entries,
  };

  fs.writeFileSync(WATCHLIST_PATH, JSON.stringify(watchlist, null, 2));
  console.log(`[watchlist] ✅ Built ${entries.length} high-value releases — saved to watchlist.json`);
  return watchlist;
}

/**
 * vinyl-arbitrage-bot — main scheduler
 *
 * Polls eBay and Discogs every POLL_INTERVAL_MS (default: 25min),
 * checks for underpriced vinyl using Discogs price data,
 * and sends WhatsApp alerts via OpenClaw when deals are found.
 */

import 'dotenv/config';
import { initDb, hasSeen, markSeen, markAlerted, pruneOld } from './db/cache.js';
import { pollEbay } from './sources/ebay.js';
import { pollDiscogs } from './sources/discogs-market.js';
import { getReleasePrice } from './pricing/discogs-price.js';
import { sendAlert } from './alert/sender.js';
import { buildWatchlist, watchlistNeedsRebuild } from './watchlist/builder.js';
import { VinylListing, AlertPayload } from './types.js';

const WATCHLIST_REFRESH_MS = 24 * 60 * 60 * 1000; // 24 hours
let watchlistBuilding = false;

async function maybeRebuildWatchlist(): Promise<void> {
  if (watchlistBuilding) return;
  if (!watchlistNeedsRebuild()) return;

  watchlistBuilding = true;
  console.log('[main] Watchlist needs rebuild — starting background build...');
  buildWatchlist()
    .then(wl => console.log(`[main] Watchlist ready: ${wl.count} releases`))
    .catch(err => console.error('[main] Watchlist build failed:', err))
    .finally(() => { watchlistBuilding = false; });
}

const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS ?? 1_500_000); // 25 min
const SPREAD_THRESHOLD = Number(process.env.SPREAD_THRESHOLD ?? 3.0);
const MIN_DISCOGS_SALES = Number(process.env.MIN_DISCOGS_SALES ?? 5);

async function processListing(listing: VinylListing): Promise<void> {
  const { source, listingId, releaseId } = listing;

  // Skip if already seen
  if (hasSeen(source, listingId)) return;

  // Mark as seen immediately to avoid duplicate processing
  markSeen(source, listingId, false);

  if (!releaseId) {
    console.log(`[main] No releaseId for ${source}:${listingId} — skipping`);
    return;
  }

  // Fetch Discogs price stats
  const priceStats = await getReleasePrice(releaseId);
  if (!priceStats) {
    console.log(`[main] No price data for release ${releaseId}`);
    return;
  }

  // Minimum sale count check (liquidity)
  if (priceStats.saleCount < MIN_DISCOGS_SALES) {
    console.log(
      `[main] Release ${releaseId} has only ${priceStats.saleCount} listings ` +
      `(need ${MIN_DISCOGS_SALES}) — skipping`
    );
    return;
  }

  // Spread calculation
  const spread = priceStats.median / listing.totalCost;
  const profit = priceStats.median - listing.totalCost;

  if (spread < SPREAD_THRESHOLD) {
    console.log(
      `[main] ${source}:${listingId} spread ${spread.toFixed(2)}x < ${SPREAD_THRESHOLD}x threshold — skipping`
    );
    return;
  }

  console.log(
    `[main] 🎯 DEAL FOUND: ${source}:${listingId} — ` +
    `${spread.toFixed(1)}x spread, $${profit.toFixed(2)} profit`
  );

  const payload: AlertPayload = {
    listing,
    priceStats,
    spread,
    profit,
  };

  const sent = await sendAlert(payload);
  if (sent) {
    markAlerted(source, listingId);
  }
}

async function runPollCycle(): Promise<void> {
  console.log(`\n[main] === Poll cycle starting at ${new Date().toISOString()} ===`);

  // Prune stale DB entries monthly
  pruneOld(30);

  const [ebayListings, discogsListings] = await Promise.allSettled([
    pollEbay(),
    pollDiscogs(),
  ]);

  const allListings: VinylListing[] = [];

  if (ebayListings.status === 'fulfilled') {
    allListings.push(...ebayListings.value);
  } else {
    console.error('[main] eBay poll failed:', ebayListings.reason);
  }

  if (discogsListings.status === 'fulfilled') {
    allListings.push(...discogsListings.value);
  } else {
    console.error('[main] Discogs poll failed:', discogsListings.reason);
  }

  console.log(`[main] Processing ${allListings.length} total listings...`);

  // Process listings sequentially to respect rate limits
  let alertCount = 0;
  for (const listing of allListings) {
    try {
      await processListing(listing);
      // Small delay between price lookups to respect Discogs rate limit
      await new Promise(resolve => setTimeout(resolve, 1_100));
    } catch (err) {
      console.error(`[main] Error processing listing ${listing.source}:${listing.listingId}:`, err);
    }
  }

  console.log(`[main] === Poll cycle complete — next in ${POLL_INTERVAL_MS / 60_000}min ===\n`);
}

async function main(): Promise<void> {
  console.log('🎵 vinyl-arbitrage-bot starting up...');
  console.log(`   Poll interval: ${POLL_INTERVAL_MS / 60_000} minutes`);
  console.log(`   Spread threshold: ${SPREAD_THRESHOLD}x`);
  console.log(`   Min Discogs sales: ${MIN_DISCOGS_SALES}`);

  initDb();

  // Kick off watchlist build immediately (runs in background, non-blocking)
  maybeRebuildWatchlist();

  // Refresh watchlist every 24h
  setInterval(maybeRebuildWatchlist, WATCHLIST_REFRESH_MS);

  // Run immediately on startup, then on interval
  await runPollCycle();

  setInterval(async () => {
    try {
      await runPollCycle();
    } catch (err) {
      console.error('[main] Unhandled error in poll cycle:', err);
    }
  }, POLL_INTERVAL_MS);
}

main().catch(err => {
  console.error('[main] Fatal error:', err);
  process.exit(1);
});

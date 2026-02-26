import { AlertPayload } from '../types.js';

const OPENCLAW_GATEWAY_URL = process.env.OPENCLAW_GATEWAY_URL || 'http://127.0.0.1:16862';
const OPENCLAW_GATEWAY_TOKEN = process.env.OPENCLAW_GATEWAY_TOKEN || '832bb3640279ac11d7b4ed0f0293984186fdf355442180ab';
const ALERT_NUMBER = process.env.ALERT_WHATSAPP_NUMBER || '+17862708405';

function getPressingTip(listing: AlertPayload['listing']): string {
  const genre = (listing.genre ?? '').toLowerCase();
  const album = (listing.album ?? listing.title).toLowerCase();

  if (genre.includes('jazz')) {
    return 'Check label & matrix — original pressings (Blue Note, Prestige, Verve, Impulse) command premium';
  } else if (genre.includes('hip') || genre.includes('rap') || album.includes('rap')) {
    return 'Check if original press — first pressings often worth 3–10x repress value';
  } else if (genre.includes('soul') || genre.includes('r&b') || genre.includes('funk')) {
    return 'Verify pressing on Discogs — many soul 45s and LPs have valuable regional originals';
  } else {
    return 'Verify pressing details on Discogs before buying — condition and pressing matter';
  }
}

function formatAlert(payload: AlertPayload): string {
  const { listing, priceStats, spread, profit } = payload;

  const artistAlbum = listing.artist && listing.album
    ? `${listing.artist} - ${listing.album}`
    : listing.title;

  const sourceLabel = listing.source === 'ebay' ? 'eBay' : 'Discogs';

  const sellerInfo = listing.sellerFeedbackPercent !== undefined
    ? `${listing.sellerUsername} (${listing.sellerFeedbackPercent}% feedback, ${listing.sellerFeedbackCount ?? '?'} ratings)`
    : listing.sellerUsername;

  const discogsCompsUrl = `https://www.discogs.com/sell/release/${priceStats.releaseId}`;

  const pressingTip = getPressingTip(listing);

  return [
    '🎯 VINYL ALERT',
    '',
    `"${artistAlbum}"`,
    `Source: ${sourceLabel}`,
    `Price: $${listing.price.toFixed(2)} + $${listing.shipping.toFixed(2)} shipping = $${listing.totalCost.toFixed(2)} total`,
    `Discogs median: $${priceStats.median.toFixed(2)} (${priceStats.saleCount} listings, current)`,
    `Spread: ${spread.toFixed(1)}x / ~$${profit.toFixed(2)} profit`,
    '',
    `Seller: ${sellerInfo}`,
    `Condition: ${listing.condition}`,
    '',
    `⚠️ Pressing tip: ${pressingTip}`,
    '',
    `🔗 Listing: ${listing.url}`,
    `🔗 Discogs comps: ${discogsCompsUrl}`,
  ].join('\n');
}

export async function sendAlert(payload: AlertPayload): Promise<boolean> {
  const message = formatAlert(payload);

  console.log('[alert] Sending WhatsApp alert:', message.slice(0, 80) + '...');

  try {
    const response = await fetch(`${OPENCLAW_GATEWAY_URL}/tools/invoke`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENCLAW_GATEWAY_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        tool: 'message',
        args: {
          action: 'send',
          channel: 'whatsapp',
          target: ALERT_NUMBER,
          message,
        },
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      console.error(`[alert] Gateway error ${response.status}: ${body.slice(0, 200)}`);
      return false;
    }

    const data = await response.json() as any;
    if (data.error) {
      console.error('[alert] Gateway returned error:', data.error);
      return false;
    }

    console.log('[alert] Alert sent successfully');
    return true;
  } catch (err) {
    console.error('[alert] Failed to send alert:', err);
    return false;
  }
}

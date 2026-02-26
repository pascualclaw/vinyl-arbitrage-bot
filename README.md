# 🎵 vinyl-arbitrage-bot

An always-on bot that monitors **eBay** and **Discogs** for underpriced vinyl records and sends **WhatsApp alerts** when it finds a deal worth flipping.

---

## What It Does

Every 25 minutes, the bot:

1. **Polls eBay** for BIN (fixed-price) vinyl listings — US sellers only, 95%+ feedback, $25+ price
2. **Polls Discogs marketplace** for new vinyl listings — Jazz, Hip-Hop, Rock, Soul/R&B genres, US sellers
3. **Parses eBay titles** using Claude (AI) to extract artist, album, year, and label
4. **Looks up Discogs pricing** to get the current market value for each release
5. **Calculates the spread** — if (Discogs median price ÷ total cost) ≥ 3.0x, it's a deal
6. **Sends a WhatsApp alert** with full deal details, pressing tips, and direct links

### Alert Example

```
🎯 VINYL ALERT

"Miles Davis - Kind of Blue"
Source: eBay
Price: $32.00 + $5.00 shipping = $37.00 total
Discogs median: $145.00 (23 listings, current)
Spread: 3.9x / ~$108.00 profit

Seller: vinylvault99 (98.7% feedback, 1204 ratings)
Condition: Very Good Plus (VG+)

⚠️ Pressing tip: Check label & matrix — original pressings (Blue Note, Prestige, Verve, Impulse) command premium

🔗 Listing: https://www.ebay.com/itm/...
🔗 Discogs comps: https://www.discogs.com/sell/release/123456
```

---

## Setup

### 1. Get an eBay Developer Account

1. Go to [developer.ebay.com](https://developer.ebay.com/) and sign up
2. Create an application in the [Developer Dashboard](https://developer.ebay.com/my/keys)
3. Get your **App ID (Client ID)** and **Cert ID (Client Secret)** from the Production keys
4. Make sure your app has access to the **Browse API** (it's available by default)

### 2. Get a Discogs API Token

1. Log in to [discogs.com](https://www.discogs.com/)
2. Go to **Settings → Developers**: [discogs.com/settings/developers](https://www.discogs.com/settings/developers)
3. Click **Generate new token**
4. Copy the token

### 3. Configure Environment

```bash
cp .env.example .env
```

Edit `.env` and fill in:
- `EBAY_CLIENT_ID` — your eBay App ID
- `EBAY_CLIENT_SECRET` — your eBay Cert ID
- `DISCOGS_TOKEN` — your Discogs personal access token

The other values are pre-filled with sensible defaults.

---

## Running with Docker

### Prerequisites
- [Docker](https://www.docker.com/) + [Docker Compose](https://docs.docker.com/compose/)
- OpenClaw gateway running on your Mac (port 16862)

### Start

```bash
docker compose up -d
```

### View Logs

```bash
docker compose logs -f
```

### Stop

```bash
docker compose down
```

The SQLite database is stored in `./data/listings.db` on your host machine and persists across container restarts.

---

## Running Locally (Development)

```bash
npm install
cp .env.example .env
# Edit .env with your API keys

# Run with hot reload
npm run dev

# Or build and run
npm run build
npm start
```

For local dev, set `OPENCLAW_GATEWAY_URL=http://127.0.0.1:16862` in your `.env`.

---

## Configuration

All settings are in `.env`:

| Variable | Default | Description |
|---|---|---|
| `POLL_INTERVAL_MS` | `1500000` | Polling interval (25 min) |
| `SPREAD_THRESHOLD` | `3.0` | Minimum Discogs/cost ratio to alert |
| `MIN_DISCOGS_SALES` | `5` | Minimum active Discogs listings (liquidity check) |
| `MIN_LISTING_PRICE` | `25` | Minimum listing price in USD |
| `EBAY_MIN_SELLER_FEEDBACK` | `95` | Minimum eBay seller feedback % |

### Tuning Tips

- **Too many alerts?** Raise `SPREAD_THRESHOLD` to 4.0 or 5.0
- **Too few alerts?** Lower `SPREAD_THRESHOLD` to 2.5 or raise `MIN_LISTING_PRICE` to filter junk
- **Only want specific genres?** Edit `TARGET_GENRES` in `src/sources/discogs-market.ts`

---

## Architecture

```
vinyl-arbitrage-bot/
├── src/
│   ├── index.ts              # Main scheduler loop (polls every 25 min)
│   ├── sources/
│   │   ├── ebay.ts           # eBay BIN poller (OAuth2 + Browse API)
│   │   └── discogs-market.ts # Discogs marketplace poller
│   ├── pricing/
│   │   └── discogs-price.ts  # Discogs price lookups + rate limiting
│   ├── matcher/
│   │   └── claude-match.ts   # Claude AI title parser for eBay listings
│   ├── alert/
│   │   └── sender.ts         # WhatsApp alert formatting + delivery
│   ├── db/
│   │   └── cache.ts          # SQLite dedup (never alerts same listing twice)
│   └── types.ts              # Shared TypeScript interfaces
```

### How Pricing Works

- **eBay**: Claude parses the listing title → extracts artist/album → searches Discogs database → gets release ID → fetches price stats
- **Discogs**: Every listing already has a `release_id` → direct price lookup, no AI needed
- **Price stats**: Uses Discogs `/marketplace/price_suggestions` (per-condition pricing) as median proxy, falls back to `lowest_price × 1.5`
- **Spread**: `(Discogs median) / (listing price + shipping)` — must be ≥ 3.0x

### Rate Limiting

- Discogs API: capped at 55 requests/minute (limit is 60)
- eBay: no strict limit on Browse API, but we add 1.1s delay between price lookups

---

## Notes

- eBay OAuth tokens are cached and refreshed every 2 hours automatically
- Listings are stored in SQLite and never alerted twice
- If eBay or Discogs is down, the bot logs the error and continues — it won't crash
- The `dismissed_listings` table is a stub for future: Alex can respond to dismiss a deal

---

## License

MIT

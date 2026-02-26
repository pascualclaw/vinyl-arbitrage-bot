// Shared TypeScript types for vinyl-arbitrage-bot

export interface VinylListing {
  source: 'ebay' | 'discogs' | 'mercari' | 'craigslist' | 'musicstack';
  listingId: string;
  url: string;
  title: string;
  artist?: string;
  album?: string;
  year?: number;
  label?: string;
  condition: string;
  price: number;          // listing price in USD
  shipping: number;       // estimated shipping in USD
  totalCost: number;      // price + shipping
  sellerUsername: string;
  sellerFeedbackPercent?: number;
  sellerFeedbackCount?: number;
  releaseId?: string;     // Discogs release ID
  genre?: string;
}

export interface PriceStats {
  releaseId: string;
  median: number;
  saleCount: number;
  currency: string;
}

export interface ClaudeMatchResult {
  artist: string;
  album: string;
  year?: number;
  label?: string;
  confidence: 'high' | 'medium' | 'low';
}

export interface AlertPayload {
  listing: VinylListing;
  priceStats: PriceStats;
  spread: number;       // median / totalCost
  profit: number;       // median - totalCost
}

export interface EbayTokenResponse {
  access_token: string;
  expires_in: number;
  token_type: string;
}

export interface EbayItemSummary {
  itemId: string;
  title: string;
  price: {
    value: string;
    currency: string;
  };
  shippingOptions?: Array<{
    shippingCost?: {
      value: string;
      currency: string;
    };
    shippingCostType?: string;
  }>;
  seller: {
    username: string;
    feedbackPercentage: string;
    feedbackScore: number;
  };
  condition: string;
  itemWebUrl: string;
  buyingOptions: string[];
}

export interface DiscogsMarketListing {
  id: number;
  uri: string;
  release: {
    id: number;
    description: string;
    artist?: string;
    title?: string;
    year?: number;
    labels?: Array<{ name: string }>;
    genres?: string[];
    catalog_number?: string;
    thumbnail?: string;
  };
  condition: string;
  price: {
    value: number;
    currency: string;
  };
  shipping_price?: {
    value: number;
    currency: string;
  };
  seller: {
    username: string;
    stats: {
      rating: string;
      stars: number;
      total: number;
    };
  };
}

export interface DiscogsStatsResponse {
  lowest_price?: {
    value: number;
    currency: string;
  };
  num_for_sale?: number;
  blocked_from_sale?: boolean;
}

export interface DiscogsPriceHistoryResponse {
  pagination: {
    items: number;
  };
  items?: Array<{
    median_price?: {
      value: number;
      currency: string;
    };
    num_items?: number;
  }>;
}

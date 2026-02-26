/**
 * Shared price fetcher with fallback sources.
 * Primary: CoinGecko  |  Fallback: DeFi Llama
 */

// Map from our token keys to CoinGecko IDs
const CG_IDS: Record<string, string> = {
  eth: 'ethereum',
  sol: 'solana',
  usdc: 'usd-coin',
};

// Map from our token keys to DeFi Llama coin IDs
const LLAMA_IDS: Record<string, string> = {
  eth: 'coingecko:ethereum',
  sol: 'coingecko:solana',
  usdc: 'coingecko:usd-coin',
};

async function fetchFromCoinGecko(keys: string[]): Promise<Record<string, number>> {
  const cgIds = keys.map(k => CG_IDS[k]).filter(Boolean);
  if (cgIds.length === 0) return {};

  const res = await fetch(
    `https://api.coingecko.com/api/v3/simple/price?ids=${cgIds.join(',')}&vs_currencies=usd`,
  );
  if (!res.ok) throw new Error(`CoinGecko ${res.status}`);

  const data = (await res.json()) as Record<string, { usd?: number }>;
  const out: Record<string, number> = {};
  for (const key of keys) {
    const cgId = CG_IDS[key];
    if (cgId && data[cgId]?.usd) out[key] = data[cgId].usd;
  }
  return out;
}

async function fetchFromDefiLlama(keys: string[]): Promise<Record<string, number>> {
  const llamaIds = keys.map(k => LLAMA_IDS[k]).filter(Boolean);
  if (llamaIds.length === 0) return {};

  const res = await fetch(
    `https://coins.llama.fi/prices/current/${llamaIds.join(',')}`,
  );
  if (!res.ok) throw new Error(`DeFi Llama ${res.status}`);

  const data = (await res.json()) as { coins: Record<string, { price?: number }> };
  const out: Record<string, number> = {};
  for (const key of keys) {
    const llamaId = LLAMA_IDS[key];
    if (llamaId && data.coins[llamaId]?.price) out[key] = data.coins[llamaId].price;
  }
  return out;
}

/**
 * Fetch USD prices for the given token keys (eth, sol, usdc).
 * Tries CoinGecko first, falls back to DeFi Llama on failure.
 */
export async function fetchPrices(keys: string[]): Promise<Record<string, number>> {
  try {
    return await fetchFromCoinGecko(keys);
  } catch {
    return await fetchFromDefiLlama(keys);
  }
}

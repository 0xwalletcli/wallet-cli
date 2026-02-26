/** Shared staking rate/APR/APY fetchers used by balance, health, and quote commands */

/** Fetch Lido stETH 7-day SMA APR (returns percent, e.g. 2.34) */
export async function fetchLidoApr(): Promise<number | null> {
  try {
    const res = await fetch('https://eth-api.lido.fi/v1/protocol/steth/apr/sma');
    if (!res.ok) return null;
    const data = (await res.json()) as { data?: { smaApr?: number } };
    return data?.data?.smaApr ?? null;
  } catch { return null; }
}

/** Fetch Jito JitoSOL APY (returns decimal, e.g. 0.058 = 5.8%) */
export async function fetchJitoApy(): Promise<number | null> {
  try {
    const res = await fetch('https://kobe.mainnet.jito.network/api/v1/stake_pool_stats');
    if (!res.ok) return null;
    const data = (await res.json()) as { apy?: Array<{ data: number; date: string }> };
    if (data?.apy && data.apy.length > 0) {
      return data.apy[data.apy.length - 1].data;
    }
    return null;
  } catch { return null; }
}

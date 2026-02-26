import { parseAbi } from 'viem';
import { LIDO_CONFIG, JITO_CONFIG, type Network } from '../config.js';
import { getPublicClient } from '../lib/evm.js';
import { getConnection } from '../lib/solana.js';
import { formatUSD, formatToken } from '../lib/format.js';
import { PublicKey } from '@solana/web3.js';
import { getStakePoolAccount } from '@solana/spl-stake-pool';
import { fetchPrices } from '../lib/prices.js';

const STETH_ABI = parseAbi([
  'function getPooledEthByShares(uint256 sharesAmount) view returns (uint256)',
]);

const SUPPORTED = ['eth', 'weth', 'sol', 'wsol', 'wsol-eth', 'usdc', 'steth', 'jitosol'];

async function getStEthRate(network: Network): Promise<number> {
  const lido = LIDO_CONFIG[network];
  const client = getPublicClient(network);
  const raw = await client.readContract({
    address: lido.stETH as `0x${string}`,
    abi: STETH_ABI,
    functionName: 'getPooledEthByShares',
    args: [BigInt(1e18)],
  });
  return Number(raw) / 1e18;
}

async function getJitoSolRate(network: Network): Promise<number> {
  const conn = getConnection(network);
  const pool = await getStakePoolAccount(conn, new PublicKey(JITO_CONFIG.stakePool));
  const data = pool.account.data;
  return Number(data.totalLamports) / Number(data.poolTokenSupply);
}

function getPriceKey(sym: string): string {
  if (sym === 'weth' || sym === 'steth') return 'eth';
  if (sym === 'wsol' || sym === 'wsol-eth' || sym === 'jitosol') return 'sol';
  return sym;
}

export async function valueCommand(amount: string, token: string, network: Network, target?: string) {
  const sym = token.toLowerCase();
  const tgt = target?.toLowerCase();

  if (!SUPPORTED.includes(sym)) {
    console.log(`\n  Unknown token: ${token}`);
    console.log(`  Supported: ${SUPPORTED.join(', ')}\n`);
    return;
  }
  if (tgt && !SUPPORTED.includes(tgt)) {
    console.log(`\n  Unknown target token: ${target}`);
    console.log(`  Supported: ${SUPPORTED.join(', ')}\n`);
    return;
  }

  const amt = Number(amount);
  if (isNaN(amt) || amt <= 0) {
    console.log(`\n  Invalid amount: ${amount}\n`);
    return;
  }

  // ── Cross-token conversion: wallet value 10000 usdc eth ──
  if (tgt && tgt !== sym) {
    return convertBetween(amt, sym, tgt, network);
  }

  // ── Single-token USD valuation ──
  console.log(`\n  Fetching price...`);

  const isStaked = sym === 'steth' || sym === 'jitosol';
  const priceKey = getPriceKey(sym);

  let prices: Record<string, number>;
  let stakingRate = 1;
  try {
    [prices, stakingRate] = await Promise.all([
      fetchPrices([priceKey]),
      isStaked
        ? (sym === 'steth' ? getStEthRate(network) : getJitoSolRate(network))
        : Promise.resolve(1),
    ]);
  } catch (err: any) {
    console.log(`  Failed to fetch price: ${err.message}\n`);
    return;
  }

  const basePrice = prices[priceKey];
  if (!basePrice) {
    console.log(`  Could not fetch price for ${token}.\n`);
    return;
  }

  const label = token.toUpperCase();

  if (sym === 'steth') {
    const ethValue = amt * stakingRate;
    const usdValue = ethValue * basePrice;
    console.log(`\n  ${formatToken(amt, 6)} stETH`);
    console.log(`    = ${formatToken(ethValue, 6)} ETH`);
    console.log(`    = ${formatUSD(usdValue)}\n`);
  } else if (sym === 'jitosol') {
    const solValue = amt * stakingRate;
    const usdValue = solValue * basePrice;
    console.log(`\n  ${formatToken(amt, 6)} JitoSOL`);
    console.log(`    = ${formatToken(solValue, 6)} SOL`);
    console.log(`    = ${formatUSD(usdValue)}\n`);
  } else if (sym === 'usdc') {
    console.log(`\n  ${formatToken(amt, 2)} USDC = ${formatUSD(amt * basePrice)}\n`);
  } else {
    const usdValue = amt * basePrice;
    console.log(`\n  ${formatToken(amt, 6)} ${label} = ${formatUSD(usdValue)}\n`);
  }
}

async function convertBetween(amt: number, from: string, to: string, network: Network) {
  console.log(`\n  Fetching prices...`);

  const fromKey = getPriceKey(from);
  const toKey = getPriceKey(to);
  const keys = Array.from(new Set([fromKey, toKey]));

  // Fetch prices + staking rates in parallel
  const isFromStaked = from === 'steth' || from === 'jitosol';
  const isToStaked = to === 'steth' || to === 'jitosol';

  let prices: Record<string, number>;
  let fromStakeRate = 1;
  let toStakeRate = 1;
  try {
    [prices, fromStakeRate, toStakeRate] = await Promise.all([
      fetchPrices(keys),
      isFromStaked
        ? (from === 'steth' ? getStEthRate(network) : getJitoSolRate(network))
        : Promise.resolve(1),
      isToStaked
        ? (to === 'steth' ? getStEthRate(network) : getJitoSolRate(network))
        : Promise.resolve(1),
    ]);
  } catch (err: any) {
    console.log(`  Failed to fetch prices: ${err.message}\n`);
    return;
  }

  const fromPrice = prices[fromKey];
  const toPrice = prices[toKey];
  if (!fromPrice || !toPrice) {
    console.log(`  Could not fetch prices.\n`);
    return;
  }

  // Convert: from amount -> USD -> to amount
  // For staked tokens, account for the staking rate
  const fromUsd = amt * fromStakeRate * fromPrice;
  const toAmount = fromUsd / (toStakeRate * toPrice);

  const fromLabel = from.toUpperCase();
  const toLabel = to.toUpperCase();

  console.log(`\n  ${formatToken(amt, 4)} ${fromLabel} = ${formatToken(toAmount, 6)} ${toLabel}`);
  console.log(`    (${formatUSD(fromUsd)})\n`);
}

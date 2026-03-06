import { PublicKey } from '@solana/web3.js';
import { createPublicClient, http, parseAbi, type Chain } from 'viem';
import { getStakePoolAccount } from '@solana/spl-stake-pool';
import { type Network, COW_CONFIG, DEBRIDGE_CONFIG, LIDO_CONFIG, JITO_CONFIG, JUPITER_CONFIG, UNISWAP_CONFIG, LIFI_CONFIG, TOKENS, SOLANA_MINTS, ETHERSCAN_API, ETHERSCAN_CHAIN_ID, getEvmRpcUrl, getEvmChain } from '../config.js';
import { resolveSigner } from '../signers/index.js';
import { getPublicClient } from '../lib/evm.js';
import { getConnection } from '../lib/solana.js';
import { type ServiceCheck, type AuditRecord, type AuditPrices, loadAudit, saveAudit } from '../lib/auditgate.js';
import { getAllowedHosts } from '../lib/netguard.js';
import { formatToken, formatUSD } from '../lib/format.js';

const SEP = '──────────────────────────────────────────';
const TIMEOUT = 10_000;
const SPREAD_WARN = 5;  // % — warn if execution price differs from market by this much
const SPREAD_FAIL = 10; // % — fail if above this

const REQUIRED_HOSTS = [
  'api.cow.fi',
  'dln.debridge.finance',
  'stats-api.dln.trade',
  'lite-api.jup.ag',
  'api.etherscan.io',
  'api.coingecko.com',
  'trade-api.gateway.uniswap.org',
  'li.quest',
  'api.spritz.finance',
];

// minimum pool sizes to consider healthy
const MIN_LIDO_SUPPLY = 1_000_000;  // 1M stETH
const MIN_JITO_POOL = 100_000;      // 100K SOL
const JITO_RATE_MIN = 1.0;
const JITO_RATE_MAX = 2.0;

// ── Helpers ──────────────────────────────────────────

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), ms)),
  ]);
}

export function evaluateSpread(exec: number | null, market: number | null): 'ok' | 'warn' | 'fail' {
  if (exec == null || market == null || market === 0) return 'fail';
  const spread = Math.abs((exec - market) / market) * 100;
  if (spread > SPREAD_FAIL) return 'fail';
  if (spread > SPREAD_WARN) return 'warn';
  return 'ok';
}

function formatSpread(exec: number | null, market: number | null): string {
  if (exec == null || market == null || market === 0) return '';
  const pct = ((exec - market) / market) * 100;
  const sign = pct > 0 ? '+' : '';
  return `(${sign}${pct.toFixed(2)}% vs market)`;
}

function icon(status: 'ok' | 'warn' | 'fail'): string {
  if (status === 'ok') return '[PASS]';
  if (status === 'warn') return '[WARN]';
  return '[FAIL]';
}

function formatPremium(exec: number, market: number | null): string {
  if (market == null || market === 0) return '';
  const diff = exec - market;
  const sign = diff >= 0 ? '+' : '-';
  return `(mkt ${formatUSD(market)}, ${sign}${formatUSD(Math.abs(diff))} ${diff >= 0 ? 'premium' : 'savings'})`;
}

function pad(s: string, n: number): string { return s.padEnd(n); }

function printCheck(label: string, status: 'ok' | 'warn' | 'fail', detail: string) {
  console.log(`  ${icon(status)}  ${pad(label, 20)} ${detail}`);
}

function printDetail(label: string, detail: string) {
  console.log(`          ${pad(label, 20)} ${detail}`);
}

// ── Price fetchers ──────────────────────────────────

async function getMarketPrices(): Promise<{ eth: number | null; sol: number | null; usdc: number | null }> {
  const res = await withTimeout(
    fetch('https://api.coingecko.com/api/v3/simple/price?ids=ethereum,solana,usd-coin&vs_currencies=usd'),
    TIMEOUT,
  );
  if (!res.ok) throw new Error(`CoinGecko HTTP ${res.status}`);
  const data = (await res.json()) as { ethereum?: { usd: number }; solana?: { usd: number }; 'usd-coin'?: { usd: number } };
  return {
    eth: data.ethereum?.usd ?? null,
    sol: data.solana?.usd ?? null,
    usdc: data['usd-coin']?.usd ?? null,
  };
}

async function getCowEthPrice(network: Network): Promise<{ price: number; fee: number }> {
  let fromAddress = '0x0000000000000000000000000000000000000001';
  try { fromAddress = (await (await resolveSigner()).getEvmAccount()).address; } catch {}

  const cow = COW_CONFIG[network];
  const tokens = TOKENS[network];
  const sellBeforeFee = 10_000_000_000; // 10,000 USDC (6 decimals)

  const res = await withTimeout(fetch(`${cow.api}/api/v1/quote`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sellToken: tokens.USDC,
      buyToken: tokens.WETH,
      from: fromAddress,
      sellAmountBeforeFee: String(sellBeforeFee),
      kind: 'sell',
      validFor: 60,
      appData: '0x0000000000000000000000000000000000000000000000000000000000000000',
    }),
  }), TIMEOUT);

  if (!res.ok) throw new Error(`CoW HTTP ${res.status}`);
  const data = (await res.json()) as { quote: { sellAmount: string; buyAmount: string; feeAmount: string } };
  const totalPaid = sellBeforeFee / 1e6;
  const buy = Number(data.quote.buyAmount) / 1e18;
  const feeUsdc = (sellBeforeFee - Number(data.quote.sellAmount)) / 1e6;
  return { price: totalPaid / buy, fee: feeUsdc };
}

async function getJupiterSolPrice(): Promise<{ price: number; usdcNeeded: number; solAmount: number }> {
  const solAmount = 100;
  const lamports = solAmount * 1e9; // 100 SOL
  const params = new URLSearchParams({
    inputMint: SOLANA_MINTS.USDC,
    outputMint: SOLANA_MINTS.SOL,
    amount: String(lamports),
    swapMode: 'ExactOut',
    slippageBps: '50',
  });

  // lite-api.jup.ag is the free tier (no API key needed), api.jup.ag requires a key
  const res = await withTimeout(fetch(`https://lite-api.jup.ag/swap/v1/quote?${params}`), TIMEOUT);
  if (!res.ok) throw new Error(`Jupiter HTTP ${res.status}`);
  const quote = (await res.json()) as { inAmount: string; outAmount: string };
  const usdcNeeded = Number(quote.inAmount) / 1e6;
  return { price: usdcNeeded / solAmount, usdcNeeded, solAmount };
}

async function getDeBridgeSolPrice(): Promise<{ price: number; solReceived: number; usdcSent: number; fulfillDelay: number }> {
  const db = DEBRIDGE_CONFIG;
  const solRecipient = 'DRpbCBMxVnDK7maPM5tGv6MvB3v1sRMC86PZ8okm21hy';
  const usdcSent = 10_000;
  const params = new URLSearchParams({
    srcChainId: '1',
    srcChainTokenIn: db.tokens.USDC_ETH,
    srcChainTokenInAmount: String(usdcSent * 1_000_000), // 10,000 USDC (6 decimals)
    dstChainId: '7565164',
    dstChainTokenOut: db.tokens.nativeSOL,
    dstChainTokenOutAmount: 'auto',
    dstChainTokenOutRecipient: solRecipient,
    srcChainOrderAuthorityAddress: '0x0000000000000000000000000000000000000001',
    dstChainOrderAuthorityAddress: solRecipient,
  });

  const res = await withTimeout(fetch(`${db.api}/dln/order/create-tx?${params}`), TIMEOUT);
  if (!res.ok) throw new Error(`deBridge HTTP ${res.status}`);
  const data = (await res.json()) as {
    estimation: { dstChainTokenOut: { amount: string; decimals: number; recommendedAmount?: string } };
    order: { approximateFulfillmentDelay: number };
  };
  const out = data.estimation.dstChainTokenOut;
  const solReceived = Number(out.recommendedAmount || out.amount) / 10 ** out.decimals;
  return { price: usdcSent / solReceived, solReceived, usdcSent, fulfillDelay: data.order.approximateFulfillmentDelay };
}

async function getCowWsolPrice(network: Network): Promise<{ price: number; fee: number }> {
  let fromAddress = '0x0000000000000000000000000000000000000001';
  try { fromAddress = (await (await resolveSigner()).getEvmAccount()).address; } catch {}

  const cow = COW_CONFIG[network];
  const tokens = TOKENS[network];
  const sellBeforeFee = 10_000_000_000; // 10,000 USDC (6 decimals)

  const res = await withTimeout(fetch(`${cow.api}/api/v1/quote`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sellToken: tokens.USDC,
      buyToken: tokens.WSOL,
      from: fromAddress,
      sellAmountBeforeFee: String(sellBeforeFee),
      kind: 'sell',
      validFor: 60,
      appData: '0x0000000000000000000000000000000000000000000000000000000000000000',
    }),
  }), TIMEOUT);

  if (!res.ok) throw new Error(`CoW HTTP ${res.status}`);
  const data = (await res.json()) as { quote: { sellAmount: string; buyAmount: string; feeAmount: string } };
  const totalPaid = sellBeforeFee / 1e6;
  const buy = Number(data.quote.buyAmount) / 10 ** tokens.WSOL_DECIMALS;
  const feeUsdc = (sellBeforeFee - Number(data.quote.sellAmount)) / 1e6;
  return { price: totalPaid / buy, fee: feeUsdc };
}

async function getStethRatio(network: Network): Promise<number> {
  const client = getPublicClient(network);
  const lido = LIDO_CONFIG[network];

  // getPooledEthByShares(1e18) returns the share-to-ETH exchange rate.
  // This ratio starts at 1.0 and increases over time as staking rewards accrue.
  // Currently ~1.23 (2026). A drop below 1.0 would indicate a catastrophic issue.
  const ethPerShare = await withTimeout(client.readContract({
    address: lido.stETH,
    abi: parseAbi(['function getPooledEthByShares(uint256 sharesAmount) view returns (uint256)']),
    functionName: 'getPooledEthByShares',
    args: [BigInt(1e18)],
  }), TIMEOUT);

  return Number(ethPerShare) / 1e18;
}

export function evaluateStethRatio(ratio: number): 'ok' | 'warn' | 'fail' {
  // The share rate should be >= 1.0 (rewards only accrue, never decrease).
  // A drop below 1.0 means a slashing event or catastrophic bug.
  // Upper bound ~1.5 is generous — at 3% APR it takes ~14 years from 1.0 to 1.5.
  if (ratio < 1.0) return 'fail';
  if (ratio > 1.5) return 'warn';  // unexpectedly high, investigate
  return 'ok';
}

export function evaluateUsdcPeg(price: number): 'ok' | 'warn' | 'fail' {
  const deviation = Math.abs(price - 1.0);
  if (deviation > 0.02) return 'fail';   // >2% off
  if (deviation > 0.01) return 'warn';   // 1-2% off
  return 'ok';
}

// ── Main audit command ──────────────────────────────

export async function auditCommand(network: Network) {
  console.log(`\n  ── Wallet Audit ${SEP}`);
  console.log(`  Network: ${network}`);
  console.log('  Running checks...\n');

  const services: ServiceCheck[] = [];
  const prices: AuditPrices = {
    ethMarket: null, ethCow: null,
    solMarket: null, solJupiter: null, solDeBridge: null,
    wsolCow: null, stethRatio: null, usdcMarket: null,
  };

  let passCount = 0;
  let warnCount = 0;
  let failCount = 0;

  function record(name: string, status: 'ok' | 'warn' | 'fail', details: string) {
    services.push({ name, status, details });
    if (status === 'ok') passCount++;
    else if (status === 'warn') warnCount++;
    else failCount++;
  }

  // ── Fire ALL network calls in parallel ──

  const evmStart = Date.now();
  const baseStart = Date.now();
  const solStart = Date.now();
  const client = getPublicClient(network);
  const conn = getConnection(network);
  const lido = LIDO_CONFIG[network];

  const etherscanApiKey = process.env.ETHERSCAN_API_KEY;

  const uniswapApiKey = process.env.UNISWAP_API_KEY;

  const spritzApiKey = process.env.SPRITZ_API_KEY;

  const [
    evmBlock, baseBlock, solSlot, marketPrices,
    cowEth, cowWsol, jupSol, deBridgeSol,
    deBridgeStatus, etherscanCheck, stethRatio, lidoSupply, jitoPool,
    uniswapCheck, lifiCheck, spritzCheck,
  ] = await Promise.allSettled([
    // Infrastructure
    withTimeout(client.getBlockNumber(), TIMEOUT).then(block => ({ block, ms: Date.now() - evmStart })),
    (async () => {
      const baseClient = createPublicClient({
        chain: getEvmChain(network, 'base') as Chain,
        transport: http(getEvmRpcUrl(network, 'base')),
      });
      const block = await withTimeout(baseClient.getBlockNumber(), TIMEOUT);
      return { block, ms: Date.now() - baseStart };
    })(),
    withTimeout(conn.getSlot(), TIMEOUT).then(slot => ({ slot, ms: Date.now() - solStart })),
    // Market prices
    getMarketPrices(),
    // DEX quotes
    getCowEthPrice(network),
    getCowWsolPrice(network),
    getJupiterSolPrice(),
    getDeBridgeSolPrice(),
    // Status APIs
    withTimeout(fetch(`${DEBRIDGE_CONFIG.statusApi}/Orders/0x0000`), TIMEOUT),
    // Etherscan API (V2) — verify it returns valid data
    etherscanApiKey ? (async () => {
      const start = Date.now();
      const params = new URLSearchParams({
        chainid: ETHERSCAN_CHAIN_ID[network],
        module: 'account',
        action: 'txlist',
        address: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045', // vitalik.eth — known active address
        startblock: '0',
        endblock: '99999999',
        page: '1',
        offset: '1',
        sort: 'desc',
        apikey: etherscanApiKey,
      });
      const res = await withTimeout(fetch(`${ETHERSCAN_API}?${params}`), TIMEOUT);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { status: string; message: string; result: unknown };
      if (data.status !== '1' || !Array.isArray(data.result)) {
        throw new Error(typeof data.result === 'string' ? data.result : data.message || 'invalid response');
      }
      return { ms: Date.now() - start };
    })() : Promise.resolve(null),
    // On-chain reads
    getStethRatio(network),
    withTimeout(client.readContract({
      address: lido.stETH,
      abi: parseAbi(['function totalSupply() view returns (uint256)']),
      functionName: 'totalSupply',
    }), TIMEOUT),
    network === 'mainnet'
      ? withTimeout(getStakePoolAccount(conn, new PublicKey(JITO_CONFIG.stakePool)), TIMEOUT)
      : Promise.resolve(null),
    // Uniswap Trading API
    uniswapApiKey ? (async () => {
      const start = Date.now();
      const res = await withTimeout(fetch(`${UNISWAP_CONFIG.api}/check_approval`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': uniswapApiKey },
        body: JSON.stringify({
          token: TOKENS[network].USDC,
          amount: '1000000',
          walletAddress: '0x0000000000000000000000000000000000000001',
          chainId: network === 'mainnet' ? 1 : 11155111,
        }),
      }), TIMEOUT);
      return { ok: res.ok || res.status === 400, ms: Date.now() - start };
    })() : Promise.resolve(null),
    // LI.FI API
    (async () => {
      const start = Date.now();
      const headers: Record<string, string> = {};
      const lifiKey = process.env.LIFI_API_KEY;
      if (lifiKey) headers['x-lifi-api-key'] = lifiKey;
      const res = await withTimeout(fetch(`${LIFI_CONFIG.api}/chains`, { headers }), TIMEOUT);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return { ms: Date.now() - start };
    })(),
    // Spritz Finance API (off-ramp)
    spritzApiKey ? (async () => {
      const start = Date.now();
      const { getSpritzClient } = await import('../lib/spritz.js');
      const client = getSpritzClient();
      const accounts = await withTimeout(client.bankAccount.list(), TIMEOUT);
      return { ms: Date.now() - start, accounts: accounts.length };
    })() : Promise.resolve(null),
  ]);

  // ── Extract market prices first (needed for spread calculations) ──

  let market = { eth: null as number | null, sol: null as number | null, usdc: null as number | null };
  if (marketPrices.status === 'fulfilled') {
    market = marketPrices.value;
    if (market.eth != null) prices.ethMarket = market.eth;
    if (market.sol != null) prices.solMarket = market.sol;
    if (market.usdc != null) prices.usdcMarket = market.usdc;
  }

  // ── Print results in order ──

  // Tier 1: Infrastructure
  console.log(`  ── Infrastructure ${SEP}`);

  if (evmBlock.status === 'fulfilled') {
    printCheck('EVM RPC', 'ok', `Block #${evmBlock.value.block} (${evmBlock.value.ms}ms)`);
    record('EVM RPC', 'ok', `Block #${evmBlock.value.block} (${evmBlock.value.ms}ms)`);
  } else {
    printCheck('EVM RPC', 'fail', evmBlock.reason?.message || 'failed');
    record('EVM RPC', 'fail', evmBlock.reason?.message || 'failed');
  }

  if (baseBlock.status === 'fulfilled') {
    printCheck('Base RPC', 'ok', `Block #${baseBlock.value.block} (${baseBlock.value.ms}ms)`);
    record('Base RPC', 'ok', `Block #${baseBlock.value.block} (${baseBlock.value.ms}ms)`);
  } else {
    printCheck('Base RPC', 'fail', baseBlock.reason?.message || 'failed');
    record('Base RPC', 'fail', baseBlock.reason?.message || 'failed');
  }

  if (solSlot.status === 'fulfilled') {
    printCheck('Solana RPC', 'ok', `Slot #${solSlot.value.slot} (${solSlot.value.ms}ms)`);
    record('Solana RPC', 'ok', `Slot #${solSlot.value.slot} (${solSlot.value.ms}ms)`);
  } else {
    printCheck('Solana RPC', 'fail', solSlot.reason?.message || 'failed');
    record('Solana RPC', 'fail', solSlot.reason?.message || 'failed');
  }

  // Netguard (sync, no network call)
  const allowed = getAllowedHosts();
  const missing = REQUIRED_HOSTS.filter(h => !allowed.includes(h));
  if (missing.length > 0) {
    printCheck('Netguard', 'fail', `Missing: ${missing.join(', ')}`);
    record('Netguard', 'fail', `Missing: ${missing.join(', ')}`);
  } else {
    printCheck('Netguard', 'ok', `${allowed.length} hosts allowed`);
    record('Netguard', 'ok', `${allowed.length} hosts allowed`);
  }

  // Etherscan API
  if (!etherscanApiKey) {
    printCheck('Etherscan API', 'warn', 'No ETHERSCAN_API_KEY set (txs/history unavailable)');
    record('Etherscan API', 'warn', 'No API key configured');
  } else if (etherscanCheck.status === 'fulfilled') {
    if (etherscanCheck.value == null) {
      printCheck('Etherscan API', 'warn', 'Skipped (no API key)');
      record('Etherscan API', 'warn', 'Skipped');
    } else {
      printCheck('Etherscan API', 'ok', `V2 OK (${etherscanCheck.value.ms}ms)`);
      record('Etherscan API', 'ok', `V2 OK (${etherscanCheck.value.ms}ms)`);
    }
  } else {
    printCheck('Etherscan API', 'fail', etherscanCheck.reason?.message || 'failed');
    record('Etherscan API', 'fail', etherscanCheck.reason?.message || 'failed');
  }

  // Tier 2: Market Prices
  console.log(`\n  ── Market Prices (CoinGecko) ${SEP}`);

  if (marketPrices.status === 'fulfilled') {
    if (market.eth != null) {
      printCheck('ETH', 'ok', formatUSD(market.eth));
      record('CoinGecko ETH', 'ok', formatUSD(market.eth));
    } else {
      printCheck('ETH', 'fail', 'No price returned');
      record('CoinGecko ETH', 'fail', 'No price returned');
    }
    if (market.sol != null) {
      printCheck('SOL', 'ok', formatUSD(market.sol));
      record('CoinGecko SOL', 'ok', formatUSD(market.sol));
    } else {
      printCheck('SOL', 'fail', 'No price returned');
      record('CoinGecko SOL', 'fail', 'No price returned');
    }
    if (market.usdc != null) {
      const pegStatus = evaluateUsdcPeg(market.usdc);
      printCheck('USDC peg', pegStatus, `$${market.usdc.toFixed(4)} ${pegStatus === 'ok' ? '' : '(depeg detected!)'}`);
      record('USDC Peg', pegStatus, `$${market.usdc.toFixed(4)}`);
    } else {
      printCheck('USDC peg', 'fail', 'No price returned');
      record('USDC Peg', 'fail', 'No price returned');
    }
  } else {
    printCheck('CoinGecko', 'fail', marketPrices.reason?.message || 'failed');
    record('CoinGecko ETH', 'fail', marketPrices.reason?.message || 'failed');
    record('CoinGecko SOL', 'fail', marketPrices.reason?.message || 'failed');
    record('USDC Peg', 'fail', marketPrices.reason?.message || 'failed');
  }

  // CoW Swap
  console.log(`\n  ── CoW Swap (Ethereum) ${SEP}`);

  if (cowEth.status === 'fulfilled') {
    prices.ethCow = cowEth.value.price;
    const spread = evaluateSpread(cowEth.value.price, market.eth);
    printCheck('ETH price', spread, `${formatUSD(cowEth.value.price)}  ${formatSpread(cowEth.value.price, market.eth)}`);
    printDetail('Cost/ETH:', `${formatUSD(cowEth.value.price)}  ${formatPremium(cowEth.value.price, market.eth)}`);
    printDetail('Fee:', `${formatUSD(cowEth.value.fee)} on 10,000 USDC`);
    record('CoW Swap ETH', spread, `${formatUSD(cowEth.value.price)} ${formatSpread(cowEth.value.price, market.eth)}`);
  } else {
    printCheck('CoW Swap ETH', 'fail', cowEth.reason?.message || 'failed');
    record('CoW Swap ETH', 'fail', cowEth.reason?.message || 'failed');
  }

  if (cowWsol.status === 'fulfilled') {
    prices.wsolCow = cowWsol.value.price;
    const spread = evaluateSpread(cowWsol.value.price, market.sol);
    printCheck('WSOL-ETH price', spread, `${formatUSD(cowWsol.value.price)}  ${formatSpread(cowWsol.value.price, market.sol)}`);
    printDetail('Cost/WSOL:', `${formatUSD(cowWsol.value.price)}  ${formatPremium(cowWsol.value.price, market.sol)}`);
    printDetail('Fee:', `${formatUSD(cowWsol.value.fee)} on 10,000 USDC`);
    record('CoW Swap WSOL-ETH', spread, `${formatUSD(cowWsol.value.price)} ${formatSpread(cowWsol.value.price, market.sol)}`);
  } else {
    printCheck('CoW Swap WSOL-ETH', 'fail', cowWsol.reason?.message || 'failed');
    record('CoW Swap WSOL-ETH', 'fail', cowWsol.reason?.message || 'failed');
  }

  // Jupiter
  console.log(`\n  ── Jupiter (Solana) ${SEP}`);

  if (jupSol.status === 'fulfilled') {
    prices.solJupiter = jupSol.value.price;
    const spread = evaluateSpread(jupSol.value.price, market.sol);
    printCheck('SOL price', spread, `${formatUSD(jupSol.value.price)}  ${formatSpread(jupSol.value.price, market.sol)}`);
    printDetail('Cost/SOL:', `${formatUSD(jupSol.value.price)}  ${formatPremium(jupSol.value.price, market.sol)}`);
    printDetail('USDC needed:', `${formatToken(jupSol.value.usdcNeeded, 2)} for ${jupSol.value.solAmount} SOL`);
    record('Jupiter SOL', spread, `${formatUSD(jupSol.value.price)} ${formatSpread(jupSol.value.price, market.sol)}`);
  } else {
    printCheck('Jupiter', 'fail', jupSol.reason?.message || 'failed');
    record('Jupiter SOL', 'fail', jupSol.reason?.message || 'failed');
  }

  // deBridge
  console.log(`\n  ── deBridge (Cross-chain) ${SEP}`);

  if (deBridgeSol.status === 'fulfilled') {
    prices.solDeBridge = deBridgeSol.value.price;
    const spread = evaluateSpread(deBridgeSol.value.price, market.sol);
    printCheck('SOL bridge price', spread, `${formatUSD(deBridgeSol.value.price)}  ${formatSpread(deBridgeSol.value.price, market.sol)}`);
    printDetail('Cost/SOL:', `${formatUSD(deBridgeSol.value.price)}  ${formatPremium(deBridgeSol.value.price, market.sol)}`);
    printDetail('SOL received:', `${formatToken(deBridgeSol.value.solReceived, 4)} for ${deBridgeSol.value.usdcSent.toLocaleString()} USDC`);
    printDetail('Est. fulfillment:', `~${deBridgeSol.value.fulfillDelay}s`);
    record('deBridge SOL', spread, `${formatUSD(deBridgeSol.value.price)} ${formatSpread(deBridgeSol.value.price, market.sol)}`);
  } else {
    printCheck('deBridge', 'fail', deBridgeSol.reason?.message || 'failed');
    record('deBridge SOL', 'fail', deBridgeSol.reason?.message || 'failed');
  }

  if (deBridgeStatus.status === 'fulfilled') {
    const res = deBridgeStatus.value;
    const ok = res.ok || res.status === 404 || res.status === 422;
    if (ok) {
      printCheck('Status API', 'ok', 'Reachable');
      record('deBridge Status', 'ok', 'Reachable');
    } else {
      printCheck('Status API', 'fail', `HTTP ${res.status}`);
      record('deBridge Status', 'fail', `HTTP ${res.status}`);
    }
  } else {
    printCheck('Status API', 'fail', deBridgeStatus.reason?.message || 'failed');
    record('deBridge Status', 'fail', deBridgeStatus.reason?.message || 'failed');
  }

  // Uniswap
  console.log(`\n  ── Uniswap (Ethereum) ${SEP}`);

  if (!uniswapApiKey) {
    printCheck('Uniswap API', 'warn', 'No UNISWAP_API_KEY set (Uniswap swaps unavailable)');
    record('Uniswap API', 'warn', 'No API key configured');
  } else if (uniswapCheck.status === 'fulfilled') {
    if (uniswapCheck.value == null) {
      printCheck('Uniswap API', 'warn', 'Skipped (no API key)');
      record('Uniswap API', 'warn', 'Skipped');
    } else {
      printCheck('Uniswap API', 'ok', `Reachable (${uniswapCheck.value.ms}ms)`);
      record('Uniswap API', 'ok', `Reachable (${uniswapCheck.value.ms}ms)`);
    }
  } else {
    printCheck('Uniswap API', 'fail', uniswapCheck.reason?.message || 'failed');
    record('Uniswap API', 'fail', uniswapCheck.reason?.message || 'failed');
  }

  // LI.FI / Jumper
  console.log(`\n  ── LI.FI / Jumper ${SEP}`);

  if (lifiCheck.status === 'fulfilled') {
    printCheck('LI.FI API', 'ok', `Reachable (${lifiCheck.value.ms}ms)`);
    record('LI.FI API', 'ok', `Reachable (${lifiCheck.value.ms}ms)`);
  } else {
    printCheck('LI.FI API', 'fail', lifiCheck.reason?.message || 'failed');
    record('LI.FI API', 'fail', lifiCheck.reason?.message || 'failed');
  }

  // Spritz Finance (off-ramp)
  console.log(`\n  ── Spritz Finance (Off-ramp) ${SEP}`);

  if (!spritzApiKey) {
    printCheck('Spritz API', 'warn', 'No SPRITZ_API_KEY set (withdraw unavailable)');
    record('Spritz API', 'warn', 'No API key configured');
  } else if (spritzCheck.status === 'fulfilled') {
    if (spritzCheck.value == null) {
      printCheck('Spritz API', 'warn', 'Skipped (no API key)');
      record('Spritz API', 'warn', 'Skipped');
    } else {
      printCheck('Spritz API', 'ok', `${spritzCheck.value.accounts} bank account(s) linked (${spritzCheck.value.ms}ms)`);
      record('Spritz API', 'ok', `${spritzCheck.value.accounts} bank account(s) (${spritzCheck.value.ms}ms)`);
      if (spritzCheck.value.accounts === 0) {
        printCheck('Bank accounts', 'warn', 'No bank accounts linked — add one at https://app.spritz.finance');
        record('Spritz Bank Accounts', 'warn', 'No accounts linked');
      }
    }
  } else {
    printCheck('Spritz API', 'fail', spritzCheck.reason?.message || 'failed');
    record('Spritz API', 'fail', spritzCheck.reason?.message || 'failed');
  }

  // Cross-platform comparison
  if (prices.solJupiter != null && prices.solDeBridge != null) {
    console.log(`\n  ── Jupiter vs deBridge ${SEP}`);
    const crossSpread = evaluateSpread(prices.solJupiter, prices.solDeBridge);
    const pct = Math.abs((prices.solJupiter - prices.solDeBridge) / prices.solDeBridge * 100);
    printCheck('SOL price spread', crossSpread, `${pct.toFixed(2)}% difference`);
    record('Cross-platform SOL', crossSpread, `${pct.toFixed(2)}% difference`);
  }

  // Tier 3: Pools & Contracts
  console.log(`\n  ── Pools & Contracts ${SEP}`);

  // stETH share rate
  if (stethRatio.status === 'fulfilled') {
    const ratio = stethRatio.value;
    prices.stethRatio = ratio;
    const ratioStatus = evaluateStethRatio(ratio);
    const note = ratio < 1.0 ? '(below 1.0 — slashing or bug!)' : ratio > 1.5 ? '(unusually high)' : '';
    printCheck('stETH share rate', ratioStatus, `1 share = ${ratio.toFixed(4)} ETH ${note}`);
    record('stETH Share Rate', ratioStatus, `1 share = ${ratio.toFixed(4)} ETH`);
  } else {
    printCheck('stETH share rate', 'fail', stethRatio.reason?.message || 'failed');
    record('stETH Share Rate', 'fail', stethRatio.reason?.message || 'failed');
  }

  // Lido TVL
  if (lidoSupply.status === 'fulfilled') {
    const supplyEth = Number(lidoSupply.value) / 1e18;
    const status = supplyEth >= MIN_LIDO_SUPPLY ? 'ok' : 'fail' as const;
    const tvl = market.eth ? formatUSD(supplyEth * market.eth, 0) + ' TVL' : '';
    printCheck('Lido stETH TVL', status, `${Math.round(supplyEth).toLocaleString()} stETH${tvl ? `  (${tvl})` : ''}`);
    record('Lido stETH TVL', status, `${Math.round(supplyEth).toLocaleString()} stETH`);
  } else {
    printCheck('Lido stETH TVL', 'fail', lidoSupply.reason?.message || 'failed');
    record('Lido stETH TVL', 'fail', lidoSupply.reason?.message || 'failed');
  }

  // Jito
  if (network === 'testnet') {
    printCheck('Jito Stake Pool', 'ok', 'Skipped (mainnet-only)');
    record('Jito Stake Pool', 'ok', 'Skipped (mainnet-only)');
  } else if (jitoPool.status === 'fulfilled' && jitoPool.value != null) {
    const data = jitoPool.value.account.data;
    const totalSol = Number(data.totalLamports) / 1e9;
    const poolTokens = Number(data.poolTokenSupply) / 1e9;
    const rate = totalSol / poolTokens;

    const sizeOk = totalSol >= MIN_JITO_POOL;
    const rateOk = rate >= JITO_RATE_MIN && rate <= JITO_RATE_MAX;
    const status = sizeOk && rateOk ? 'ok' : 'fail' as const;

    const tvl = market.sol ? `  (${formatUSD(totalSol * market.sol, 0)} TVL)` : '';
    printCheck('Jito Stake Pool', status, `${Math.round(totalSol).toLocaleString()} SOL${tvl}`);
    printDetail('JitoSOL rate:', `1 JitoSOL = ${formatToken(rate, 4)} SOL`);
    if (!sizeOk) printDetail('WARNING:', `Pool below ${MIN_JITO_POOL.toLocaleString()} SOL minimum`);
    if (!rateOk) printDetail('WARNING:', `Rate ${formatToken(rate, 4)} outside ${JITO_RATE_MIN}-${JITO_RATE_MAX} range`);
    record('Jito Stake Pool', status, `${Math.round(totalSol).toLocaleString()} SOL, rate ${formatToken(rate, 4)}`);
  } else {
    const msg = jitoPool.status === 'rejected' ? (jitoPool.reason?.message || 'failed') : 'no data';
    printCheck('Jito Stake Pool', 'fail', msg);
    record('Jito Stake Pool', 'fail', msg);
  }

  // ── Summary ──

  const passed = failCount === 0;
  const total = passCount + warnCount + failCount;

  const auditRecord: AuditRecord = {
    timestamp: Date.now(),
    version: '0.3.0',
    services,
    prices,
    passed,
  };
  saveAudit(auditRecord);

  const nextDue = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

  console.log(`\n  ${SEP}`);
  console.log(`  ${passCount}/${total} passed${warnCount > 0 ? `, ${warnCount} warnings` : ''}${failCount > 0 ? `, ${failCount} FAILED` : ''}`);

  if (passed) {
    console.log(`  Mainnet access: ALLOWED`);
    console.log(`  Next audit due: ${nextDue.toLocaleDateString()}`);
  } else {
    console.log(`  Mainnet access: BLOCKED (fix failures and re-run)`);
  }

  console.log(`  Saved to: ~/.wallet-cli/audit.json`);

  // show previous audit for comparison
  const prev = loadAudit();
  if (prev && prev.timestamp < auditRecord.timestamp) {
    const prevDate = new Date(prev.timestamp).toLocaleDateString();
    console.log(`  Previous audit: ${prevDate}`);
  }

  console.log('');
}

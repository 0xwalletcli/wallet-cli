import { parseAbi } from 'viem';
import { PublicKey } from '@solana/web3.js';
import { getStakePoolAccount } from '@solana/spl-stake-pool';
import {
  type Network, TOKENS, COW_CONFIG, DEBRIDGE_CONFIG,
  LIDO_CONFIG, JITO_CONFIG, SOLANA_MINTS,
} from '../config.js';
import { resolveSigner } from '../signers/index.js';
import { getPublicClient } from '../lib/evm.js';
import { getConnection } from '../lib/solana.js';
import { formatToken, formatUSD, formatGasFee } from '../lib/format.js';
import { fetchPrices as fetchPricesWithFallback } from '../lib/prices.js';
import { validateAmount } from '../lib/prompt.js';
import { getSwapProvider, getBridgeProvider } from '../providers/registry.js';
import { fetchLidoApr, fetchJitoApy } from '../lib/staking.js';

const SEP = '══════════════════════════════════════════';
const LINE = '──────────────────────────────────────────';
const TIMEOUT = 10_000;

// ── Helpers ──────────────────────────────────────────

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), ms)),
  ]);
}

function pad(s: string, n: number): string { return s.padEnd(n); }

// ── Fetchers ─────────────────────────────────────────

async function fetchMarketPrices(): Promise<{ eth: number | null; sol: number | null }> {
  const p = await withTimeout(fetchPricesWithFallback(['eth', 'sol']), TIMEOUT);
  return {
    eth: p.eth ?? null,
    sol: p.sol ?? null,
  };
}

interface CowResult {
  buyAmount: number;
  feeUsdc: number;
  effectivePrice: number;
}

async function fetchCowQuote(
  network: Network,
  usdcRaw: bigint,
  buyToken: `0x${string}`,
  buyDecimals: number,
): Promise<CowResult> {
  let fromAddress = '0x0000000000000000000000000000000000000001';
  try { fromAddress = (await (await resolveSigner()).getEvmAccount()).address; } catch {}

  const cow = COW_CONFIG[network];
  const tokens = TOKENS[network];

  const res = await withTimeout(fetch(`${cow.api}/api/v1/quote`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sellToken: tokens.USDC,
      buyToken,
      from: fromAddress,
      sellAmountBeforeFee: usdcRaw.toString(),
      kind: 'sell',
      validFor: 60,
      appData: '0x0000000000000000000000000000000000000000000000000000000000000000',
    }),
  }), TIMEOUT);

  if (!res.ok) throw new Error(`CoW HTTP ${res.status}`);
  const data = (await res.json()) as { quote: { sellAmount: string; buyAmount: string; feeAmount: string } };
  const totalPaid = Number(usdcRaw) / 1e6;
  const buyAmount = Number(data.quote.buyAmount) / 10 ** buyDecimals;
  const sellPostFee = Number(data.quote.sellAmount) / 1e6;
  const feeUsdc = totalPaid - sellPostFee;
  return { buyAmount, feeUsdc, effectivePrice: totalPaid / buyAmount };
}

interface BridgeResult {
  outputAmount: number;
  protocolFeeEth: number;
}

async function fetchDeBridgeQuote(
  srcToken: string,
  dstToken: string,
  srcAmountRaw: string,
): Promise<BridgeResult> {
  const db = DEBRIDGE_CONFIG;
  const solRecipient = 'DRpbCBMxVnDK7maPM5tGv6MvB3v1sRMC86PZ8okm21hy';
  const params = new URLSearchParams({
    srcChainId: '1',
    srcChainTokenIn: srcToken,
    srcChainTokenInAmount: srcAmountRaw,
    dstChainId: '7565164',
    dstChainTokenOut: dstToken,
    dstChainTokenOutAmount: 'auto',
    dstChainTokenOutRecipient: solRecipient,
    srcChainOrderAuthorityAddress: '0x0000000000000000000000000000000000000001',
    dstChainOrderAuthorityAddress: solRecipient,
  });

  const res = await withTimeout(fetch(`${db.api}/dln/order/create-tx?${params}`), TIMEOUT);
  if (!res.ok) throw new Error(`deBridge HTTP ${res.status}`);
  const data = (await res.json()) as {
    estimation: { dstChainTokenOut: { amount: string; decimals: number; recommendedAmount?: string } };
    tx: { value?: string };
  };
  const out = data.estimation.dstChainTokenOut;
  const outputAmount = Number(out.recommendedAmount || out.amount) / 10 ** out.decimals;
  const protocolFeeEth = data.tx.value ? Number(data.tx.value) / 1e18 : 0;
  return { outputAmount, protocolFeeEth };
}

interface JupiterResult {
  solReceived: number;
  pricePerSol: number;
}

async function fetchJupiterQuote(usdcRaw: string): Promise<JupiterResult> {
  const params = new URLSearchParams({
    inputMint: SOLANA_MINTS.USDC,
    outputMint: SOLANA_MINTS.SOL,
    amount: usdcRaw,
    swapMode: 'ExactIn',
    slippageBps: '50',
  });

  const res = await withTimeout(
    fetch(`https://lite-api.jup.ag/swap/v1/quote?${params}`),
    TIMEOUT,
  );
  if (!res.ok) throw new Error(`Jupiter HTTP ${res.status}`);
  const quote = (await res.json()) as { inAmount: string; outAmount: string };
  const usdcSpent = Number(quote.inAmount) / 1e6;
  const solReceived = Number(quote.outAmount) / 1e9;
  return { solReceived, pricePerSol: usdcSpent / solReceived };
}

async function fetchStethRate(network: Network): Promise<number> {
  const client = getPublicClient(network);
  const lido = LIDO_CONFIG[network];
  const ethPerShare = await withTimeout(client.readContract({
    address: lido.stETH,
    abi: parseAbi(['function getPooledEthByShares(uint256 sharesAmount) view returns (uint256)']),
    functionName: 'getPooledEthByShares',
    args: [BigInt(1e18)],
  }), TIMEOUT);
  return Number(ethPerShare) / 1e18;
}

async function fetchJitoRate(): Promise<number> {
  const conn = getConnection('mainnet');
  const pool = await withTimeout(
    getStakePoolAccount(conn, new PublicKey(JITO_CONFIG.stakePool)),
    TIMEOUT,
  );
  const data = pool.account.data;
  return Number(data.totalLamports) / Number(data.poolTokenSupply);
}

// ── Provider-based fetchers ──────────────────────────

interface SwapQuoteResult {
  buyAmount: number;
  feeUsdc: number;
  effectivePrice: number;
  gasFeeUSD?: string;
}

async function fetchProviderSwapQuote(
  providerId: string,
  network: Network,
  usdcRaw: bigint,
  buyToken: `0x${string}`,
  buyDecimals: number,
): Promise<SwapQuoteResult> {
  const provider = getSwapProvider(providerId);
  let fromAddress = '0x0000000000000000000000000000000000000001';
  try { fromAddress = (await (await resolveSigner()).getEvmAccount()).address; } catch {}
  const tokens = TOKENS[network];

  const quote = await withTimeout(provider.getQuote({
    sellToken: tokens.USDC,
    buyToken,
    amount: usdcRaw.toString(),
    kind: 'sell',
    from: fromAddress,
    network,
  }), TIMEOUT);

  const totalPaid = Number(usdcRaw) / 1e6;
  const buyAmount = Number(quote.buyAmount) / 10 ** buyDecimals;
  const feeUsdc = Number(quote.feeAmount) / 1e6;
  return { buyAmount, feeUsdc, effectivePrice: totalPaid / buyAmount, gasFeeUSD: quote.gasFeeUSD };
}

async function fetchProviderBridgeQuote(
  providerId: string,
  srcToken: string,
  dstToken: string,
  srcAmountRaw: string,
): Promise<BridgeResult> {
  const provider = getBridgeProvider(providerId);
  let srcAddress = '0x0000000000000000000000000000000000000001';
  let dstAddress = 'DRpbCBMxVnDK7maPM5tGv6MvB3v1sRMC86PZ8okm21hy';
  try {
    const signer = await resolveSigner();
    srcAddress = (await signer.getEvmAccount()).address;
    const solAddr = await signer.getSolanaAddress();
    if (solAddr) dstAddress = solAddr;
  } catch {}

  const quote = await withTimeout(provider.getQuote({
    srcChainId: '1',
    dstChainId: '7565164',
    srcToken,
    dstToken,
    amount: srcAmountRaw,
    srcAddress,
    dstAddress,
  }), TIMEOUT);

  const outputAmount = Number(quote.dstAmount) / 10 ** quote.dstDecimals;
  const protocolFeeEth = quote.protocolFeeRaw ? Number(quote.protocolFeeRaw) / 1e18 : 0;
  return { outputAmount, protocolFeeEth };
}

// ── Path types ───────────────────────────────────────

interface PathResult {
  name: string;
  label: string;
  asset: string;
  steps: { action: string; input: string; output: string; fee: string; note?: string }[];
  finalAmount: number;
  finalValue: number;
  totalCost: number;
  costPct: number;
  yieldBase?: number;     // annual yield in base asset (ETH or SOL)
  yieldBaseUnit?: string; // "ETH" or "SOL"
  yieldUsd?: number;      // annual yield in USD
}

// ── Display ──────────────────────────────────────────

function printPath(path: PathResult) {
  console.log(`  ── Path ${path.name}: ${path.label} ${LINE}`);
  console.log('');

  for (const step of path.steps) {
    console.log(`    ${step.action}`);
    console.log(`      ${pad('In:', 6)} ${step.input}`);
    console.log(`      ${pad('Out:', 6)} ${step.output}`);
    console.log(`      ${pad('Fee:', 6)} ${step.fee}`);
    if (step.note) console.log(`      ${step.note}`);
  }

  console.log('');
  console.log(`    Acquired: ${formatToken(path.finalAmount, 4)} ${path.asset}  (${formatUSD(path.finalValue)})`);
  console.log(`    Cost:     ${formatUSD(path.totalCost)}  (${formatToken(path.costPct, 2)}%)`);
  if (path.yieldBase != null && path.yieldUsd != null && path.yieldBaseUnit) {
    console.log(`    Yield:    ~${formatToken(path.yieldBase, 4)} ${path.yieldBaseUnit}/yr  (~${formatUSD(path.yieldUsd)}/yr)`);
  }
  console.log('');
}

function printSummary(usdcAmount: number, paths: PathResult[], marketLines: string[]) {
  if (paths.length === 0) return;

  console.log(`  ${SEP}`);
  console.log(`  Summary: ${formatToken(usdcAmount, 2)} USDC\n`);
  for (const line of marketLines) console.log(line);
  if (marketLines.length > 0) console.log('');

  // Pre-compute columns so we can right-align numbers
  const rows = paths.map(p => ({
    path: p.name,
    route: p.label,
    amount: formatToken(p.finalAmount, 4),
    asset: p.asset,
    value: formatUSD(p.finalValue),
    cost: formatUSD(p.totalCost),
    pct: `${formatToken(p.costPct, 2)}%`,
    yield: p.yieldUsd != null ? `${formatUSD(p.yieldUsd)}/yr` : '—',
  }));

  // Compute max widths per column
  const wRoute = Math.max(5, ...rows.map(r => r.route.length));
  const wAmt = Math.max(6, ...rows.map(r => r.amount.length));
  const wAsset = Math.max(5, ...rows.map(r => r.asset.length));
  const wVal = Math.max(5, ...rows.map(r => r.value.length));
  const wCost = Math.max(4, ...rows.map(r => r.cost.length));
  const wPct = Math.max(6, ...rows.map(r => r.pct.length));
  const wYld = Math.max(5, ...rows.map(r => r.yield.length));

  // Print header
  const header = `  ${'Path'}  ${pad('Route', wRoute)}  ${'Amount'.padStart(wAmt)}  ${pad('Asset', wAsset)}  ${'Value'.padStart(wVal)}  ${'Cost'.padStart(wCost)}  ${'Cost %'.padStart(wPct)}  ${'Yield'.padStart(wYld)}`;
  console.log(header);
  console.log(`  ${'─'.repeat(4)}  ${'─'.repeat(wRoute)}  ${'─'.repeat(wAmt)}  ${'─'.repeat(wAsset)}  ${'─'.repeat(wVal)}  ${'─'.repeat(wCost)}  ${'─'.repeat(wPct)}  ${'─'.repeat(wYld)}`);

  for (const r of rows) {
    const line = `  ${pad(r.path, 4)}  ${pad(r.route, wRoute)}  ${r.amount.padStart(wAmt)}  ${pad(r.asset, wAsset)}  ${r.value.padStart(wVal)}  ${r.cost.padStart(wCost)}  ${r.pct.padStart(wPct)}  ${r.yield.padStart(wYld)}`;
    console.log(line);
  }

  // Cheapest path
  if (paths.length > 0) {
    const cheapest = paths.reduce((a, b) => a.costPct < b.costPct ? a : b);
    console.log(`\n  Cheapest: Path ${cheapest.name} — ${cheapest.label} (${formatToken(cheapest.costPct, 2)}% cost)`);
  }

  console.log(`  ${SEP}\n`);
}

// ── Main command ─────────────────────────────────────

export async function quoteCommand(amount: string, network: Network) {
  validateAmount(amount);
  const usdcAmount = Number(amount);
  const usdcRaw = BigInt(Math.round(usdcAmount * 1e6));
  const isMainnet = network === 'mainnet';
  const tokens = TOKENS[network];

  console.log(`\n  ── Quote: ${formatToken(usdcAmount, 2)} USDC -> Staked Assets ${LINE}`);
  console.log(`  Network: ${network}`);
  console.log('  Fetching quotes...\n');

  // Fire all API calls in parallel
  const [
    marketRes,
    cowEthRes,
    deBridgeSolRes,
    deBridgeUsdcRes,
    jupiterRes,
    stethRateRes,
    jitoRateRes,
    uniswapEthRes,
    lifiEthRes,
    lifiBridgeSolRes,
    lidoAprRes,
    jitoApyRes,
  ] = await Promise.allSettled([
    fetchMarketPrices(),
    fetchCowQuote(network, usdcRaw, tokens.WETH, tokens.WETH_DECIMALS),
    isMainnet
      ? fetchDeBridgeQuote(DEBRIDGE_CONFIG.tokens.USDC_ETH, DEBRIDGE_CONFIG.tokens.nativeSOL, usdcRaw.toString())
      : Promise.reject(new Error('mainnet only')),
    isMainnet
      ? fetchDeBridgeQuote(DEBRIDGE_CONFIG.tokens.USDC_ETH, DEBRIDGE_CONFIG.tokens.USDC_SOL, usdcRaw.toString())
      : Promise.reject(new Error('mainnet only')),
    isMainnet
      ? fetchJupiterQuote(usdcRaw.toString())
      : Promise.reject(new Error('mainnet only')),
    fetchStethRate(network),
    isMainnet
      ? fetchJitoRate()
      : Promise.reject(new Error('mainnet only')),
    fetchProviderSwapQuote('uniswap', network, usdcRaw, tokens.WETH, tokens.WETH_DECIMALS),
    fetchProviderSwapQuote('lifi', network, usdcRaw, tokens.WETH, tokens.WETH_DECIMALS),
    isMainnet
      ? fetchProviderBridgeQuote('lifi', DEBRIDGE_CONFIG.tokens.USDC_ETH, DEBRIDGE_CONFIG.tokens.nativeSOL, usdcRaw.toString())
      : Promise.reject(new Error('mainnet only')),
    fetchLidoApr(),
    isMainnet ? fetchJitoApy() : Promise.reject(new Error('mainnet only')),
  ]);

  // Extract results
  const market = marketRes.status === 'fulfilled' ? marketRes.value : { eth: null, sol: null };
  const stethRate = stethRateRes.status === 'fulfilled' ? stethRateRes.value : null;
  const jitoRate = jitoRateRes.status === 'fulfilled' ? jitoRateRes.value : null;
  const lidoApr = lidoAprRes.status === 'fulfilled' ? lidoAprRes.value : null;
  const jitoApy = jitoApyRes.status === 'fulfilled' ? jitoApyRes.value : null;

  // Market reference (printed in summary, after "Summary: X USDC")
  const marketLines: string[] = [];
  marketLines.push(`  ETH: ${market.eth ? formatUSD(market.eth) : 'N/A'}`);
  marketLines.push(`  SOL: ${market.sol ? formatUSD(market.sol) : 'N/A'}`);
  if (stethRate || jitoRate) {
    marketLines.push('');
    const rates: { lhs: string; rhs: string; apr: string }[] = [];
    if (stethRate) rates.push({ lhs: 'stETH', rhs: `${formatToken(stethRate, 4)} ETH`, apr: lidoApr != null ? `APR ${lidoApr.toFixed(2)}%` : '' });
    if (jitoRate) rates.push({ lhs: 'JitoSOL', rhs: `${formatToken(jitoRate, 4)} SOL`, apr: jitoApy != null ? `APY ${(jitoApy * 100).toFixed(2)}%` : '' });
    const wLhs = Math.max(...rates.map(r => r.lhs.length));
    const wRhs = Math.max(...rates.map(r => r.rhs.length));
    for (const r of rates) marketLines.push(`  ${r.lhs.padStart(wLhs)} = ${r.rhs.padEnd(wRhs)}  ${r.apr}`);
  }

  const paths: PathResult[] = [];

  // ── Path A: USDC → ETH (CoW) → stETH (Lido) ──

  if (cowEthRes.status === 'fulfilled') {
    const cow = cowEthRes.value;
    const ethReceived = cow.buyAmount;
    const stethReceived = ethReceived; // 1:1 at deposit
    const stethValue = market.eth ? stethReceived * market.eth : 0;
    const totalCost = stethValue > 0 ? usdcAmount - stethValue : 0;
    const costPct = stethValue > 0 ? (totalCost / usdcAmount) * 100 : 0;

    const pathA: PathResult = {
      name: 'A',
      label: 'CoW Swap + Lido',
      asset: 'stETH',
      steps: [
        {
          action: 'USDC -> ETH (CoW Swap)',
          input: `${formatToken(usdcAmount, 2)} USDC`,
          output: `${formatToken(ethReceived, 6)} ETH`,
          fee: `${formatUSD(cow.feeUsdc)}`,
          note: `Cost/ETH: ${formatUSD(cow.effectivePrice)}`,
        },
        {
          action: 'ETH -> stETH (Lido)',
          input: `${formatToken(ethReceived, 6)} ETH`,
          output: `${formatToken(stethReceived, 6)} stETH`,
          fee: 'gas only',
          note: '1:1 at deposit',
        },
      ],
      finalAmount: stethReceived,
      finalValue: stethValue,
      totalCost,
      costPct,
    };
    if (lidoApr != null && market.eth) {
      pathA.yieldBase = stethReceived * (lidoApr / 100);
      pathA.yieldBaseUnit = 'ETH';
      pathA.yieldUsd = pathA.yieldBase * market.eth;
    }
    paths.push(pathA);
  } else {
    console.log(`  ── Path A: CoW Swap + Lido ${LINE}`);
    console.log(`    Failed: ${cowEthRes.reason?.message || 'unknown error'}\n`);
  }

  // ── Path B: USDC → SOL (deBridge) → JitoSOL (Jito) ──

  if (deBridgeSolRes.status === 'fulfilled' && jitoRate) {
    const db = deBridgeSolRes.value;
    const solReceived = db.outputAmount;
    const jitoSolReceived = solReceived / jitoRate;
    const jitoSolValue = market.sol ? solReceived * market.sol : 0; // JitoSOL value = underlying SOL * price
    const totalCost = jitoSolValue > 0 ? usdcAmount - jitoSolValue : 0;
    const costPct = jitoSolValue > 0 ? (totalCost / usdcAmount) * 100 : 0;

    const pathB: PathResult = {
      name: 'B',
      label: 'deBridge + Jito',
      asset: 'JitoSOL',
      steps: [
        {
          action: 'USDC -> SOL (deBridge)',
          input: `${formatToken(usdcAmount, 2)} USDC`,
          output: `${formatToken(solReceived, 4)} SOL`,
          fee: db.protocolFeeEth > 0 ? `~${formatToken(db.protocolFeeEth, 6)} ETH protocol fee` : 'included in rate',
          note: `Cost/SOL: ${formatUSD(usdcAmount / solReceived)}`,
        },
        {
          action: 'SOL -> JitoSOL (Jito)',
          input: `${formatToken(solReceived, 4)} SOL`,
          output: `${formatToken(jitoSolReceived, 4)} JitoSOL`,
          fee: 'gas only (~$0.01)',
        },
      ],
      finalAmount: jitoSolReceived,
      finalValue: jitoSolValue,
      totalCost,
      costPct,
    };
    if (jitoApy != null && market.sol) {
      pathB.yieldBase = solReceived * jitoApy;
      pathB.yieldBaseUnit = 'SOL';
      pathB.yieldUsd = pathB.yieldBase * market.sol;
    }
    paths.push(pathB);
  } else if (isMainnet) {
    console.log(`  ── Path B: deBridge + Jito ${LINE}`);
    const msg = deBridgeSolRes.status === 'rejected' ? deBridgeSolRes.reason?.message : 'Jito rate unavailable';
    console.log(`    Failed: ${msg}\n`);
  }

  // ── Path C: USDC → USDC-SOL (deBridge) → SOL (Jupiter) → JitoSOL (Jito) ──

  if (deBridgeUsdcRes.status === 'fulfilled' && jupiterRes.status === 'fulfilled' && jitoRate) {
    const dbUsdc = deBridgeUsdcRes.value;
    const jup = jupiterRes.value;
    const usdcSolReceived = dbUsdc.outputAmount;
    // Use Jupiter's per-SOL price applied to actual USDC-SOL received
    const solFromJupiter = usdcSolReceived / jup.pricePerSol;
    const jitoSolReceived = solFromJupiter / jitoRate;
    const solValue = market.sol ? solFromJupiter * market.sol : 0;
    const totalCost = solValue > 0 ? usdcAmount - solValue : 0;
    const costPct = solValue > 0 ? (totalCost / usdcAmount) * 100 : 0;

    const pathC: PathResult = {
      name: 'C',
      label: 'deBridge + Jupiter + Jito',
      asset: 'JitoSOL',
      steps: [
        {
          action: 'USDC -> USDC-SOL (deBridge)',
          input: `${formatToken(usdcAmount, 2)} USDC`,
          output: `${formatToken(usdcSolReceived, 2)} USDC`,
          fee: dbUsdc.protocolFeeEth > 0 ? `~${formatToken(dbUsdc.protocolFeeEth, 6)} ETH protocol fee` : 'included in rate',
          note: `Bridge loss: ${formatUSD(usdcAmount - usdcSolReceived)}`,
        },
        {
          action: 'USDC -> SOL (Jupiter)',
          input: `${formatToken(usdcSolReceived, 2)} USDC`,
          output: `${formatToken(solFromJupiter, 4)} SOL`,
          fee: 'included in rate',
          note: `Cost/SOL: ${formatUSD(jup.pricePerSol)}`,
        },
        {
          action: 'SOL -> JitoSOL (Jito)',
          input: `${formatToken(solFromJupiter, 4)} SOL`,
          output: `${formatToken(jitoSolReceived, 4)} JitoSOL`,
          fee: 'gas only (~$0.01)',
        },
      ],
      finalAmount: jitoSolReceived,
      finalValue: solValue,
      totalCost,
      costPct,
    };
    if (jitoApy != null && market.sol) {
      pathC.yieldBase = solFromJupiter * jitoApy;
      pathC.yieldBaseUnit = 'SOL';
      pathC.yieldUsd = pathC.yieldBase * market.sol;
    }
    paths.push(pathC);
  } else if (isMainnet) {
    console.log(`  ── Path C: deBridge + Jupiter + Jito ${LINE}`);
    const msgs: string[] = [];
    if (deBridgeUsdcRes.status === 'rejected') msgs.push(`deBridge: ${deBridgeUsdcRes.reason?.message}`);
    if (jupiterRes.status === 'rejected') msgs.push(`Jupiter: ${jupiterRes.reason?.message}`);
    if (!jitoRate) msgs.push('Jito rate unavailable');
    console.log(`    Failed: ${msgs.join(', ')}\n`);
  }

  // ── Path D: USDC → ETH (Uniswap) → stETH (Lido) ──

  if (uniswapEthRes.status === 'fulfilled') {
    const uni = uniswapEthRes.value;
    const ethReceived = uni.buyAmount;
    const stethReceived = ethReceived;
    const stethValue = market.eth ? stethReceived * market.eth : 0;
    const totalCost = stethValue > 0 ? usdcAmount - stethValue : 0;
    const costPct = stethValue > 0 ? (totalCost / usdcAmount) * 100 : 0;

    const pathD: PathResult = {
      name: 'D',
      label: 'Uniswap + Lido',
      asset: 'stETH',
      steps: [
        {
          action: 'USDC -> ETH (Uniswap)',
          input: `${formatToken(usdcAmount, 2)} USDC`,
          output: `${formatToken(ethReceived, 6)} ETH`,
          fee: uni.feeUsdc > 0 ? formatUSD(uni.feeUsdc) : formatGasFee(uni.gasFeeUSD, true) || 'included',
          note: `Cost/ETH: ${formatUSD(uni.effectivePrice)}`,
        },
        {
          action: 'ETH -> stETH (Lido)',
          input: `${formatToken(ethReceived, 6)} ETH`,
          output: `${formatToken(stethReceived, 6)} stETH`,
          fee: 'gas only',
          note: '1:1 at deposit',
        },
      ],
      finalAmount: stethReceived,
      finalValue: stethValue,
      totalCost,
      costPct,
    };
    if (lidoApr != null && market.eth) {
      pathD.yieldBase = stethReceived * (lidoApr / 100);
      pathD.yieldBaseUnit = 'ETH';
      pathD.yieldUsd = pathD.yieldBase * market.eth;
    }
    paths.push(pathD);
  } else {
    const msg = uniswapEthRes.reason?.message || 'unknown error';
    if (!msg.includes('UNISWAP_API_KEY')) {
      console.log(`  ── Path D: Uniswap + Lido ${LINE}`);
      console.log(`    Failed: ${msg}\n`);
    }
  }

  // ── Path E: USDC → ETH (LI.FI) → stETH (Lido) ──

  if (lifiEthRes.status === 'fulfilled') {
    const lifi = lifiEthRes.value;
    const ethReceived = lifi.buyAmount;
    const stethReceived = ethReceived;
    const stethValue = market.eth ? stethReceived * market.eth : 0;
    const totalCost = stethValue > 0 ? usdcAmount - stethValue : 0;
    const costPct = stethValue > 0 ? (totalCost / usdcAmount) * 100 : 0;

    const pathE: PathResult = {
      name: 'E',
      label: 'LI.FI + Lido',
      asset: 'stETH',
      steps: [
        {
          action: 'USDC -> ETH (LI.FI)',
          input: `${formatToken(usdcAmount, 2)} USDC`,
          output: `${formatToken(ethReceived, 6)} ETH`,
          fee: lifi.feeUsdc > 0 ? `${formatUSD(lifi.feeUsdc)}` : 'included in rate',
          note: `Cost/ETH: ${formatUSD(lifi.effectivePrice)}`,
        },
        {
          action: 'ETH -> stETH (Lido)',
          input: `${formatToken(ethReceived, 6)} ETH`,
          output: `${formatToken(stethReceived, 6)} stETH`,
          fee: 'gas only',
          note: '1:1 at deposit',
        },
      ],
      finalAmount: stethReceived,
      finalValue: stethValue,
      totalCost,
      costPct,
    };
    if (lidoApr != null && market.eth) {
      pathE.yieldBase = stethReceived * (lidoApr / 100);
      pathE.yieldBaseUnit = 'ETH';
      pathE.yieldUsd = pathE.yieldBase * market.eth;
    }
    paths.push(pathE);
  } else {
    console.log(`  ── Path E: LI.FI + Lido ${LINE}`);
    console.log(`    Failed: ${lifiEthRes.reason?.message || 'unknown error'}\n`);
  }

  // ── Path F: USDC → SOL (LI.FI Bridge) → JitoSOL (Jito) ──

  if (lifiBridgeSolRes.status === 'fulfilled' && jitoRate) {
    const lb = lifiBridgeSolRes.value;
    const solReceived = lb.outputAmount;
    const jitoSolReceived = solReceived / jitoRate;
    const jitoSolValue = market.sol ? solReceived * market.sol : 0;
    const totalCost = jitoSolValue > 0 ? usdcAmount - jitoSolValue : 0;
    const costPct = jitoSolValue > 0 ? (totalCost / usdcAmount) * 100 : 0;

    const pathF: PathResult = {
      name: 'F',
      label: 'LI.FI Bridge + Jito',
      asset: 'JitoSOL',
      steps: [
        {
          action: 'USDC -> SOL (LI.FI Bridge)',
          input: `${formatToken(usdcAmount, 2)} USDC`,
          output: `${formatToken(solReceived, 4)} SOL`,
          fee: lb.protocolFeeEth > 0 ? `~${formatToken(lb.protocolFeeEth, 6)} ETH protocol fee` : 'included in rate',
          note: `Cost/SOL: ${formatUSD(usdcAmount / solReceived)}`,
        },
        {
          action: 'SOL -> JitoSOL (Jito)',
          input: `${formatToken(solReceived, 4)} SOL`,
          output: `${formatToken(jitoSolReceived, 4)} JitoSOL`,
          fee: 'gas only (~$0.01)',
        },
      ],
      finalAmount: jitoSolReceived,
      finalValue: jitoSolValue,
      totalCost,
      costPct,
    };
    if (jitoApy != null && market.sol) {
      pathF.yieldBase = solReceived * jitoApy;
      pathF.yieldBaseUnit = 'SOL';
      pathF.yieldUsd = pathF.yieldBase * market.sol;
    }
    paths.push(pathF);
  } else if (isMainnet) {
    console.log(`  ── Path F: LI.FI Bridge + Jito ${LINE}`);
    const msg = lifiBridgeSolRes.status === 'rejected' ? lifiBridgeSolRes.reason?.message : 'Jito rate unavailable';
    console.log(`    Failed: ${msg}\n`);
  }

  // Testnet note
  if (!isMainnet && paths.length <= 1) {
    console.log('  Note: deBridge, Jupiter, Jito, and LI.FI Bridge are mainnet-only.');
    console.log('  Some paths only available on mainnet.\n');
  }

  // Group by asset (stETH first, then JitoSOL), sorted by cost within each group
  const stethPaths = paths.filter(p => p.asset === 'stETH').sort((a, b) => a.costPct - b.costPct);
  const jitoPaths = paths.filter(p => p.asset !== 'stETH').sort((a, b) => a.costPct - b.costPct);
  const sorted = [...stethPaths, ...jitoPaths];

  // Print each path
  for (const path of sorted) {
    printPath(path);
  }

  // Summary table
  printSummary(usdcAmount, sorted, marketLines);
}

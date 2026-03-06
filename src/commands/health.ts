import { createPublicClient, http, parseAbi } from 'viem';
import { mainnet, sepolia } from 'viem/chains';
import { Connection, PublicKey } from '@solana/web3.js';
import { getStakePoolAccount } from '@solana/spl-stake-pool';
import { DEBRIDGE_CONFIG, COW_CONFIG, UNISWAP_CONFIG, LIFI_CONFIG, JUPITER_CONFIG, SOLANA_CONFIG, TOKENS, LIDO_CONFIG, JITO_CONFIG, STAKING_URLS, ETHERSCAN_API, ETHERSCAN_CHAIN_ID, getEvmRpcUrl } from '../config.js';
import { resolveSigner } from '../signers/index.js';
import { formatToken } from '../lib/format.js';
import { listSwapProviders } from '../providers/registry.js';
import { fetchLidoApr, fetchJitoApy } from '../lib/staking.js';
import { fetchPrices as fetchPricesWithFallback } from '../lib/prices.js';

const SEP = '──────────────────────────────────────────';
const TIMEOUT = 5000;
const PRICE_TIMEOUT = 8000;

type Status = 'OK' | 'SLOW' | 'DOWN';

interface CheckResult {
  status: Status;
  detail?: string;
  latency?: number;
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), ms)),
  ]);
}

async function checkEvmRpc(network: 'mainnet' | 'testnet'): Promise<CheckResult> {
  const start = Date.now();
  try {
    const client = createPublicClient({
      chain: network === 'mainnet' ? mainnet : sepolia,
      transport: http(getEvmRpcUrl(network)),
    });
    const block = await withTimeout(client.getBlockNumber(), TIMEOUT);
    const latency = Date.now() - start;
    return { status: latency > 2000 ? 'SLOW' : 'OK', detail: `block ${block}`, latency };
  } catch {
    return { status: 'DOWN', latency: Date.now() - start };
  }
}

async function checkSolanaRpc(network: 'mainnet' | 'testnet'): Promise<CheckResult> {
  const start = Date.now();
  try {
    const conn = new Connection(SOLANA_CONFIG[network].rpc);
    const slot = await withTimeout(conn.getSlot(), TIMEOUT);
    const latency = Date.now() - start;
    return { status: latency > 2000 ? 'SLOW' : 'OK', detail: `slot ${slot}`, latency };
  } catch {
    return { status: 'DOWN', latency: Date.now() - start };
  }
}

async function checkCowSwap(): Promise<CheckResult> {
  const start = Date.now();
  try {
    const res = await withTimeout(fetch(`${COW_CONFIG.mainnet.api}/api/v1/app_data/0x0000000000000000000000000000000000000000000000000000000000000000`), TIMEOUT);
    const latency = Date.now() - start;
    return { status: latency > 2000 ? 'SLOW' : res.ok ? 'OK' : 'DOWN', latency };
  } catch {
    return { status: 'DOWN', latency: Date.now() - start };
  }
}

async function checkDeBridge(): Promise<CheckResult> {
  const start = Date.now();
  try {
    // check status API — accept 404/422 as "up" (invalid order ID is expected)
    // the order API is validated by the price quote in getDeBridgeSolPrice()
    const statusApi = await withTimeout(
      fetch(`${DEBRIDGE_CONFIG.statusApi}/Orders/0x0000`),
      TIMEOUT,
    );
    const latency = Date.now() - start;
    const ok = statusApi.ok || statusApi.status === 404 || statusApi.status === 422;
    return { status: latency > 2000 ? 'SLOW' : ok ? 'OK' : 'DOWN', latency };
  } catch {
    return { status: 'DOWN', latency: Date.now() - start };
  }
}

async function checkLido(): Promise<CheckResult> {
  const start = Date.now();
  try {
    const client = createPublicClient({
      chain: mainnet,
      transport: http(getEvmRpcUrl('mainnet')),
    });
    // Check stETH total supply — confirms the contract is alive and reachable
    const supply = await withTimeout(client.readContract({
      address: LIDO_CONFIG.mainnet.stETH,
      abi: parseAbi(['function totalSupply() view returns (uint256)']),
      functionName: 'totalSupply',
    }), TIMEOUT);
    const latency = Date.now() - start;
    const supplyEth = Math.round(Number(supply) / 1e18).toLocaleString('en-US');
    return { status: latency > 2000 ? 'SLOW' : 'OK', detail: `${supplyEth} stETH`, latency };
  } catch {
    return { status: 'DOWN', latency: Date.now() - start };
  }
}

async function checkJito(): Promise<CheckResult> {
  const start = Date.now();
  try {
    const conn = new Connection(SOLANA_CONFIG.mainnet.rpc);
    const pool = await withTimeout(
      getStakePoolAccount(conn, new PublicKey(JITO_CONFIG.stakePool)),
      TIMEOUT,
    );
    const latency = Date.now() - start;
    const data = pool.account.data;
    const rate = Number(data.totalLamports) / Number(data.poolTokenSupply);
    return { status: latency > 2000 ? 'SLOW' : 'OK', detail: `1 JitoSOL = ${formatToken(rate, 4)} SOL`, latency };
  } catch {
    return { status: 'DOWN', latency: Date.now() - start };
  }
}

async function checkEtherscan(): Promise<CheckResult> {
  const apiKey = process.env.ETHERSCAN_API_KEY;
  if (!apiKey) return { status: 'DOWN', detail: 'no API key' };
  const start = Date.now();
  try {
    const params = new URLSearchParams({
      chainid: ETHERSCAN_CHAIN_ID.mainnet,
      module: 'account',
      action: 'txlist',
      address: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045',
      startblock: '0',
      endblock: '99999999',
      page: '1',
      offset: '1',
      sort: 'desc',
      apikey: apiKey,
    });
    const res = await withTimeout(fetch(`${ETHERSCAN_API}?${params}`), TIMEOUT);
    const latency = Date.now() - start;
    if (!res.ok) return { status: 'DOWN', detail: `HTTP ${res.status}`, latency };
    const data = (await res.json()) as { status: string; message: string; result: unknown };
    if (data.status !== '1' || !Array.isArray(data.result)) {
      const msg = typeof data.result === 'string' ? data.result : data.message;
      return { status: 'DOWN', detail: msg, latency };
    }
    return { status: latency > 2000 ? 'SLOW' : 'OK', detail: 'V2 API', latency };
  } catch {
    return { status: 'DOWN', latency: Date.now() - start };
  }
}

async function checkUniswap(): Promise<CheckResult> {
  const apiKey = process.env.UNISWAP_API_KEY;
  if (!apiKey) return { status: 'DOWN', detail: 'no API key' };
  const start = Date.now();
  try {
    // Lightweight check — check_approval is faster than a full quote
    const res = await withTimeout(fetch(`${UNISWAP_CONFIG.api}/check_approval`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
      body: JSON.stringify({
        token: TOKENS.mainnet.USDC,
        amount: '1000000',
        walletAddress: '0x0000000000000000000000000000000000000001',
        chainId: 1,
      }),
    }), TIMEOUT);
    const latency = Date.now() - start;
    return { status: latency > 2000 ? 'SLOW' : res.ok ? 'OK' : 'DOWN', latency };
  } catch {
    return { status: 'DOWN', latency: Date.now() - start };
  }
}

async function checkLifi(): Promise<CheckResult> {
  const start = Date.now();
  try {
    // Check the /chains endpoint — lightweight, no API key needed
    const res = await withTimeout(fetch(`${LIFI_CONFIG.api}/chains`), TIMEOUT);
    const latency = Date.now() - start;
    return { status: latency > 2000 ? 'SLOW' : res.ok ? 'OK' : 'DOWN', latency };
  } catch {
    return { status: 'DOWN', latency: Date.now() - start };
  }
}

async function checkSpritz(): Promise<CheckResult> {
  const apiKey = process.env.SPRITZ_API_KEY;
  if (!apiKey) return { status: 'DOWN', detail: 'no API key' };
  const start = Date.now();
  try {
    const { getSpritzClient } = await import('../lib/spritz.js');
    const client = getSpritzClient();
    const accounts = await withTimeout(client.bankAccount.list(), TIMEOUT);
    const latency = Date.now() - start;
    return { status: latency > 2000 ? 'SLOW' : 'OK', detail: `${accounts.length} bank account(s)`, latency };
  } catch {
    return { status: 'DOWN', latency: Date.now() - start };
  }
}

async function checkJupiter(): Promise<CheckResult> {
  const start = Date.now();
  try {
    // Lightweight quote check
    const params = new URLSearchParams({
      inputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
      outputMint: 'So11111111111111111111111111111111111111112', // SOL
      amount: '1000000', // 1 USDC
      slippageBps: '50',
    });
    const res = await withTimeout(fetch(`${JUPITER_CONFIG.api}/quote?${params}`), TIMEOUT);
    const latency = Date.now() - start;
    return { status: latency > 2000 ? 'SLOW' : res.ok ? 'OK' : 'DOWN', latency };
  } catch {
    return { status: 'DOWN', latency: Date.now() - start };
  }
}

// ── Price fetchers ──

/** Market price (CoinGecko → DeFi Llama fallback) */
async function getMarketPrices(): Promise<{ eth: number | null; sol: number | null }> {
  try {
    const p = await withTimeout(fetchPricesWithFallback(['eth', 'sol']), TIMEOUT);
    return {
      eth: p.eth ?? null,
      sol: p.sol ?? null,
    };
  } catch {
    return { eth: null, sol: null };
  }
}

// ── Multi-provider price fetchers ──

interface SwapPriceResult {
  provider: string;
  price: number;     // effective USD per ETH
  fee: number;       // fee in USDC
  gasless: boolean;
  gasFeeUSD?: string;
}

interface BridgePriceResult {
  provider: string;
  price: number;     // effective USD per SOL
}

/** Execution prices from all swap providers (1000 USDC → ETH) */
async function getSwapEthPrices(): Promise<SwapPriceResult[]> {
  const providers = listSwapProviders();
  let fromAddress = '0x0000000000000000000000000000000000000001';
  try { fromAddress = (await (await resolveSigner()).getEvmAccount()).address; } catch {}

  const results = await Promise.allSettled(providers.map(async (p) => {
    const quote = await withTimeout(p.getQuote({
      sellToken: TOKENS.mainnet.USDC,
      buyToken: TOKENS.mainnet.WETH,
      amount: '1000000000', // 1000 USDC (6 decimals)
      kind: 'sell',
      from: fromAddress,
      network: 'mainnet',
    }), PRICE_TIMEOUT);
    const buyEth = Number(quote.buyAmount) / 1e18;
    return {
      provider: p.displayName,
      price: 1000 / buyEth,
      fee: Number(quote.feeAmount) / 1e6,
      gasless: quote.gasless,
      gasFeeUSD: quote.gasFeeUSD,
    };
  }));

  return results
    .filter((r): r is PromiseFulfilledResult<SwapPriceResult> => r.status === 'fulfilled')
    .map(r => r.value);
}

/** Execution prices from bridge providers (100 USDC → SOL).
 *  Uses direct API calls — provider.getQuote() adds enableEstimate which requires funded wallets. */
async function getBridgeSolPrices(): Promise<BridgePriceResult[]> {
  let dstAddress = 'DRpbCBMxVnDK7maPM5tGv6MvB3v1sRMC86PZ8okm21hy';
  let srcAddress = '0x0000000000000000000000000000000000000001';
  try {
    const signer = await resolveSigner();
    srcAddress = (await signer.getEvmAccount()).address;
    const solAddr = await signer.getSolanaAddress();
    if (solAddr) dstAddress = solAddr;
  } catch {}

  const debridgeQuote = async (): Promise<BridgePriceResult> => {
    const db = DEBRIDGE_CONFIG;
    const params = new URLSearchParams({
      srcChainId: '1',
      srcChainTokenIn: db.tokens.USDC_ETH,
      srcChainTokenInAmount: '100000000',
      dstChainId: '7565164',
      dstChainTokenOut: db.tokens.nativeSOL,
      dstChainTokenOutAmount: 'auto',
      dstChainTokenOutRecipient: dstAddress,
      srcChainOrderAuthorityAddress: srcAddress,
      dstChainOrderAuthorityAddress: dstAddress,
    });
    const res = await withTimeout(fetch(`${db.api}/dln/order/create-tx?${params}`), PRICE_TIMEOUT);
    if (!res.ok) throw new Error('deBridge quote failed');
    const data = (await res.json()) as { estimation: { dstChainTokenOut: { amount: string; decimals: number; recommendedAmount?: string } } };
    const out = data.estimation.dstChainTokenOut;
    const solOut = Number(out.recommendedAmount || out.amount) / 10 ** out.decimals;
    return { provider: 'deBridge', price: 100 / solOut };
  };

  const lifiQuote = async (): Promise<BridgePriceResult> => {
    const params = new URLSearchParams({
      fromChain: '1',
      toChain: '1151111081099710', // Solana (LI.FI format)
      fromToken: DEBRIDGE_CONFIG.tokens.USDC_ETH,
      toToken: DEBRIDGE_CONFIG.tokens.nativeSOL,
      fromAmount: '100000000',
      fromAddress: srcAddress,
      toAddress: dstAddress,
      slippage: '0.005',
    });
    const res = await withTimeout(fetch(`${LIFI_CONFIG.api}/quote?${params}`), PRICE_TIMEOUT);
    if (!res.ok) throw new Error('LI.FI bridge quote failed');
    const data = (await res.json()) as { estimate: { toAmount: string }; action: { toToken: { decimals: number } } };
    const solOut = Number(data.estimate.toAmount) / (10 ** data.action.toToken.decimals);
    return { provider: 'LI.FI (Jumper)', price: 100 / solOut };
  };

  const results = await Promise.allSettled([debridgeQuote(), lifiQuote()]);
  return results
    .filter((r): r is PromiseFulfilledResult<BridgePriceResult> => r.status === 'fulfilled')
    .map(r => r.value);
}

/** Jupiter execution price (Solana DEX: 100 USDC → SOL) */
async function getJupiterSolPrice(): Promise<number | null> {
  try {
    const params = new URLSearchParams({
      inputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      outputMint: 'So11111111111111111111111111111111111111112',
      amount: '100000000', // 100 USDC
      slippageBps: '50',
    });
    const res = await withTimeout(fetch(`${JUPITER_CONFIG.api}/quote?${params}`), PRICE_TIMEOUT);
    if (!res.ok) return null;
    const data = (await res.json()) as { outAmount: string };
    const solOut = Number(data.outAmount) / 1e9;
    return 100 / solOut;
  } catch {
    return null;
  }
}

function statusIcon(s: Status): string {
  if (s === 'OK') return 'OK  ';
  if (s === 'SLOW') return 'SLOW';
  return 'DOWN';
}

function pad(s: string, len: number): string {
  return s.padEnd(len);
}

function formatSpread(exec: number | null, market: number | null): string {
  if (!exec || !market) return '';
  const pct = ((exec - market) / market) * 100;
  const sign = pct > 0 ? '+' : '';
  return `  (${sign}${pct.toFixed(2)}% vs market)`;
}

export async function healthCommand() {
  console.log('');
  console.log('  Checking services...\n');

  // Run all checks in parallel
  const [evmMain, evmTest, solMain, solTest, cow, uniswap, lifi, debridge, jupiter, etherscan, spritz, lido, jito, market, swapPrices, bridgePrices, jupSol, lidoApr, jitoApy] =
    await Promise.all([
      checkEvmRpc('mainnet'),
      checkEvmRpc('testnet'),
      checkSolanaRpc('mainnet'),
      checkSolanaRpc('testnet'),
      checkCowSwap(),
      checkUniswap(),
      checkLifi(),
      checkDeBridge(),
      checkJupiter(),
      checkEtherscan(),
      checkSpritz(),
      checkLido(),
      checkJito(),
      getMarketPrices(),
      getSwapEthPrices(),
      getBridgeSolPrices(),
      getJupiterSolPrice(),
      fetchLidoApr().catch(() => null),
      fetchJitoApy().catch(() => null),
    ]);

  // Build all check rows with separate columns for right-alignment
  const allChecks: { label: string; result: CheckResult; extra?: string }[] = [
    { label: 'Ethereum mainnet', result: evmMain },
    { label: 'Ethereum testnet', result: evmTest },
    { label: 'Solana mainnet', result: solMain },
    { label: 'Solana testnet', result: solTest },
    { label: 'CoW Swap', result: cow },
    { label: 'Uniswap', result: uniswap },
    { label: 'LI.FI (Jumper)', result: lifi },
    { label: 'deBridge', result: debridge },
    { label: 'Jupiter', result: jupiter },
    { label: 'Etherscan', result: etherscan },
    { label: 'Spritz (off-ramp)', result: spritz },
    { label: 'Lido (stETH)', result: lido, extra: lido.status !== 'DOWN' && lidoApr != null ? `APR ${lidoApr.toFixed(2)}%` : undefined },
    { label: 'Jito (JitoSOL)', result: jito, extra: jito.status !== 'DOWN' && jitoApy != null ? `APY ${(jitoApy * 100).toFixed(2)}%` : undefined },
  ];

  // Three columns: detail | extra (APR/APY) | status+latency
  const details = allChecks.map(c => formatCheckDetail(c.label, c.result));
  const extras = allChecks.map(c => c.extra ?? '');
  const statuses = allChecks.map(c => formatCheckStatus(c.result));
  const wDetail = Math.max(...details.map(d => d.length));
  const wExtra = Math.max(...extras.map(e => e.length));

  const printAligned = (idx: number) => {
    const d = details[idx].padEnd(wDetail);
    const e = extras[idx] ? `  ${extras[idx].padEnd(wExtra)}` : (wExtra > 0 ? `  ${' '.repeat(wExtra)}` : '');
    console.log(`${d}${e}  ${statuses[idx]}`);
  };

  // RPCs
  console.log(`  ── RPCs ${SEP}`);
  printAligned(0); printAligned(1); printAligned(2); printAligned(3);

  // Exchanges & Bridges
  console.log(`\n  ── Exchanges & Bridges ${SEP}`);
  printAligned(4); printAligned(5); printAligned(6); printAligned(7); printAligned(8); printAligned(9); printAligned(10);

  // Staking
  console.log(`\n  ── Staking ${SEP}`);
  printAligned(11); printAligned(12);

  // Prices — execution vs market
  console.log(`\n  ── Prices ${SEP}`);

  const fmtPrice = (p: number | null) => p ? `$${formatToken(p, 2)}` : 'unavailable';
  const pricePad = (s: string) => s.padEnd(24);

  console.log(`\n    ETH  (1000 USDC sell quote)`);
  console.log(`      ${pricePad('Market (CoinGecko):')} ${fmtPrice(market.eth)}`);
  for (const sp of swapPrices) {
    const spread = formatSpread(sp.price, market.eth);
    const tags: string[] = [];
    if (sp.gasless) tags.push('gasless');
    if (sp.fee > 0) tags.push(`fee $${formatToken(sp.fee, 2)}`);
    if (sp.gasFeeUSD) tags.push(`gas ~$${formatToken(parseFloat(sp.gasFeeUSD), 2)}`);
    const tagStr = tags.length ? `  ${tags.join(', ')}` : '';
    console.log(`      ${pricePad(sp.provider + ':')} ${fmtPrice(sp.price)}${spread}${tagStr}`);
  }
  if (swapPrices.length === 0) console.log(`      No swap quotes available`);

  console.log(`\n    SOL  (100 USDC → SOL)`);
  console.log(`      ${pricePad('Market (CoinGecko):')} ${fmtPrice(market.sol)}`);
  for (const bp of bridgePrices) {
    const spread = formatSpread(bp.price, market.sol);
    console.log(`      ${pricePad(bp.provider + ' (bridge):')} ${fmtPrice(bp.price)}${spread}`);
  }
  if (jupSol) {
    console.log(`      ${pricePad('Jupiter (Solana):')} ${fmtPrice(jupSol)}${formatSpread(jupSol, market.sol)}`);
  }
  if (bridgePrices.length === 0 && !jupSol) console.log(`      No SOL quotes available`);

  console.log('');
  console.log(`    Compare: https://www.coingecko.com/en/coins/ethereum`);
  console.log(`             https://www.coingecko.com/en/coins/solana`);

  console.log('');
}

function formatCheckDetail(label: string, result: CheckResult): string {
  const detail = result.detail ? `  ${result.detail}` : '';
  return `    ${pad(label + ':', 22)}${detail}`;
}

function formatCheckStatus(result: CheckResult): string {
  const icon = statusIcon(result.status);
  const latency = result.latency ? `  (${result.latency}ms)` : '';
  return `${icon}${latency}`;
}

function printCheck(label: string, result: CheckResult) {
  console.log(`${formatCheckDetail(label, result)}  ${formatCheckStatus(result)}`);
}

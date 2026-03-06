import { parseAbi } from 'viem';
import { Connection, PublicKey } from '@solana/web3.js';
import { getStakePoolAccount } from '@solana/spl-stake-pool';
import { type Network, type EvmChain, TOKENS, BASE_TOKENS, SOLANA_CONFIG, LIDO_CONFIG, JITO_CONFIG, WSOL_CONFIG, DEBRIDGE_CONFIG, COW_CONFIG, EXPLORERS } from '../config.js';
import { getPublicClient } from '../lib/evm.js';
import { getConnection } from '../lib/solana.js';
import { formatToken, formatUSD } from '../lib/format.js';

const SEP = '──────────────────────────────────────────';
const TIMEOUT = 8000;

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), ms)),
  ]);
}

function formatSupply(amount: number): string {
  if (amount >= 1e12) return `${(amount / 1e12).toFixed(2)}T`;
  if (amount >= 1e9) return `${(amount / 1e9).toFixed(2)}B`;
  if (amount >= 1e6) return `${(amount / 1e6).toFixed(2)}M`;
  if (amount >= 1e3) return `${(amount / 1e3).toFixed(1)}K`;
  return formatToken(amount, 2);
}

function formatMktCap(usd: number): string {
  if (usd >= 1e12) return `$${(usd / 1e12).toFixed(2)}T`;
  if (usd >= 1e9) return `$${(usd / 1e9).toFixed(2)}B`;
  if (usd >= 1e6) return `$${(usd / 1e6).toFixed(1)}M`;
  return formatUSD(usd, 0);
}

interface MarketPrices {
  eth: number | null;
  sol: number | null;
  wsolSupply: number | null;
}

async function getMarketPrices(): Promise<MarketPrices> {
  try {
    const res = await withTimeout(
      fetch('https://api.coingecko.com/api/v3/simple/price?ids=ethereum,solana,wrapped-solana&vs_currencies=usd&include_market_cap=true'),
      TIMEOUT,
    );
    if (!res.ok) return { eth: null, sol: null, wsolSupply: null };
    const data = (await res.json()) as {
      ethereum?: { usd: number };
      solana?: { usd: number };
      'wrapped-solana'?: { usd: number; usd_market_cap: number };
    };
    const solPrice = data.solana?.usd ?? null;
    const wsolMktCap = data['wrapped-solana']?.usd_market_cap ?? null;
    const wsolPrice = data['wrapped-solana']?.usd ?? null;
    // Derive supply from market_cap / price (on-chain getTokenSupply returns 0 for native SOL mint)
    const wsolSupply = (wsolMktCap && wsolPrice) ? wsolMktCap / wsolPrice : null;
    return { eth: data.ethereum?.usd ?? null, sol: solPrice, wsolSupply };
  } catch {
    return { eth: null, sol: null, wsolSupply: null };
  }
}

const ERC20_ABI = parseAbi(['function totalSupply() view returns (uint256)']);

async function getErc20Supply(network: Network, address: string, decimals: number, chain?: EvmChain): Promise<number | null> {
  try {
    const client = getPublicClient(network, chain);
    const supply = await withTimeout(client.readContract({
      address: address as `0x${string}`,
      abi: ERC20_ABI,
      functionName: 'totalSupply',
    }), TIMEOUT);
    return Number(supply) / (10 ** decimals);
  } catch {
    return null;
  }
}

async function getSplSupply(network: Network, mint: string): Promise<number | null> {
  try {
    const conn = getConnection(network);
    const supply = await withTimeout(conn.getTokenSupply(new PublicKey(mint)), TIMEOUT);
    return Number(supply.value.amount) / (10 ** supply.value.decimals);
  } catch {
    return null;
  }
}

export async function tokensCommand(network: Network) {
  const tokens = TOKENS[network];
  const baseTokensCfg = BASE_TOKENS[network];
  const solConfig = SOLANA_CONFIG[network];
  const lido = LIDO_CONFIG[network];
  const explorer = EXPLORERS[network];

  console.log(`\n  Network: ${network}`);
  console.log(`  Use the lowercase name in commands: wallet swap 100 usdc eth`);
  console.log(`  Fetching on-chain data...\n`);

  // Fetch everything in parallel
  const [
    prices,
    usdcSupply, wethSupply, wsolEthSupply, stethSupply,
    baseUsdcSupply,
    solUsdcSupply, jitosolSupply,
    jitoPool,
  ] = await Promise.all([
    getMarketPrices(),
    // EVM ERC-20 supplies
    getErc20Supply(network, tokens.USDC, tokens.USDC_DECIMALS),
    getErc20Supply(network, tokens.WETH, tokens.WETH_DECIMALS),
    getErc20Supply(network, tokens.WSOL, tokens.WSOL_DECIMALS),
    getErc20Supply(network, lido.stETH, 18),
    // Base ERC-20 supplies
    getErc20Supply(network, baseTokensCfg.USDC, baseTokensCfg.USDC_DECIMALS, 'base'),
    // Solana SPL supplies
    getSplSupply(network, solConfig.usdcMint),
    network === 'mainnet' ? getSplSupply(network, JITO_CONFIG.jitoSolMint) : Promise.resolve(null),
    // Staking pool
    network === 'mainnet' ? (async () => {
      try {
        const conn = getConnection(network);
        return await withTimeout(getStakePoolAccount(conn, new PublicKey(JITO_CONFIG.stakePool)), TIMEOUT);
      } catch { return null; }
    })() : Promise.resolve(null),
  ]);

  // Derived prices
  const ethPrice = prices.eth;
  const solPrice = prices.sol;
  const jitoRate = jitoPool ? Number(jitoPool.account.data.totalLamports) / Number(jitoPool.account.data.poolTokenSupply) : null;
  const jitoSolStaked = jitoPool ? Number(jitoPool.account.data.totalLamports) / 1e9 : null;

  // Helper to print supply + market cap
  const printSupplyLine = (supply: number | null, symbol: string, price: number | null) => {
    if (supply == null) return;
    const mktCap = price ? formatMktCap(supply * price) : '';
    console.log(`      Supply:   ${formatSupply(supply)} ${symbol}${mktCap ? `  (${mktCap} mkt cap)` : ''}`);
  };

  // EVM tokens
  console.log(`  ── Ethereum Tokens ${SEP}`);

  // ETH
  console.log(`\n    ETH — Ether (Native gas token)`);
  console.log(`      CLI name: eth`);
  console.log(`      Address:  (native)`);
  console.log(`      Decimals: 18`);
  if (ethPrice) console.log(`      Price:    ${formatUSD(ethPrice)}`);

  // USDC
  console.log(`\n    USDC — USD Coin`);
  console.log(`      CLI name: usdc`);
  console.log(`      Address:  ${tokens.USDC}`);
  console.log(`      Decimals: ${tokens.USDC_DECIMALS}`);
  printSupplyLine(usdcSupply, 'USDC', 1);
  console.log(`      Explorer: ${explorer.evm}/token/${tokens.USDC}`);

  // WETH
  console.log(`\n    WETH — Wrapped Ether`);
  console.log(`      CLI name: weth`);
  console.log(`      Address:  ${tokens.WETH}`);
  console.log(`      Decimals: ${tokens.WETH_DECIMALS}`);
  printSupplyLine(wethSupply, 'WETH', ethPrice);
  console.log(`      Explorer: ${explorer.evm}/token/${tokens.WETH}`);

  // WSOL-ETH
  console.log(`\n    WSOL-ETH — Wrapped SOL (Wormhole bridged SOL on Ethereum)`);
  console.log(`      CLI name: wsol-eth`);
  console.log(`      Address:  ${tokens.WSOL}`);
  console.log(`      Decimals: ${tokens.WSOL_DECIMALS}`);
  printSupplyLine(wsolEthSupply, 'WSOL-ETH', solPrice);
  console.log(`      Explorer: ${explorer.evm}/token/${tokens.WSOL}`);

  // stETH
  console.log(`\n    stETH — Lido Staked Ether (Liquid staking via Lido)`);
  console.log(`      CLI name: steth`);
  console.log(`      Address:  ${lido.stETH}`);
  console.log(`      Decimals: 18`);
  printSupplyLine(stethSupply, 'stETH', ethPrice);
  console.log(`      Explorer: ${explorer.evm}/token/${lido.stETH}`);

  // Base tokens
  console.log(`\n  ── Base Tokens ${SEP}`);

  // ETH-BASE
  console.log(`\n    ETH-BASE — Ether on Base (Native gas token)`);
  console.log(`      CLI name: eth-base`);
  console.log(`      Address:  (native)`);
  console.log(`      Decimals: 18`);
  if (ethPrice) console.log(`      Price:    ${formatUSD(ethPrice)}  (same as ETH)`);

  // USDC-BASE
  console.log(`\n    USDC-BASE — USD Coin on Base`);
  console.log(`      CLI name: usdc-base`);
  console.log(`      Address:  ${baseTokensCfg.USDC}`);
  console.log(`      Decimals: ${baseTokensCfg.USDC_DECIMALS}`);
  printSupplyLine(baseUsdcSupply, 'USDC', 1);
  console.log(`      Explorer: ${explorer.base}/token/${baseTokensCfg.USDC}`);

  // Solana tokens
  console.log(`\n  ── Solana Tokens ${SEP}`);

  // SOL
  console.log(`\n    SOL — Solana (Native gas token)`);
  console.log(`      CLI name: sol`);
  console.log(`      Address:  (native)`);
  console.log(`      Decimals: 9`);
  if (solPrice) console.log(`      Price:    ${formatUSD(solPrice)}`);

  // WSOL
  console.log(`\n    WSOL — Wrapped SOL (SPL-wrapped native SOL)`);
  console.log(`      CLI name: wsol`);
  console.log(`      Address:  ${WSOL_CONFIG.mint}`);
  console.log(`      Decimals: ${WSOL_CONFIG.decimals}`);
  if (solPrice) console.log(`      Price:    ${formatUSD(solPrice)}  (1:1 with SOL)`);
  printSupplyLine(prices.wsolSupply, 'WSOL', solPrice);
  const wsolExplorer = network === 'testnet'
    ? `${explorer.solana}/address/${WSOL_CONFIG.mint}?cluster=devnet`
    : `${explorer.solana}/token/${WSOL_CONFIG.mint}`;
  console.log(`      Explorer: ${wsolExplorer}`);

  // USDC (Solana)
  console.log(`\n    USDC — USD Coin (Solana)`);
  console.log(`      CLI name: usdc`);
  console.log(`      Address:  ${solConfig.usdcMint}`);
  console.log(`      Decimals: 6`);
  printSupplyLine(solUsdcSupply, 'USDC', 1);
  const solUsdcExplorer = network === 'testnet'
    ? `${explorer.solana}/address/${solConfig.usdcMint}?cluster=devnet`
    : `${explorer.solana}/token/${solConfig.usdcMint}`;
  console.log(`      Explorer: ${solUsdcExplorer}`);

  // JitoSOL (mainnet only)
  if (network === 'mainnet') {
    console.log(`\n    JitoSOL — Jito Staked SOL (Liquid staking via Jito)`);
    console.log(`      CLI name: jitosol`);
    console.log(`      Address:  ${JITO_CONFIG.jitoSolMint}`);
    console.log(`      Decimals: 9`);
    if (jitoRate && solPrice) {
      console.log(`      Price:    ${formatUSD(jitoRate * solPrice)}  (1 JitoSOL = ${formatToken(jitoRate, 4)} SOL)`);
    }
    printSupplyLine(jitosolSupply, 'JitoSOL', jitoRate && solPrice ? jitoRate * solPrice : null);
    console.log(`      Explorer: ${explorer.solana}/token/${JITO_CONFIG.jitoSolMint}`);
  }

  // Contracts + TVL
  console.log(`\n  ── Contracts ${SEP}`);
  const cow = COW_CONFIG[network];

  console.log(`\n    CoW Swap Vault Relayer`);
  console.log(`      Address:  ${cow.vaultRelayer}`);
  console.log(`      Explorer: ${explorer.evm}/address/${cow.vaultRelayer}`);

  console.log(`\n    CoW Swap Settlement`);
  console.log(`      Address:  ${cow.settlement}`);
  console.log(`      Explorer: ${explorer.evm}/address/${cow.settlement}`);

  console.log(`\n    Lido stETH`);
  console.log(`      Address:  ${lido.stETH}`);
  if (stethSupply != null && ethPrice) {
    console.log(`      TVL:      ${formatSupply(stethSupply)} stETH  (${formatMktCap(stethSupply * ethPrice)})`);
  }
  console.log(`      Explorer: ${explorer.evm}/address/${lido.stETH}`);

  console.log(`\n    Lido Withdrawal Queue`);
  console.log(`      Address:  ${lido.withdrawalQueue}`);
  console.log(`      Explorer: ${explorer.evm}/address/${lido.withdrawalQueue}`);

  if (network === 'mainnet') {
    console.log(`\n    Jito Stake Pool`);
    console.log(`      Address:  ${JITO_CONFIG.stakePool}`);
    if (jitoSolStaked != null && solPrice) {
      console.log(`      TVL:      ${formatSupply(jitoSolStaked)} SOL  (${formatMktCap(jitoSolStaked * solPrice)})`);
    }
    if (jitoRate) {
      console.log(`      Rate:     1 JitoSOL = ${formatToken(jitoRate, 4)} SOL`);
    }
    console.log(`      Explorer: ${explorer.solana}/account/${JITO_CONFIG.stakePool}`);
  }

  console.log('');
}

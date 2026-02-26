import { type Network, TOKENS, COW_CONFIG, EXPLORERS, SOLANA_MINTS, HISTORY_LIMIT, getEvmAccount, getSolanaKeypair, getSolanaAddress } from '../config.js';
import { getPublicClient, getERC20Balance, getERC20Allowance, approveERC20, unwrapWeth, waitForReceipt } from '../lib/evm.js';
import { getConnection, getSolBalance, getSplTokenBalance } from '../lib/solana.js';
import { getJupiterQuote, buildAndSendJupiterSwap, getSolanaMint, getSolanaDecimals } from '../lib/jupiter.js';
import { parseTokenAmount, formatToken, formatAddress, formatGasFee } from '../lib/format.js';
import { confirm, select, validateAmount, warnMainnet, warnDryRun } from '../lib/prompt.js';
import { resolveSwapProvider } from '../lib/config.js';
import { getSwapProvider, listSwapProviders } from '../providers/registry.js';
import type { SwapProvider, SwapQuote } from '../providers/types.js';
import { BalanceTracker, evmTokens, solTokens } from '../lib/balancedelta.js';

const SEP = '──────────────────────────────────────────';
const QUOTE_TIMEOUT = 15_000;

function termLink(text: string, url: string): string {
  return `\x1b]8;;${url}\x07${text}\x1b]8;;\x07`;
}

const COW_EXPLORER: Record<Network, string> = {
  mainnet: 'https://explorer.cow.fi/orders',
  testnet: 'https://explorer.cow.fi/sepolia/orders',
};

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), ms)),
  ]);
}

export async function swapCommand(
  amount: string,
  fromToken: string,
  toToken: string,
  network: Network,
  dryRun: boolean,
  providerFlag?: string,
) {
  const from = fromToken.toUpperCase();
  const to = toToken.toUpperCase();
  const isAll = amount.toLowerCase() === 'all';
  if (!isAll) validateAmount(amount);

  if (from === to) {
    console.error('  Cannot swap a token for itself.');
    process.exit(1);
  }

  // Solana swap pairs (via Jupiter)
  const solanaPairs = new Set(['USDC-SOL', 'SOL-USDC']);
  if (solanaPairs.has(`${from}-${to}`)) {
    await swapSolana(isAll ? 'all' : amount, from, to, network, dryRun);
    return;
  }

  if (isAll) {
    console.error('  "all" is only supported for Solana swaps (usdc<->sol) currently.');
    process.exit(1);
  }

  if (!['USDC', 'ETH', 'WSOL-ETH'].includes(from) || !['USDC', 'ETH', 'WSOL-ETH'].includes(to)) {
    console.error('  Supported pairs: usdc<->eth, usdc<->wsol-eth, eth<->wsol-eth, usdc<->sol');
    process.exit(1);
  }

  const account = getEvmAccount();
  const tokens = TOKENS[network];

  const sellToken = from === 'USDC' ? tokens.USDC : from === 'WSOL-ETH' ? tokens.WSOL : tokens.WETH;
  const buyToken = to === 'USDC' ? tokens.USDC : to === 'WSOL-ETH' ? tokens.WSOL : tokens.WETH;
  const sellDecimals = from === 'USDC' ? tokens.USDC_DECIMALS : from === 'WSOL-ETH' ? tokens.WSOL_DECIMALS : tokens.WETH_DECIMALS;
  const buyDecimals = to === 'USDC' ? tokens.USDC_DECIMALS : to === 'WSOL-ETH' ? tokens.WSOL_DECIMALS : tokens.WETH_DECIMALS;
  const sellAmount = parseTokenAmount(amount, sellDecimals);

  if (dryRun) warnDryRun();
  console.log(`  Swap: ${amount} ${from} -> ${to}`);
  console.log(`  Chain: Ethereum ${network}`);
  console.log(`  Wallet: ${account.address}`);
  warnMainnet(network, dryRun);
  console.log('  Checking balance...');

  // Check balance
  let insufficientBalance = false;
  if (from === 'ETH') {
    const client = getPublicClient(network);
    const balance = await client.getBalance({ address: account.address });
    if (balance < sellAmount) {
      console.log(`  ⚠ Insufficient ETH balance (have: ${formatToken(Number(balance) / 1e18, 6)}, need: ${amount})`);
      insufficientBalance = true;
    }
  } else {
    const balance = await getERC20Balance(network, sellToken, account.address);
    if (balance < sellAmount) {
      console.log(`  ⚠ Insufficient ${from} balance (have: ${formatToken(Number(balance) / 10 ** sellDecimals, 2)}, need: ${amount})`);
      insufficientBalance = true;
    }
  }

  // Resolve provider preference
  const resolved = resolveSwapProvider(providerFlag);

  let provider: SwapProvider;
  let quote: SwapQuote;

  if (resolved !== 'auto') {
    // Single provider mode
    provider = getSwapProvider(resolved);
    console.log(`  Fetching quote from ${provider.displayName}...`);
    try {
      quote = await provider.getQuote({
        sellToken, buyToken,
        amount: sellAmount.toString(),
        kind: 'sell',
        from: account.address,
        network,
      });
    } catch (err: any) {
      console.error(`  Quote failed: ${err.message}`);
      process.exit(1);
    }
  } else {
    // Auto mode: fetch from all providers, compare, select
    const allProviders = listSwapProviders();
    const names = allProviders.map(p => p.displayName).join(', ');
    console.log(`  Fetching quotes from ${names}...`);

    const results = await Promise.allSettled(
      allProviders.map(p =>
        withTimeout(p.getQuote({
          sellToken, buyToken,
          amount: sellAmount.toString(),
          kind: 'sell',
          from: account.address,
          network,
        }), QUOTE_TIMEOUT)
      )
    );

    const quotes: { provider: SwapProvider; quote: SwapQuote }[] = [];
    for (let i = 0; i < allProviders.length; i++) {
      if (results[i].status === 'fulfilled') {
        quotes.push({ provider: allProviders[i], quote: (results[i] as PromiseFulfilledResult<SwapQuote>).value });
      }
    }

    if (quotes.length === 0) {
      console.error('\n  All providers failed to quote:');
      for (let i = 0; i < allProviders.length; i++) {
        if (results[i].status === 'rejected') {
          console.error(`    ${allProviders[i].displayName}: ${(results[i] as PromiseRejectedResult).reason?.message || 'unknown error'}`);
        }
      }
      process.exit(1);
    }

    // Sort by buyAmount descending (best rate first)
    quotes.sort((a, b) => Number(b.quote.buyAmount) - Number(a.quote.buyAmount));

    if (quotes.length === 1) {
      provider = quotes[0].provider;
      quote = quotes[0].quote;
      console.log(`  Using ${provider.displayName} (only available provider).`);
    } else {
      // Show comparison table
      const amountNum = Number(amount);
      console.log(`\n  ── Swap Quotes: ${amount} ${from} -> ${to} ${SEP}\n`);

      const rows = quotes.map((q, i) => {
        const buyAmt = Number(q.quote.buyAmount) / 10 ** buyDecimals;
        const feeAmt = Number(q.quote.feeAmount) / 10 ** sellDecimals;
        const sellAmt = Number(q.quote.sellAmount) / 10 ** sellDecimals;
        const marketRate = sellAmt / buyAmt;
        return {
          num: String(i + 1),
          name: q.provider.displayName,
          receive: `${formatToken(buyAmt, 6)} ${to}`,
          rate: from === 'USDC' || to === 'USDC'
            ? `$${formatToken(from === 'USDC' ? marketRate : 1 / marketRate, 2)}/${from === 'USDC' ? to : from}`
            : `${formatToken(marketRate, 6)} ${from}/${to}`,
          fee: q.quote.gasless
            ? (feeAmt > 0 ? `${formatToken(feeAmt, feeAmt < 1 ? 6 : 2)} ${from} (gasless)` : 'gasless')
            : feeAmt > 0 ? `${formatToken(feeAmt, feeAmt < 1 ? 6 : 2)} ${from}`
            : formatGasFee(q.quote.gasFeeUSD, true) || 'included',
        };
      });

      // Column widths
      const wName = Math.max(8, ...rows.map(r => r.name.length));
      const wRecv = Math.max(11, ...rows.map(r => r.receive.length));
      const wRate = Math.max(4, ...rows.map(r => r.rate.length));
      const wFee = Math.max(3, ...rows.map(r => r.fee.length));

      console.log(`  ${'#'}  ${('Provider').padEnd(wName)}  ${('You receive').padEnd(wRecv)}  ${('Rate').padEnd(wRate)}  ${'Fee'}`);
      console.log(`  ${'─'}  ${'─'.repeat(wName)}  ${'─'.repeat(wRecv)}  ${'─'.repeat(wRate)}  ${'─'.repeat(wFee)}`);

      for (const r of rows) {
        console.log(`  ${r.num}  ${r.name.padEnd(wName)}  ${r.receive.padEnd(wRecv)}  ${r.rate.padEnd(wRate)}  ${r.fee}`);
      }
      console.log('');

      const choice = await select('Select provider', quotes.length);
      if (choice === 0) {
        console.log('  Cancelled.\n');
        return;
      }

      provider = quotes[choice - 1].provider;
      quote = quotes[choice - 1].quote;
    }
  }

  const buyAmount = Number(quote.buyAmount) / 10 ** buyDecimals;
  const fee = Number(quote.feeAmount) / 10 ** sellDecimals;
  const sellAmountNum = Number(quote.sellAmount) / 10 ** sellDecimals;
  const amountNum = Number(amount);

  // Show rate (use post-fee sellAmount for market rate, not user's input which includes fees)
  const rate = sellAmountNum / buyAmount;
  const inverseRate = buyAmount / sellAmountNum;
  console.log(`\n  Provider:    ${provider.displayName}`);
  console.log(`  Rate:        1 ${to} = ${formatToken(rate, rate >= 100 ? 2 : 6)} ${from}`);
  console.log(`               1 ${from} = ${formatToken(inverseRate, inverseRate >= 100 ? 2 : 6)} ${to}`);
  if (network === 'mainnet' && (from === 'USDC' || to === 'USDC')) {
    const price = from === 'USDC' ? sellAmountNum / buyAmount : buyAmount / sellAmountNum;
    const priceLabel = from === 'USDC' ? to : from;
    console.log(`  ${priceLabel} price: ~$${formatToken(price, 2)}`);
  }
  const testnetNote = network === 'testnet' ? ' (testnet — not real prices)' : '';
  console.log(`  You sell:    ${amount} ${from}`);
  console.log(`  You receive: ~${formatToken(buyAmount, 6)} ${to}${testnetNote}`);
  const feeStr = quote.gasless
    ? (fee > 0 ? `~${formatToken(fee, 6)} ${from} (gasless)` : 'gasless')
    : fee > 0 ? `~${formatToken(fee, 6)} ${from}`
    : formatGasFee(quote.gasFeeUSD) || 'included';
  console.log(`  Fee:         ${feeStr}`);

  // Fee sanity check
  let feePct = amountNum > 0 ? (fee / amountNum) * 100 : 0;
  if (feePct === 0 && quote.gasFeeUSD && from === 'USDC') {
    feePct = (parseFloat(quote.gasFeeUSD) / amountNum) * 100;
  }
  if (feePct > 5) {
    console.log(`  \u26a0 Fee is ${formatToken(feePct, 1)}% of your trade`);
    if (feePct > 50) {
      console.log('  \u26a0 Amount too small \u2014 most of it is consumed by fees.');
    }
  }

  console.log(`  Valid until: ${new Date(quote.validTo * 1000).toLocaleString()}\n`);

  // Snapshot balances before confirm so user sees current state
  const trackTokens: string[] = [from === 'ETH' ? 'ETH' : from, to === 'ETH' ? 'ETH' : to];
  // Track WETH for providers that give WETH (not CoW/LI.FI which give native ETH)
  if (to === 'ETH' && provider.id !== 'cow' && provider.id !== 'lifi') trackTokens.push('WETH');
  const tracker = new BalanceTracker(evmTokens(network, account.address, trackTokens));

  if (dryRun) {
    console.log('  [DRY RUN] Skipping execution.\n');
    return;
  }

  await tracker.snapshot();
  tracker.printBefore();

  if (!await confirm(`Proceed?`)) {
    console.log('  Cancelled.\n');
    return;
  }

  if (insufficientBalance) {
    console.log('  Insufficient balance — cannot execute.\n');
    return;
  }

  // Check allowance & approve if needed (only for ERC-20 sells)
  if (from !== 'ETH') {
    const spender = provider.getApprovalAddress(network) as `0x${string}`;
    const currentAllowance = await getERC20Allowance(network, sellToken, account.address, spender);
    if (currentAllowance < sellAmount) {
      console.log(`\n  Approval needed: ${amount} ${from} to ${provider.displayName} (${spender})`);
      if (!await confirm('Approve?')) {
        console.log('  Cancelled.\n');
        return;
      }
      await approveERC20(network, sellToken, spender, sellAmount);
    }
  }

  // Sign and submit via provider
  console.log('  Submitting order...');
  let uid: string;
  try {
    uid = await provider.signAndSubmit(quote, network);
  } catch (err: any) {
    console.error(`  Swap failed: ${err.message}`);
    await tracker.snapshotAndPrint('Swap');
    console.log('');
    process.exit(1);
  }

  const shortUid = uid.slice(0, 10) + '...' + uid.slice(-8);
  console.log(`  Order submitted: ${shortUid}`);
  console.log(`  Check: wallet swap status ${uid}\n`);

  // Poll status via provider
  console.log('  Waiting for fill...');
  const result = await provider.pollUntilDone(uid, network);
  if (result.status === 'fulfilled') {
    console.log('\n  Order filled!');

    // Auto-unwrap WETH → native ETH when user asked for ETH (not WETH explicitly)
    // CoW Swap settles to native ETH; LI.FI routes to native ETH; others give WETH
    if (to === 'ETH' && provider.id !== 'cow' && provider.id !== 'lifi') {
      try {
        const wethBal = await getERC20Balance(network, tokens.WETH, account.address);
        if (wethBal > 0n) {
          console.log(`  Unwrapping ${formatToken(Number(wethBal) / 1e18, 6)} WETH -> ETH...`);
          const unwrapHash = await unwrapWeth(network, wethBal);
          console.log(`  Unwrap tx: ${unwrapHash}`);
          console.log('  Waiting for unwrap confirmation...');
          await waitForReceipt(network, unwrapHash);
          console.log('  Unwrapped.');
        }
      } catch (err: any) {
        console.log(`  ⚠ Auto-unwrap failed: ${err.shortMessage || err.message}`);
        console.log('  Run "wallet unwrap weth --run" to unwrap manually.');
      }
    }
    await tracker.snapshotAndPrint('Swap');
    console.log('');
  } else if (result.status === 'cancelled' || result.status === 'expired') {
    await tracker.snapshotAndPrint('Swap');
    console.log(`\n  Order ${result.status}.\n`);
  } else {
    console.log(`\n  Timed out waiting for fill.\n  Check: wallet swap status ${uid}\n`);
  }
}

// ── Solana swap (Jupiter) ──

async function swapSolana(amount: string, from: string, to: string, network: Network, dryRun: boolean) {
  if (network === 'testnet') {
    console.error('  Jupiter is mainnet-only. Use --network mainnet.');
    process.exit(1);
  }

  const keypair = getSolanaKeypair();
  const walletAddr = keypair.publicKey.toBase58();
  const explorer = EXPLORERS[network];
  const fromDecimals = getSolanaDecimals(from);
  const toDecimals = getSolanaDecimals(to);
  const fromMint = getSolanaMint(from);
  const toMint = getSolanaMint(to);

  if (dryRun) warnDryRun();
  console.log(`  Swap: ${amount === 'all' ? 'all' : amount} ${from} -> ${to}`);
  console.log(`  Chain: Solana ${network}`);
  console.log(`  Wallet: ${walletAddr}`);
  console.log(`  Via: Jupiter`);
  warnMainnet(network, dryRun);
  console.log('  Checking balance...');

  // Resolve "all" to actual balance
  let insufficientBalance = false;
  if (from === 'USDC') {
    const usdcBal = await getSplTokenBalance(network, walletAddr, SOLANA_MINTS.USDC);
    if (amount === 'all') {
      if (usdcBal <= 0) { console.log('  No USDC to swap.\n'); return; }
      // Use raw integer to avoid floating point issues
      amount = String(Math.floor(usdcBal * 10 ** fromDecimals) / 10 ** fromDecimals);
      console.log(`  Swapping all: ${amount} USDC`);
    } else if (usdcBal < Number(amount)) {
      console.log(`  ⚠ Insufficient USDC (have: ${formatToken(usdcBal, 2)}, need: ${amount})`);
      insufficientBalance = true;
    }
    const solBal = await getSolBalance(network, walletAddr);
    if (solBal < 0.01) {
      console.log(`  ⚠ Insufficient SOL for fees (have: ${formatToken(solBal, 6)}, need: ~0.01)`);
      insufficientBalance = true;
    }
  } else {
    const solBal = await getSolBalance(network, walletAddr);
    if (amount === 'all') {
      const available = solBal - 0.02; // reserve for fees + rent
      if (available <= 0) { console.log('  No SOL to swap (need to keep ~0.02 for fees).\n'); return; }
      amount = String(Math.floor(available * 10 ** fromDecimals) / 10 ** fromDecimals);
      console.log(`  Swapping: ${amount} SOL (keeping ~0.02 for fees)`);
    } else if (solBal < Number(amount) + 0.01) {
      console.log(`  ⚠ Insufficient SOL (have: ${formatToken(solBal, 6)}, need: ${amount} + ~0.01 fees)`);
      insufficientBalance = true;
    }
  }

  const rawAmount = Math.round(Number(amount) * 10 ** fromDecimals);

  // Get quote (ExactIn for swaps)
  console.log('  Fetching quote from Jupiter...');
  const quote = await getJupiterQuote({
    inputMint: fromMint,
    outputMint: toMint,
    amount: rawAmount.toString(),
    swapMode: 'ExactIn',
  });

  const outAmount = Number(quote.outAmount) / 10 ** toDecimals;
  const minOut = Number(quote.otherAmountThreshold) / 10 ** toDecimals;
  const amountNum = Number(amount);
  const rate = from === 'USDC' ? amountNum / outAmount : outAmount / amountNum;
  const impactPct = parseFloat(quote.priceImpactPct);

  console.log(`\n  ${to === 'USDC' ? from : to} price:   ~$${formatToken(rate, 2)}`);
  console.log(`  You sell:    ${amount} ${from}`);
  console.log(`  You receive: ~${formatToken(outAmount, to === 'USDC' ? 2 : 6)} ${to} (min ${formatToken(minOut, to === 'USDC' ? 2 : 6)} with slippage)`);
  console.log(`  Impact:      ${impactPct < 0.01 ? '<0.01' : formatToken(impactPct, 2)}%\n`);

  const tracker = new BalanceTracker(solTokens(network, walletAddr, [from, to]));

  if (dryRun) {
    console.log('  [DRY RUN] Skipping execution.\n');
    return;
  }

  await tracker.snapshot();
  tracker.printBefore();

  if (!await confirm(`Proceed?`)) {
    console.log('  Cancelled.\n');
    return;
  }

  if (insufficientBalance) {
    console.log('  Insufficient balance — cannot execute.\n');
    return;
  }

  console.log('  Building swap transaction...');
  const { trackTx, clearTx } = await import('../lib/txtracker.js');

  let signature: string;
  try {
    signature = await buildAndSendJupiterSwap({
      userPublicKey: walletAddr,
      quote,
      keypair,
      network,
    });
  } catch (err: any) {
    const msg = err?.transactionMessage || err?.message || String(err);
    if (msg.includes('0x1771') || msg.toLowerCase().includes('slippage')) {
      console.log('  Swap failed: slippage tolerance exceeded — price moved too fast.');
      console.log('  Try again (the quote will refresh).\n');
    } else {
      console.log(`  Swap failed: ${msg}\n`);
    }
    return;
  }

  trackTx(signature, 'solana', network);
  console.log(`  TX:  ${signature}`);
  console.log(`  URL: ${explorer.solana}/tx/${signature}`);
  console.log('  Waiting for confirmation...');
  const conn = getConnection(network);
  await conn.confirmTransaction(signature);
  clearTx();
  await tracker.snapshotAndPrint('Swap');
  console.log('');
}

// ── Token address → symbol resolution ──

const NATIVE_ETH_ADDRESSES = new Set([
  '0x0000000000000000000000000000000000000000',
  '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
]);

function isNativeEth(address: string): boolean {
  return NATIVE_ETH_ADDRESSES.has(address.toLowerCase());
}

function resolveTokenSymbol(address: string, network: Network): string {
  if (isNativeEth(address)) return 'ETH';
  const tokens = TOKENS[network];
  const lower = address.toLowerCase();
  if (lower === tokens.USDC.toLowerCase()) return 'USDC';
  if (lower === tokens.WETH.toLowerCase()) return 'ETH';
  if (lower === tokens.WSOL.toLowerCase()) return 'WSOL-ETH';
  return formatAddress(address, 4);
}

function resolveTokenDecimals(address: string, network: Network): number {
  if (isNativeEth(address)) return 18;
  const tokens = TOKENS[network];
  const lower = address.toLowerCase();
  if (lower === tokens.USDC.toLowerCase()) return tokens.USDC_DECIMALS;
  if (lower === tokens.WETH.toLowerCase()) return tokens.WETH_DECIMALS;
  if (lower === tokens.WSOL.toLowerCase()) return tokens.WSOL_DECIMALS;
  return 18;
}

// ── shared order history ──

export async function orderHistoryCommand(network: Network, kindFilter: 'sell' | 'buy') {
  const label = kindFilter === 'sell' ? 'swap' : 'buy';
  const allProviders = listSwapProviders();
  const solAddress = getSolanaAddress();
  const providerNames = allProviders.map(p => p.displayName);
  if (solAddress && network === 'mainnet') providerNames.push('Jupiter');
  console.log(`\n  Fetching ${label} history from ${providerNames.join(', ')}...\n`);

  // Fetch EVM provider history + Jupiter history in parallel
  const evmPromises = allProviders.map(p => p.getHistory(network));
  const jupiterPromise = (solAddress && network === 'mainnet')
    ? import('../lib/jupiter.js').then(m => m.getJupiterHistory(network, solAddress))
    : Promise.resolve([]);

  const [evmResults, jupiterResult] = await Promise.all([
    Promise.allSettled(evmPromises),
    jupiterPromise.catch(() => []),
  ]);

  // Merge EVM orders
  type OrderType = Awaited<ReturnType<SwapProvider['getHistory']>>[0];
  type HistoryEntry = { provider: string; chain: 'evm' | 'solana'; sellSym: string; buySym: string; sellAmt: number; buyAmt: number; status: string; date: Date; link: string; feeStr: string };
  const entries: HistoryEntry[] = [];

  for (let i = 0; i < allProviders.length; i++) {
    if (evmResults[i].status !== 'fulfilled') continue;
    const provOrders = (evmResults[i] as PromiseFulfilledResult<OrderType[]>).value;
    for (const o of provOrders) {
      if (o.kind !== kindFilter) continue;

      const sellSym = resolveTokenSymbol(o.sellToken, network);
      const buySym = resolveTokenSymbol(o.buyToken, network);
      const sellDec = resolveTokenDecimals(o.sellToken, network);
      const buyDec = resolveTokenDecimals(o.buyToken, network);
      const isFilled = o.status === 'fulfilled';
      const sellAmt = Number(isFilled ? o.executedSellAmount : o.sellAmount) / 10 ** sellDec;
      const buyAmt = Number(isFilled ? o.executedBuyAmount : o.buyAmount) / 10 ** buyDec;

      const explorer = EXPLORERS[network];
      const provName = allProviders[i].displayName;
      const isCow = provName === 'CoW Swap';
      const shortId = o.orderId.length > 16 ? `${o.orderId.slice(0, 8)}...${o.orderId.slice(-6)}` : o.orderId;
      const link = isCow
        ? termLink(shortId, `${COW_EXPLORER[network]}/${o.orderId}`)
        : o.orderId.startsWith('0x')
          ? termLink(shortId, `${explorer.evm}/tx/${o.orderId}`)
          : shortId;

      let feeStr = '';
      if (o.gasCostETH) {
        const gasNum = parseFloat(o.gasCostETH);
        if (gasNum > 0) feeStr = `  gas: ${formatToken(gasNum, 6)} ETH`;
      } else if (isCow && isFilled) {
        const feeRaw = Number(o.executedFeeAmount);
        if (feeRaw > 0) {
          const feeAmt = feeRaw / 10 ** sellDec;
          feeStr = `  fee: ${formatToken(feeAmt, sellSym === 'USDC' ? 2 : 6)} ${sellSym}`;
        } else {
          feeStr = '  gasless';
        }
      }

      entries.push({
        provider: provName, chain: 'evm',
        sellSym, buySym, sellAmt, buyAmt,
        status: o.status, date: new Date(o.createdAt),
        link, feeStr,
      });
    }
  }

  // Backfill gas cost for on-chain EVM orders
  const client = getPublicClient(network);
  const evmNoGas = entries.filter(e => e.chain === 'evm' && !e.feeStr && e.link.includes('0x') && e.status === 'fulfilled');
  // We need the original order data for backfill, but since we've already mapped, we skip the backfill to avoid complexity
  // Gas info from stored orders is already included above

  // Merge Jupiter (Solana) orders
  const jupiterOrders = Array.isArray(jupiterResult) ? jupiterResult : [];
  for (const j of jupiterOrders) {
    // For 'buy' history: show USDC->SOL only; for 'sell' (swap) history: show all Jupiter swaps
    if (kindFilter === 'buy' && !(j.sellToken === 'USDC' && j.buyToken === 'SOL')) continue;

    const explorer = EXPLORERS[network];
    const shortSig = `${j.signature.slice(0, 8)}...${j.signature.slice(-6)}`;
    const link = termLink(shortSig, `${explorer.solana}/tx/${j.signature}`);

    entries.push({
      provider: 'Jupiter', chain: 'solana',
      sellSym: j.sellToken, buySym: j.buyToken,
      sellAmt: j.sellAmount, buyAmt: j.buyAmount,
      status: j.status, date: new Date(j.timestamp * 1000),
      link, feeStr: '',
    });
  }

  if (entries.length === 0) {
    console.log(`  No ${label} orders found.\n`);
    return;
  }

  // Sort by date descending
  entries.sort((a, b) => b.date.getTime() - a.date.getTime());
  const recent = entries.slice(0, HISTORY_LIMIT);

  const Label = kindFilter === 'sell' ? 'Swaps' : 'Buys';
  console.log(`  ── Recent ${Label} ${SEP}\n`);

  for (const e of recent) {
    const dateStr = `${e.date.getMonth() + 1}/${e.date.getDate()} ${e.date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false })}`;
    const sellDec = e.sellSym === 'USDC' ? 2 : 4;
    const buyDec = e.buySym === 'USDC' ? 2 : 4;
    const sellCol = `${formatToken(e.sellAmt, sellDec).padStart(8)} ${e.sellSym.padEnd(5)}`;
    const buyCol = `${formatToken(e.buyAmt, buyDec)} ${e.buySym}`.padEnd(12);

    console.log(`  ${dateStr.padEnd(10)}${sellCol}-> ${buyCol}${e.status.padEnd(10)} ${e.provider.padEnd(11)} ${e.link}`);
  }
}

// ── swap history ──

export async function swapHistoryCommand(network: Network) {
  await orderHistoryCommand(network, 'sell');
}

// ── swap status ──

export async function swapStatusCommand(orderId: string, network: Network) {
  console.log(`\n  Fetching swap order...\n`);

  // Try all providers until one finds the order
  const allProviders = listSwapProviders();
  let o;
  let matchedProvider: SwapProvider | undefined;
  for (const provider of allProviders) {
    try {
      o = await provider.getOrderStatus(orderId, network);
      matchedProvider = provider;
      break;
    } catch {
      // try next provider
    }
  }

  if (!o || !matchedProvider) {
    console.error(`  Order not found across any provider.`);
    process.exit(1);
  }

  const sellSym = resolveTokenSymbol(o.sellToken, network);
  const buySym = resolveTokenSymbol(o.buyToken, network);
  const sellDec = resolveTokenDecimals(o.sellToken, network);
  const buyDec = resolveTokenDecimals(o.buyToken, network);

  const isFilled = o.status === 'fulfilled';
  const sellAmt = Number(isFilled ? o.executedSellAmount : o.sellAmount) / 10 ** sellDec;
  const buyAmt = Number(isFilled ? o.executedBuyAmount : o.buyAmount) / 10 ** buyDec;
  const feeAmt = Number(isFilled ? o.executedFeeAmount : o.feeAmount) / 10 ** sellDec;

  console.log(`  ── Swap Order ${SEP}\n`);
  console.log(`  Provider:  ${matchedProvider.displayName}`);
  console.log(`  Order ID:  ${o.orderId}`);
  console.log(`  Status:    ${o.status}`);
  console.log(`  Created:   ${new Date(o.createdAt).toLocaleString()}`);
  if (o.validTo > 0) console.log(`  Expires:   ${new Date(o.validTo * 1000).toLocaleString()}`);
  console.log(`  Chain:     Ethereum ${network}`);
  console.log(`\n  You ${isFilled ? 'sold' : 'sell'}:     ${formatToken(sellAmt, sellSym === 'USDC' ? 2 : 6)} ${sellSym}`);
  console.log(`  You ${isFilled ? 'got' : 'get'}:      ${formatToken(buyAmt, buySym === 'USDC' ? 2 : 6)} ${buySym}`);
  if (feeAmt > 0) console.log(`  Fee:       ${formatToken(feeAmt, 6)} ${sellSym}`);
  if (matchedProvider.id === 'cow') {
    const cow = COW_CONFIG[network];
    console.log(`\n  Track: ${cow.api}/api/v1/orders/${o.orderId}\n`);
  } else {
    console.log('');
  }
}

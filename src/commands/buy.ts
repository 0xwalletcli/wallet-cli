import { type Network, TOKENS, COW_CONFIG, SOLANA_MINTS, EXPLORERS } from '../config.js';
import { resolveSigner } from '../signers/index.js';
import { getPublicClient, getERC20Balance, getERC20Allowance, approveERC20, unwrapWeth, waitForReceipt } from '../lib/evm.js';
import { getConnection, getSplTokenBalance } from '../lib/solana.js';
import { getJupiterQuote, buildAndSendJupiterSwap } from '../lib/jupiter.js';
import { parseTokenAmount, formatToken, formatGasFee } from '../lib/format.js';
import { confirm, select, validateAmount, warnMainnet, warnDryRun } from '../lib/prompt.js';
import { resolveSwapProvider } from '../lib/config.js';
import { getSwapProvider, listSwapProviders } from '../providers/registry.js';
import type { SwapProvider, SwapQuote } from '../providers/types.js';
import { BalanceTracker, evmTokens, solTokens } from '../lib/balancedelta.js';

const SEP = '──────────────────────────────────────────';
const QUOTE_TIMEOUT = 15_000;

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), ms)),
  ]);
}

/** Resolve swap provider and get buy quote (auto: compare all, specific: one provider) */
async function selectBuyProvider(
  sellToken: string, buyToken: string, buyAmount: bigint,
  account: { address: string }, network: Network, tokenLabel: string,
  providerFlag?: string,
): Promise<{ provider: SwapProvider; quote: SwapQuote }> {
  const resolved = resolveSwapProvider(providerFlag);

  if (resolved !== 'auto') {
    const provider = getSwapProvider(resolved);
    console.log(`  Fetching quote from ${provider.displayName}...`);
    try {
      const quote = await provider.getQuote({
        sellToken, buyToken, amount: buyAmount.toString(),
        kind: 'buy', from: account.address, network,
      });
      return { provider, quote };
    } catch (err: any) {
      console.error(`  ${provider.displayName}: ${err.message}`);
      process.exit(1);
    }
  }

  // Auto mode
  const allProviders = listSwapProviders();
  const names = allProviders.map(p => p.displayName).join(', ');
  console.log(`  Fetching quotes from ${names}...`);

  const results = await Promise.allSettled(
    allProviders.map(p =>
      withTimeout(p.getQuote({
        sellToken, buyToken, amount: buyAmount.toString(),
        kind: 'buy', from: account.address, network,
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

  // Sort by total cost ascending (sellAmount + feeAmount, cheapest first)
  quotes.sort((a, b) =>
    (Number(a.quote.sellAmount) + Number(a.quote.feeAmount)) -
    (Number(b.quote.sellAmount) + Number(b.quote.feeAmount)),
  );

  if (quotes.length === 1) {
    console.log(`  Using ${quotes[0].provider.displayName} (only available provider).`);
    return quotes[0];
  }

  // Show comparison table
  console.log(`\n  ── Buy Quotes: ${tokenLabel} ${SEP}\n`);

  const sellDecimals = TOKENS[network].USDC_DECIMALS;
  const rows = quotes.map((q, i) => {
    const cost = Number(q.quote.sellAmount) / 10 ** sellDecimals;
    const fee = Number(q.quote.feeAmount) / 10 ** sellDecimals;
    const totalCost = cost + fee;
    let feeLabel: string;
    if (q.quote.gasless) {
      feeLabel = fee > 0 ? `${formatToken(fee, 6)} USDC (gasless)` : 'gasless';
    } else if (fee > 0) {
      feeLabel = `${formatToken(fee, 6)} USDC`;
    } else {
      feeLabel = formatGasFee(q.quote.gasFeeUSD, true) || 'included';
    }
    return {
      num: String(i + 1),
      name: q.provider.displayName,
      cost: `${formatToken(totalCost, 2)} USDC`,
      fee: feeLabel,
    };
  });

  const wName = Math.max(8, ...rows.map(r => r.name.length));
  const wCost = Math.max(8, ...rows.map(r => r.cost.length));
  const wFee = Math.max(3, ...rows.map(r => r.fee.length));

  console.log(`  ${'#'}  ${('Provider').padEnd(wName)}  ${('You spend').padEnd(wCost)}  ${'Fee'}`);
  console.log(`  ${'─'}  ${'─'.repeat(wName)}  ${'─'.repeat(wCost)}  ${'─'.repeat(wFee)}`);
  for (const r of rows) {
    console.log(`  ${r.num}  ${r.name.padEnd(wName)}  ${r.cost.padEnd(wCost)}  ${r.fee}`);
  }
  console.log('');

  const choice = await select('Select provider', quotes.length);
  if (choice === 0) {
    console.log('  Cancelled.\n');
    process.exit(0);
  }

  return quotes[choice - 1];
}

// ── Buy SOL via Jupiter (ExactOut) ──

async function buySolana(amount: string, network: Network, dryRun: boolean) {
  if (network === 'testnet') {
    console.error('  Jupiter is mainnet-only. Use --network mainnet.');
    process.exit(1);
  }

  const signer = await resolveSigner();
  const walletAddr = await signer.getSolanaAddress();
  if (!walletAddr) { console.error('  No Solana address configured.'); process.exit(1); }
  const amountNum = Number(amount);
  const lamports = Math.round(amountNum * 1e9);
  const explorer = EXPLORERS[network];

  if (dryRun) warnDryRun();
  console.log(`  Buy: ${amount} SOL (spend USDC)`);
  console.log(`  Chain: Solana ${network}`);
  console.log(`  Wallet: ${walletAddr}`);
  console.log(`  Via: Jupiter`);
  warnMainnet(network, dryRun);
  console.log('  Checking USDC balance...');

  const usdcBal = await getSplTokenBalance(network, walletAddr, SOLANA_MINTS.USDC);
  console.log(`  USDC balance: ${formatToken(usdcBal, 2)}`);

  console.log('  Fetching quote from Jupiter...');
  const quote = await getJupiterQuote({
    inputMint: SOLANA_MINTS.USDC,
    outputMint: SOLANA_MINTS.SOL,
    amount: lamports.toString(),
    swapMode: 'ExactOut',
  });

  const usdcNeeded = Number(quote.inAmount) / 1e6;
  const maxUsdc = Number(quote.otherAmountThreshold) / 1e6;
  const pricePerSol = usdcNeeded / amountNum;

  let insufficientBalance = false;
  if (usdcBal < maxUsdc) {
    console.log(`  ⚠ Insufficient USDC (have: ${formatToken(usdcBal, 2)}, need: ~${formatToken(maxUsdc, 2)} with slippage)`);
    insufficientBalance = true;
  }

  console.log(`\n  SOL price:   ~$${formatToken(pricePerSol, 2)}`);
  console.log(`  You buy:     ${amount} SOL`);
  console.log(`  You spend:   ~${formatToken(usdcNeeded, 2)} USDC (max ${formatToken(maxUsdc, 2)} with slippage)`);
  const impactPct = parseFloat(quote.priceImpactPct);
  console.log(`  Impact:      ${impactPct < 0.01 ? '<0.01' : formatToken(impactPct, 2)}%\n`);

  const tracker = new BalanceTracker(solTokens(network, walletAddr, ['USDC', 'SOL']));

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
      signer,
      network,
    });
  } catch (err: any) {
    const msg = err?.transactionMessage || err?.message || String(err);
    if (msg.includes('0x1771') || msg.toLowerCase().includes('slippage')) {
      console.log('  Buy failed: slippage tolerance exceeded — price moved too fast.');
      console.log('  Try again (the quote will refresh).\n');
    } else {
      console.log(`  Buy failed: ${msg}\n`);
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
  await tracker.snapshotAndPrint('Buy');
  console.log('');
}

// ── Buy ETH (kind: buy) ──

async function buyEvm(amount: string, network: Network, dryRun: boolean, providerFlag?: string) {
  const signer = await resolveSigner();
  const account = await signer.getEvmAccount();
  const tokens = TOKENS[network];
  const cow = COW_CONFIG[network];

  const buyToken = tokens.WETH;
  const sellToken = tokens.USDC;
  const buyDecimals = tokens.WETH_DECIMALS;
  const sellDecimals = tokens.USDC_DECIMALS;
  const buyAmt = parseTokenAmount(amount, buyDecimals);

  if (dryRun) warnDryRun();
  console.log(`  Buy: ${amount} ETH (spend USDC)`);
  console.log(`  Chain: Ethereum ${network}`);
  console.log(`  Wallet: ${account.address}`);
  warnMainnet(network, dryRun);
  console.log('  Checking USDC balance...');

  const usdcBalance = await getERC20Balance(network, sellToken, account.address);
  const usdcFormatted = Number(usdcBalance) / 10 ** sellDecimals;
  console.log(`  USDC balance: ${formatToken(usdcFormatted, 2)}`);

  // Get buy quote (multi-provider)
  const { provider, quote } = await selectBuyProvider(
    sellToken, buyToken, buyAmt, account, network, `${amount} ETH`, providerFlag,
  );

  const sellAmountNum = Number(quote.sellAmount) / 10 ** sellDecimals;
  const fee = Number(quote.feeAmount) / 10 ** sellDecimals;
  const totalCost = sellAmountNum + fee;
  const ethPrice = sellAmountNum / Number(amount);

  let insufficientBalance = false;
  if (usdcBalance < BigInt(quote.sellAmount) + BigInt(quote.feeAmount)) {
    console.log(`  Insufficient USDC (have: ${formatToken(usdcFormatted, 2)}, need: ~${formatToken(totalCost, 2)})`);
    insufficientBalance = true;
  }

  console.log(`\n  Provider:    ${provider.displayName}`);
  if (network === 'mainnet') {
    console.log(`  ETH price:   ~$${formatToken(ethPrice, 2)}`);
  }
  const feeStr = quote.gasless
    ? (fee > 0 ? `~${formatToken(fee, 6)} USDC (gasless)` : 'gasless')
    : fee > 0 ? `~${formatToken(fee, 6)} USDC`
    : formatGasFee(quote.gasFeeUSD) || 'included';

  console.log(`  You buy:     ${amount} ETH`);
  console.log(`  You spend:   ~${formatToken(sellAmountNum, 2)} USDC`);
  console.log(`  Fee:         ${feeStr}`);

  // Fee sanity check
  let feePctEth = totalCost > 0 ? (fee / totalCost) * 100 : 0;
  if (feePctEth === 0 && quote.gasFeeUSD) {
    feePctEth = (parseFloat(quote.gasFeeUSD) / totalCost) * 100;
  }
  if (feePctEth > 5) {
    console.log(`  \u26a0 Fee is ${formatToken(feePctEth, 1)}% of your trade`);
    if (feePctEth > 50) {
      console.log('  \u26a0 Amount too small \u2014 most of it is consumed by fees.');
    }
  }

  console.log(`  Valid until: ${new Date(quote.validTo * 1000).toLocaleString()}\n`);

  const tracker = new BalanceTracker(evmTokens(network, account.address, ['USDC', 'ETH', 'WETH']));

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

  // Check allowance & approve if needed
  const requiredAllowance = BigInt(quote.sellAmount) + BigInt(quote.feeAmount);
  const spender = provider.getApprovalAddress(network) as `0x${string}`;
  const currentAllowance = await getERC20Allowance(network, sellToken, account.address, spender);
  if (currentAllowance < requiredAllowance) {
    console.log(`\n  Approval needed: ~${formatToken(totalCost, 2)} USDC to ${provider.displayName} (${spender})`);
    if (!await confirm('Approve?')) {
      console.log('  Cancelled.\n');
      return;
    }
    const MAX_UINT256 = 2n ** 256n - 1n;
    await approveERC20(network, sellToken, spender, MAX_UINT256);
  }

  // Sign and submit via provider
  console.log('  Submitting order...');
  let uid: string;
  try {
    uid = await provider.signAndSubmit(quote, network);
  } catch (err: any) {
    console.error(`  Buy failed: ${err.message}`);
    await tracker.snapshotAndPrint('Buy');
    console.log('');
    process.exit(1);
  }

  console.log(`  Order submitted: ${uid}`);
  console.log(`  Check: wallet swap status ${uid}\n`);

  // Poll status via provider
  console.log('  Waiting for fill...');
  const result = await provider.pollUntilDone(uid, network);
  if (result.status === 'fulfilled') {
    console.log('\n  Order filled!');

    // Auto-unwrap WETH → native ETH (Uniswap gives WETH, not native ETH)
    // CoW Swap settles to native ETH; LI.FI routes to native ETH; others give WETH
    if (provider.id !== 'cow' && provider.id !== 'lifi') {
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
    await tracker.snapshotAndPrint('Buy');
    console.log('');
  } else if (result.status === 'cancelled' || result.status === 'expired') {
    console.log(`\n  Order ${result.status}.\n`);
  } else {
    // Timed out — do one final check in case the order filled after our poll window
    console.log('\n  Poll timed out. Checking final status...');
    try {
      const finalStatus = await provider.getOrderStatus(uid, network);
      if (finalStatus.status === 'fulfilled') {
        console.log('  Order filled (after timeout)!');
        if (provider.id !== 'cow' && provider.id !== 'lifi') {
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
        await tracker.snapshotAndPrint('Buy');
        console.log('');
      } else {
        console.log(`  Status: ${finalStatus.status}. Check with: wallet swap status ${uid}\n`);
      }
    } catch {
      console.log(`  Check with: wallet swap status ${uid}\n`);
    }
  }
}

// ── Buy WSOL-ETH (Wormhole wrapped SOL) ──

async function buyWsolEth(amount: string, network: Network, dryRun: boolean, providerFlag?: string) {
  const signer = await resolveSigner();
  const account = await signer.getEvmAccount();
  const tokens = TOKENS[network];

  const buyToken = tokens.WSOL;
  const sellToken = tokens.USDC;
  const buyDecimals = tokens.WSOL_DECIMALS;
  const sellDecimals = tokens.USDC_DECIMALS;
  const buyAmt = parseTokenAmount(amount, buyDecimals);

  if (dryRun) warnDryRun();
  console.log(`  Buy: ${amount} WSOL-ETH (spend USDC)`);
  console.log(`  Chain: Ethereum ${network}`);
  console.log(`  Wallet: ${account.address}`);
  warnMainnet(network, dryRun);
  console.log('  Checking USDC balance...');

  const usdcBalance = await getERC20Balance(network, sellToken, account.address);
  const usdcFormatted = Number(usdcBalance) / 10 ** sellDecimals;
  console.log(`  USDC balance: ${formatToken(usdcFormatted, 2)}`);

  // Get buy quote (multi-provider)
  const { provider, quote } = await selectBuyProvider(
    sellToken, buyToken, buyAmt, account, network, `${amount} WSOL-ETH`, providerFlag,
  );

  const sellAmountNum = Number(quote.sellAmount) / 10 ** sellDecimals;
  const fee = Number(quote.feeAmount) / 10 ** sellDecimals;
  const totalCost = sellAmountNum + fee;
  const wsolPrice = sellAmountNum / Number(amount);

  let insufficientBalance = false;
  if (usdcBalance < BigInt(quote.sellAmount) + BigInt(quote.feeAmount)) {
    console.log(`  Insufficient USDC (have: ${formatToken(usdcFormatted, 2)}, need: ~${formatToken(totalCost, 2)})`);
    insufficientBalance = true;
  }

  console.log(`\n  Provider:    ${provider.displayName}`);
  if (network === 'mainnet') {
    console.log(`  WSOL-ETH price: ~$${formatToken(wsolPrice, 2)}`);
  }
  const feeStr = quote.gasless
    ? (fee > 0 ? `~${formatToken(fee, 6)} USDC (gasless)` : 'gasless')
    : fee > 0 ? `~${formatToken(fee, 6)} USDC`
    : formatGasFee(quote.gasFeeUSD) || 'included';

  console.log(`  You buy:     ${amount} WSOL-ETH`);
  console.log(`  You spend:   ~${formatToken(sellAmountNum, 2)} USDC`);
  console.log(`  Fee:         ${feeStr}`);

  // Fee sanity check
  let feePctWsol = totalCost > 0 ? (fee / totalCost) * 100 : 0;
  if (feePctWsol === 0 && quote.gasFeeUSD) {
    feePctWsol = (parseFloat(quote.gasFeeUSD) / totalCost) * 100;
  }
  if (feePctWsol > 5) {
    console.log(`  \u26a0 Fee is ${formatToken(feePctWsol, 1)}% of your trade`);
    if (feePctWsol > 50) {
      console.log('  \u26a0 Amount too small \u2014 most of it is consumed by fees.');
    }
  }

  console.log(`  Valid until: ${new Date(quote.validTo * 1000).toLocaleString()}\n`);

  const tracker = new BalanceTracker(evmTokens(network, account.address, ['USDC', 'WSOL-ETH']));

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

  // Check allowance & approve if needed
  const requiredAllowance = BigInt(quote.sellAmount) + BigInt(quote.feeAmount);
  const spender = provider.getApprovalAddress(network) as `0x${string}`;
  const currentAllowance = await getERC20Allowance(network, sellToken, account.address, spender);
  if (currentAllowance < requiredAllowance) {
    console.log(`\n  Approval needed: ~${formatToken(totalCost, 2)} USDC to ${provider.displayName} (${spender})`);
    if (!await confirm('Approve?')) {
      console.log('  Cancelled.\n');
      return;
    }
    const MAX_UINT256 = 2n ** 256n - 1n;
    await approveERC20(network, sellToken, spender, MAX_UINT256);
  }

  // Sign and submit via provider
  console.log('  Submitting order...');
  let uid: string;
  try {
    uid = await provider.signAndSubmit(quote, network);
  } catch (err: any) {
    console.error(`  Buy failed: ${err.message}`);
    await tracker.snapshotAndPrint('Buy');
    console.log('');
    process.exit(1);
  }

  console.log(`  Order submitted: ${uid}`);
  console.log(`  Check: wallet swap status ${uid}\n`);

  // Poll status via provider
  console.log('  Waiting for fill...');
  const result = await provider.pollUntilDone(uid, network);
  if (result.status === 'fulfilled') {
    console.log('\n  Order filled!');
    await tracker.snapshotAndPrint('Buy');
    console.log('');
  } else if (result.status === 'cancelled' || result.status === 'expired') {
    console.log(`\n  Order ${result.status}.\n`);
  } else {
    console.log('\n  Timed out waiting for fill. Check with: wallet swap status <orderId>\n');
  }
}

// ── Main buy command ──

export async function buyCommand(amount: string, token: string, network: Network, dryRun: boolean, providerFlag?: string) {
  validateAmount(amount);
  const t = token.toUpperCase();

  if (t === 'SOL') {
    await buySolana(amount, network, dryRun);
  } else if (t === 'ETH') {
    await buyEvm(amount, network, dryRun, providerFlag);
  } else if (t === 'WSOL-ETH') {
    await buyWsolEth(amount, network, dryRun, providerFlag);
  } else if (t === 'WSOL') {
    // WSOL = wrap SOL 1:1, no swap needed
    const { wrapCommand } = await import('./wrap.js');
    await wrapCommand(amount, 'sol', network, dryRun);
  } else {
    console.error('  Supported: buy <amount> sol, buy <amount> eth, buy <amount> wsol-eth, buy <amount> wsol');
    console.error('  All spend USDC to buy the specified token (wsol wraps SOL 1:1).');
    process.exit(1);
  }
}

// ── Buy history (delegates to swap history for EVM) ──

export async function buyHistoryCommand(network: Network) {
  const { orderHistoryCommand } = await import('./swap.js');
  await orderHistoryCommand(network, 'buy');
}

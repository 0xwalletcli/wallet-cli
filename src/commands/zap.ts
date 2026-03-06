import { PublicKey, Transaction, LAMPORTS_PER_SOL, VersionedTransaction } from '@solana/web3.js';
import { getAssociatedTokenAddressSync, createAssociatedTokenAccountInstruction, getAccount } from '@solana/spl-token';
import { depositSol, getStakePoolAccount } from '@solana/spl-stake-pool';
import {
  type Network, TOKENS, DEBRIDGE_CONFIG, LIDO_CONFIG, JITO_CONFIG,
  SOLANA_MINTS, JUPITER_CONFIG, EXPLORERS, ETHERSCAN_API, ETHERSCAN_CHAIN_ID,
  HISTORY_LIMIT,
} from '../config.js';
import { resolveSigner } from '../signers/index.js';
import { getPublicClient, getWalletClient, resetWalletClient, getERC20Balance, getERC20Allowance, approveERC20, unwrapWeth, waitForReceipt, simulateTx } from '../lib/evm.js';
import { getConnection, getSolBalance, getSplTokenBalance } from '../lib/solana.js';
import { formatToken, formatUSD, formatAddress, parseTokenAmount, formatGasFee } from '../lib/format.js';
import { confirm, select, validateAmount, warnMainnet, warnDryRun } from '../lib/prompt.js';
import { resolveSwapProvider, resolveBridgeProvider } from '../lib/config.js';
import { getSwapProvider, getBridgeProvider, listSwapProviders, listBridgeProviders } from '../providers/registry.js';
import type { SwapProvider, SwapQuote, BridgeProvider, BridgeQuote } from '../providers/types.js';
import { fetchPrices as fetchPricesWithFallback } from '../lib/prices.js';
import { BalanceTracker, evmTokens, solTokens } from '../lib/balancedelta.js';

const SEP = '──────────────────────────────────────────';
const TIMEOUT = 15_000;

// ── Helpers ──────────────────────────────────────────

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), ms)),
  ]);
}

// ── Quote Fetchers ──────────────────────────────────

async function fetchJupiterPreviewQuote(usdcRaw: string): Promise<{ inAmount: string; outAmount: string }> {
  const params = new URLSearchParams({
    inputMint: SOLANA_MINTS.USDC,
    outputMint: SOLANA_MINTS.SOL,
    amount: usdcRaw,
    swapMode: 'ExactIn',
    slippageBps: '50',
  });
  const res = await withTimeout(fetch(`https://lite-api.jup.ag/swap/v1/quote?${params}`), TIMEOUT);
  if (!res.ok) throw new Error(await res.text());
  return (await res.json()) as { inAmount: string; outAmount: string };
}

async function fetchMarketPrices(): Promise<{ eth: number | null; sol: number | null }> {
  const p = await withTimeout(fetchPricesWithFallback(['eth', 'sol']), TIMEOUT);
  return { eth: p.eth ?? null, sol: p.sol ?? null };
}

async function fetchJitoRate(): Promise<number> {
  const conn = getConnection('mainnet');
  const pool = await withTimeout(
    getStakePoolAccount(conn, new PublicKey(JITO_CONFIG.stakePool)),
    TIMEOUT,
  );
  const d = pool.account.data;
  return Number(d.totalLamports) / Number(d.poolTokenSupply);
}

// ── Execution: Swap (via provider) ──────────────────

async function executeSwap(
  provider: SwapProvider,
  quote: SwapQuote,
  network: Network,
): Promise<{ filled: boolean; executedBuyAmount?: string; uid?: string }> {
  const signer = await resolveSigner();
  const account = await signer.getEvmAccount();
  const tokens = TOKENS[network];

  // Approve if needed
  const spender = provider.getApprovalAddress(network) as `0x${string}`;
  const currentAllowance = await getERC20Allowance(network, quote.sellToken as `0x${string}`, account.address, spender);
  const neededAllowance = BigInt(quote.sellAmount);
  if (currentAllowance < neededAllowance) {
    const MAX_UINT256 = 2n ** 256n - 1n;
    const label = tokens.USDC.toLowerCase() === quote.sellToken.toLowerCase() ? 'USDC' : 'token';
    console.log(`  Approving ${label} (infinite) for ${provider.displayName}...`);
    await approveERC20(network, quote.sellToken as `0x${string}`, spender, MAX_UINT256);
  }

  // Sign and submit via provider
  console.log('  Submitting order...');
  let uid: string;
  try {
    uid = await provider.signAndSubmit(quote, network);
  } catch (err: any) {
    console.error(`  Order submission failed: ${err.message}`);
    return { filled: false };
  }

  const shortUid = uid.slice(0, 10) + '...' + uid.slice(-8);
  console.log(`  Order: ${shortUid}`);

  // Poll via provider
  console.log('  Waiting for fill...');
  const result = await provider.pollUntilDone(uid, network);

  if (result.status === 'fulfilled') {
    console.log('\n  Order filled!');
    return { filled: true, executedBuyAmount: result.executedBuyAmount, uid };
  }

  if (result.status === 'cancelled') {
    console.log('\n  Order cancelled.');
    return { filled: false, uid };
  }

  if (result.status === 'expired') {
    console.log('\n  Order expired.');
    return { filled: false, uid };
  }

  console.log('\n  Timed out waiting for fill.');
  return { filled: false, uid };
}

// ── Execution: Lido Stake ───────────────────────────

async function executeLidoStake(amountWei: bigint, network: Network): Promise<boolean> {
  const signer = await resolveSigner();
  const account = await signer.getEvmAccount();
  const lido = LIDO_CONFIG[network];
  const explorer = EXPLORERS[network];
  const wallet = await getWalletClient(network);
  const { trackTx, clearTx } = await import('../lib/txtracker.js');

  try {
    console.log(`  Staking ${formatToken(Number(amountWei) / 1e18, 6)} ETH via Lido...`);
    const hash = await wallet.sendTransaction({
      account,
      to: lido.stETH,
      data: '0xa1903eab0000000000000000000000000000000000000000000000000000000000000000' as `0x${string}`, // submit(address referral=0x0)
      value: amountWei,
    });

    trackTx(hash, 'evm', network);
    console.log(`  TX:  ${hash}`);
    console.log(`  URL: ${explorer.evm}/tx/${hash}`);
    console.log('  Waiting for confirmation...');
    await waitForReceipt(network, hash);
    clearTx();
    console.log('  Lido stake confirmed!');
    return true;
  } catch (err: any) {
    const msg = err.shortMessage || err.message || '';
    console.error(`  Lido stake failed: ${msg}`);
    return false;
  }
}

// ── Execution: Bridge Tx (via provider) ─────────────

async function executeBridgeTx(
  provider: BridgeProvider,
  quote: BridgeQuote,
  usdcRaw: bigint,
  network: Network,
): Promise<{ confirmed: boolean; orderId: string }> {
  const signer = await resolveSigner();
  const account = await signer.getEvmAccount();
  const tokens = TOKENS[network];
  const explorer = EXPLORERS[network];
  const txData = provider.getTxData(quote);

  // Validate contract
  if (txData.to && !provider.knownContracts.has(txData.to.toLowerCase())) {
    console.error(`  WARNING: Unknown ${provider.displayName} contract ${txData.to}`);
    if (!await confirm('Continue anyway?')) {
      return { confirmed: false, orderId: quote.orderId };
    }
  }

  // Approve USDC
  const approvalAddr = provider.getApprovalAddress(quote);
  if (approvalAddr) {
    const spender = approvalAddr as `0x${string}`;
    const allowance = await getERC20Allowance(network, tokens.USDC, account.address, spender);
    if (allowance < usdcRaw) {
      const MAX_UINT256 = 2n ** 256n - 1n;
      console.log(`  Approving USDC (infinite) for ${provider.displayName}...`);
      await approveERC20(network, tokens.USDC, spender, MAX_UINT256);
    }
  }

  // Simulate + send tx
  await simulateTx(network, {
    account: account.address,
    to: txData.to as `0x${string}`,
    data: txData.data as `0x${string}`,
    value: BigInt(txData.value || '0'),
  });

  console.log('  Sending bridge transaction...');
  const { trackTx, clearTx } = await import('../lib/txtracker.js');
  const wallet = await getWalletClient(network);
  const hash = await wallet.sendTransaction({
    account,
    to: txData.to as `0x${string}`,
    data: txData.data as `0x${string}`,
    value: BigInt(txData.value || '0'),
  });

  trackTx(hash, 'evm', network);
  console.log(`  TX:  ${hash}`);
  console.log(`  URL: ${explorer.evm}/tx/${hash}`);
  console.log('  Waiting for confirmation...');
  await waitForReceipt(network, hash);
  clearTx();
  console.log('  Confirmed on Ethereum.');
  return { confirmed: true, orderId: quote.orderId };
}

// ── Execution: Bridge Poll (via provider) ───────────

async function pollBridgeFulfillment(provider: BridgeProvider, orderId: string): Promise<boolean> {
  console.log('  Waiting for bridge fulfillment...');
  const result = await provider.pollFulfillment(orderId);
  if (result.status === 'fulfilled') {
    console.log('\n  Bridge fulfilled!');
    if (result.dstTxHash) {
      console.log(`  Dest TX: ${result.dstTxHash}`);
    }
    return true;
  }
  console.log('\n  Bridge fulfillment timed out.');
  return false;
}

// ── Execution: Jupiter Swap ─────────────────────────

async function executeJupiterSwap(
  usdcRawSol: string,
  network: Network,
): Promise<{ success: boolean; signature?: string }> {
  const signer = await resolveSigner();
  const walletAddr = await signer.getSolanaAddress();
  if (!walletAddr) throw new Error('No Solana address configured');
  const explorer = EXPLORERS[network];

  // Get fresh quote
  console.log('  Fetching Jupiter quote...');
  const quoteParams = new URLSearchParams({
    inputMint: SOLANA_MINTS.USDC,
    outputMint: SOLANA_MINTS.SOL,
    amount: usdcRawSol,
    swapMode: 'ExactIn',
    slippageBps: '100',
  });

  const quoteRes = await withTimeout(
    fetch(`${JUPITER_CONFIG.api}/quote?${quoteParams}`),
    TIMEOUT,
  );
  if (!quoteRes.ok) throw new Error(`Jupiter quote: ${await quoteRes.text()}`);
  const quote = await quoteRes.json();

  // Build swap tx
  console.log('  Building swap transaction...');
  const swapRes = await withTimeout(
    fetch(`${JUPITER_CONFIG.api}/swap`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userPublicKey: walletAddr,
        quoteResponse: quote,
      }),
    }),
    TIMEOUT,
  );
  if (!swapRes.ok) throw new Error(`Jupiter swap: ${await swapRes.text()}`);
  const { swapTransaction } = (await swapRes.json()) as { swapTransaction: string };

  // Sign & send
  const conn = getConnection(network);
  const txBuf = Buffer.from(swapTransaction, 'base64');
  const tx = VersionedTransaction.deserialize(txBuf);
  const signed = await signer.signSolanaVersionedTransaction(tx);

  console.log('  Sending Jupiter swap...');
  const { trackTx, clearTx } = await import('../lib/txtracker.js');
  const signature = await conn.sendTransaction(signed);
  trackTx(signature, 'solana', network);
  console.log(`  TX:  ${signature}`);
  console.log(`  URL: ${explorer.solana}/tx/${signature}`);
  console.log('  Waiting for confirmation...');
  await conn.confirmTransaction(signature);
  clearTx();
  console.log('  Jupiter swap confirmed!');
  return { success: true, signature };
}

// ── Execution: Jito Stake ───────────────────────────

async function executeJitoStake(amount: number, network: Network): Promise<boolean> {
  const signer = await resolveSigner();
  const walletAddr = await signer.getSolanaAddress();
  if (!walletAddr) throw new Error('No Solana address configured');
  const userPubkey = new PublicKey(walletAddr);
  const conn = getConnection(network);
  const explorer = EXPLORERS[network];
  const stakePoolAddr = new PublicKey(JITO_CONFIG.stakePool);
  const jitoSolMint = new PublicKey(JITO_CONFIG.jitoSolMint);

  // Ensure JitoSOL ATA exists
  const ata = getAssociatedTokenAddressSync(jitoSolMint, userPubkey);
  try {
    await getAccount(conn, ata);
  } catch {
    console.log('  Creating JitoSOL token account...');
    const createAtaIx = createAssociatedTokenAccountInstruction(
      userPubkey, ata, userPubkey, jitoSolMint,
    );
    const ataTx = new Transaction().add(createAtaIx);
    await signer.signAndSendSolanaTransaction(conn, ataTx);
  }

  // Deposit SOL
  const lamports = Math.round(amount * LAMPORTS_PER_SOL);
  console.log(`  Depositing ${formatToken(amount, 4)} SOL into Jito stake pool...`);
  const { instructions, signers: ephemeralSigners } = await depositSol(
    conn,
    stakePoolAddr,
    userPubkey,
    lamports,
  );

  const tx = new Transaction();
  for (const ix of instructions) tx.add(ix);

  // Partial-sign with ephemeral signers before user signs
  if (ephemeralSigners.length > 0) {
    tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
    tx.feePayer = userPubkey;
    tx.partialSign(...ephemeralSigners);
  }

  console.log('  Sending Jito stake transaction...');
  try {
    const sig = await signer.signAndSendSolanaTransaction(conn, tx);
    console.log(`  TX:  ${sig}`);
    console.log(`  URL: ${explorer.solana}/tx/${sig}`);
    console.log('  Jito stake confirmed!');
    return true;
  } catch (err: any) {
    console.error(`  Jito stake failed: ${err.message}`);
    return false;
  }
}

// ── stETH Zap ───────────────────────────────────────

async function zapSteth(amount: string, network: Network, dryRun: boolean, providerFlag?: string) {
  const signer = await resolveSigner();
  const account = await signer.getEvmAccount();
  const tokens = TOKENS[network];
  const usdcAmount = Number(amount);
  const usdcRaw = parseTokenAmount(amount, tokens.USDC_DECIMALS);
  const sellToken = tokens.USDC;
  const buyToken = tokens.WETH;

  if (dryRun) warnDryRun();
  console.log(`  Zap: ${formatToken(usdcAmount, 2)} USDC -> stETH`);
  console.log(`  Network: Ethereum ${network}`);
  console.log(`  Wallet: ${account.address}`);
  warnMainnet(network, dryRun);

  // Check USDC balance
  console.log('  Checking balance...');
  const usdcBalance = await getERC20Balance(network, tokens.USDC, account.address);
  if (usdcBalance < usdcRaw) {
    if (dryRun) {
      console.log(`  Warning: Insufficient USDC (have: ${formatToken(Number(usdcBalance) / 1e6, 2)}, need: ${formatToken(usdcAmount, 2)})`);
    } else {
      console.error(`  Insufficient USDC. Have: ${formatToken(Number(usdcBalance) / 1e6, 2)}, need: ${formatToken(usdcAmount, 2)}`);
      return;
    }
  }

  // Resolve swap provider
  const resolved = resolveSwapProvider(providerFlag);

  let provider: SwapProvider;
  let swapQuote: SwapQuote;

  // Fetch market prices in parallel with quotes
  const marketPromise = fetchMarketPrices();

  if (resolved !== 'auto') {
    // Single provider mode
    provider = getSwapProvider(resolved);
    console.log(`  Fetching quote from ${provider.displayName}...`);
    try {
      swapQuote = await provider.getQuote({
        sellToken, buyToken,
        amount: usdcRaw.toString(),
        kind: 'sell',
        from: account.address,
        network,
      });
    } catch (err: any) {
      console.error(`  Quote failed: ${err.message}`);
      return;
    }
  } else {
    // Auto mode: fetch from all swap providers
    const allProviders = listSwapProviders();
    const names = allProviders.map(p => p.displayName).join(', ');
    console.log(`  Fetching swap quotes from ${names}...`);

    const results = await Promise.allSettled(
      allProviders.map(p =>
        withTimeout(p.getQuote({
          sellToken, buyToken,
          amount: usdcRaw.toString(),
          kind: 'sell',
          from: account.address,
          network,
        }), TIMEOUT)
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
      return;
    }

    // Sort by buyAmount descending (best rate first)
    quotes.sort((a, b) => Number(b.quote.buyAmount) - Number(a.quote.buyAmount));

    if (quotes.length === 1) {
      provider = quotes[0].provider;
      swapQuote = quotes[0].quote;
      console.log(`  Using ${provider.displayName} (only available provider).`);
    } else {
      // Show comparison table
      console.log(`\n  ── Swap Quotes: ${amount} USDC -> ETH ${SEP}\n`);

      const rows = quotes.map((q, i) => {
        const buyAmt = Number(q.quote.buyAmount) / 1e18;
        const feeAmt = Number(q.quote.feeAmount) / 1e6;
        const rate = usdcAmount / buyAmt;
        return {
          num: String(i + 1),
          name: q.provider.displayName,
          receive: `${formatToken(buyAmt, 6)} ETH`,
          rate: `$${formatToken(rate, 2)}/ETH`,
          fee: q.quote.gasless
            ? (feeAmt > 0 ? `${formatToken(feeAmt, 2)} USDC (gasless)` : 'gasless')
            : feeAmt > 0 ? `${formatToken(feeAmt, 2)} USDC`
            : formatGasFee(q.quote.gasFeeUSD, true) || 'included',
        };
      });

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
      swapQuote = quotes[choice - 1].quote;
    }
  }

  const market = await marketPromise.catch(() => ({ eth: null as number | null, sol: null as number | null }));

  const ethReceived = Number(swapQuote.buyAmount) / 1e18;
  const usdcFee = usdcAmount - Number(swapQuote.sellAmount) / 1e6;
  const ethPrice = usdcAmount / ethReceived;
  const stethReceived = ethReceived; // 1:1 at deposit
  const stethValue = market.eth ? stethReceived * market.eth : 0;
  const totalCost = stethValue > 0 ? usdcAmount - stethValue : 0;
  const costPct = stethValue > 0 ? (totalCost / usdcAmount) * 100 : 0;

  // Preview
  // Fee sanity check
  const zapFeePct = usdcAmount > 0 ? (usdcFee / usdcAmount) * 100 : 0;

  console.log(`\n  ${SEP}`);
  console.log(`  Step 1: USDC -> ETH (${provider.displayName})`);
  console.log(`    Sell:    ${formatToken(usdcAmount, 2)} USDC`);
  console.log(`    Receive: ~${formatToken(ethReceived, 6)} ETH`);
  console.log(`    Fee:     ${formatUSD(usdcFee)}`);
  if (zapFeePct > 5) {
    console.log(`    \u26a0 Fee is ${formatToken(zapFeePct, 1)}% of your trade`);
    if (zapFeePct > 50) {
      console.log('    \u26a0 Amount too small \u2014 most of it is consumed by fees.');
    }
  }
  if (market.eth) console.log(`    Price:   ${formatUSD(ethPrice)}/ETH`);
  console.log('');
  console.log(`  Step 2: ETH -> stETH (Lido)`);
  console.log(`    Stake:   ${formatToken(ethReceived, 6)} ETH -> ${formatToken(stethReceived, 6)} stETH (1:1)`);
  console.log('');
  if (stethValue > 0) {
    console.log(`  Result:  ~${formatToken(stethReceived, 6)} stETH  (${formatUSD(stethValue)})`);
    console.log(`  Cost:    ~${formatUSD(totalCost)}  (${formatToken(costPct, 2)}%)`);
  } else {
    console.log(`  Result:  ~${formatToken(stethReceived, 6)} stETH`);
  }
  console.log(`  ${SEP}\n`);

  // Track all relevant EVM tokens across both steps
  const tracker = new BalanceTracker(evmTokens(network, account.address, ['USDC', 'ETH', 'WETH', 'stETH']));

  if (dryRun) {
    console.log('  [DRY RUN] Skipping execution.\n');
    return;
  }

  const beforeIdx = await tracker.snapshot();
  tracker.printBefore();

  if (!await confirm(`Proceed?`)) {
    console.log('  Cancelled.\n');
    return;
  }

  // Execute Step 1: Swap USDC -> ETH
  console.log(`\n  ── Step 1: USDC -> ETH (${provider.displayName}) ${SEP}\n`);
  const swapResult = await executeSwap(provider, swapQuote, network);
  if (!swapResult.filled) {
    console.log(`  Zap stopped: swap did not fill.`);
    if (swapResult.uid) console.log(`  Check: wallet swap status ${swapResult.uid}`);
    return;
  }

  // Auto-unwrap WETH if provider gave WETH instead of native ETH
  // CoW Swap settles to native ETH; LI.FI routes to native ETH; others give WETH
  if (provider.id !== 'cow' && provider.id !== 'lifi') {
    const tokens = TOKENS[network];
    const wethBal = await getERC20Balance(network, tokens.WETH, account.address);
    if (wethBal > 0n) {
      console.log(`  Unwrapping ${formatToken(Number(wethBal) / 1e18, 6)} WETH -> ETH...`);
      const unwrapHash = await unwrapWeth(network, wethBal);
      console.log(`  Unwrap tx: ${unwrapHash}`);
      console.log('  Waiting for unwrap confirmation...');
      await waitForReceipt(network, unwrapHash);
      console.log('  Unwrapped.');
    }
  }

  const afterStep1Idx = await tracker.snapshot();
  tracker.printDeltas('Step 1: USDC -> ETH', beforeIdx, afterStep1Idx);

  // Get actual ETH received
  const actualEthWei = BigInt(swapResult.executedBuyAmount || swapQuote.buyAmount);
  const actualEth = Number(actualEthWei) / 1e18;
  console.log(`  Received: ${formatToken(actualEth, 6)} ETH`);

  // Execute Step 2: Lido stake (leave gas buffer)
  // Reset wallet client to force fresh nonce from RPC after multi-tx step 1
  resetWalletClient();
  const gasBuffer = BigInt(5e15); // 0.005 ETH
  const stakeWei = actualEthWei > gasBuffer ? actualEthWei - gasBuffer : actualEthWei;

  console.log(`\n  ── Step 2: ETH -> stETH (Lido) ${SEP}\n`);
  const staked = await executeLidoStake(stakeWei, network);
  if (!staked) {
    console.log(`  Lido stake failed. You have ${formatToken(actualEth, 6)} ETH.`);
    console.log('  Manually stake with: wallet stake <amount> eth --run');
    return;
  }

  await tracker.snapshotAndPrint('Step 2: ETH -> stETH', afterStep1Idx);
  tracker.printDeltas('Total', beforeIdx, tracker.snapshotCount - 1);
  console.log('');
}

// ── JitoSOL Zap ─────────────────────────────────────

interface JitosolPathOption {
  provider: BridgeProvider;
  quote: BridgeQuote;
  pathType: 'direct' | 'jupiter';
  label: string;
  solReceived: number;
  jitoSolReceived: number;
  value: number;
  cost: number;
  costPct: number;
  fee: number;
}

async function zapJitosol(amount: string, network: Network, dryRun: boolean, pathChoice?: string, providerFlag?: string) {
  if (network === 'testnet') {
    console.error('  JitoSOL zap is mainnet-only (bridges, Jupiter, Jito require mainnet).');
    return;
  }

  const signer = await resolveSigner();
  const account = await signer.getEvmAccount();
  const solAddress = await signer.getSolanaAddress();
  if (!solAddress) { console.error('  No Solana address configured.'); return; }
  const tokens = TOKENS[network];
  const usdcAmount = Number(amount);
  const usdcRaw = parseTokenAmount(amount, tokens.USDC_DECIMALS);

  if (dryRun) warnDryRun();
  console.log(`  Zap: ${formatToken(usdcAmount, 2)} USDC -> JitoSOL`);
  console.log(`  Network: Ethereum mainnet -> Solana mainnet`);
  console.log(`  EVM wallet:    ${account.address}`);
  console.log(`  Solana wallet: ${solAddress}`);
  warnMainnet(network, dryRun);

  // Check balances
  console.log('  Checking balances...');
  const [usdcBalance, ethBalance] = await Promise.all([
    getERC20Balance(network, tokens.USDC, account.address),
    getPublicClient(network).getBalance({ address: account.address }),
  ]);

  if (usdcBalance < usdcRaw) {
    if (dryRun) {
      console.log(`  Warning: Insufficient USDC (have: ${formatToken(Number(usdcBalance) / 1e6, 2)}, need: ${formatToken(usdcAmount, 2)})`);
    } else {
      console.error(`  Insufficient USDC. Have: ${formatToken(Number(usdcBalance) / 1e6, 2)}, need: ${formatToken(usdcAmount, 2)}`);
      return;
    }
  }

  const minEth = BigInt(0.01e18);
  if (ethBalance < minEth) {
    if (dryRun) {
      console.log(`  Warning: Low ETH for gas (have: ${formatToken(Number(ethBalance) / 1e18, 6)}, need: ~0.01 ETH)`);
    } else {
      console.error(`  Insufficient ETH for gas. Have: ${formatToken(Number(ethBalance) / 1e18, 6)}, need at least ~0.01 ETH`);
      return;
    }
  }

  // Resolve bridge provider
  const resolved = resolveBridgeProvider(providerFlag);
  const providersToQuery = resolved !== 'auto'
    ? [getBridgeProvider(resolved)]
    : listBridgeProviders();

  const providerNames = providersToQuery.map(p => p.displayName).join(', ');
  console.log(`  Fetching quotes from ${providerNames}...\n`);

  // Build bridge quote requests: for each provider, try direct SOL and USDC-SOL
  const bridgeQuotePromises = providersToQuery.flatMap(p => [
    withTimeout(p.getQuote({
      srcChainId: '1', dstChainId: '7565164',
      srcToken: DEBRIDGE_CONFIG.tokens.USDC_ETH,
      dstToken: DEBRIDGE_CONFIG.tokens.nativeSOL,
      amount: usdcRaw.toString(),
      srcAddress: account.address, dstAddress: solAddress,
    }), TIMEOUT).then(q => ({ provider: p, quote: q, pathType: 'direct' as const })),
    withTimeout(p.getQuote({
      srcChainId: '1', dstChainId: '7565164',
      srcToken: DEBRIDGE_CONFIG.tokens.USDC_ETH,
      dstToken: DEBRIDGE_CONFIG.tokens.USDC_SOL,
      amount: usdcRaw.toString(),
      srcAddress: account.address, dstAddress: solAddress,
    }), TIMEOUT).then(q => ({ provider: p, quote: q, pathType: 'jupiter' as const })),
  ]);

  // Fetch everything in parallel
  const [marketRes, jupiterRes, jitoRateRes, ...bridgeResults] = await Promise.allSettled([
    fetchMarketPrices(),
    fetchJupiterPreviewQuote(usdcRaw.toString()),
    fetchJitoRate(),
    ...bridgeQuotePromises,
  ]);

  const market = marketRes.status === 'fulfilled' ? marketRes.value : { eth: null, sol: null };
  const jitoRate = jitoRateRes.status === 'fulfilled' ? jitoRateRes.value : null;
  const jupiterQuote = jupiterRes.status === 'fulfilled' ? jupiterRes.value : null;

  if (!jitoRate) {
    console.error('  Jito rate unavailable. Cannot calculate JitoSOL output.');
    return;
  }

  // Build path options from successful quotes
  const paths: JitosolPathOption[] = [];

  for (const result of bridgeResults) {
    if (result.status !== 'fulfilled') continue;
    const { provider, quote, pathType } = result.value;

    if (pathType === 'direct') {
      const solReceived = Number(quote.dstAmount) / 10 ** quote.dstDecimals;
      const jitoSolReceived = solReceived / jitoRate;
      const value = market.sol ? solReceived * market.sol : 0;
      const fee = quote.protocolFeeRaw ? Number(quote.protocolFeeRaw) / 1e18 : 0;
      paths.push({
        provider, quote, pathType,
        label: `${provider.displayName} direct -> Jito`,
        solReceived, jitoSolReceived, value,
        cost: value > 0 ? usdcAmount - value : 0,
        costPct: value > 0 ? ((usdcAmount - value) / usdcAmount) * 100 : 0,
        fee,
      });
    } else if (pathType === 'jupiter' && jupiterQuote) {
      const usdcSolReceived = Number(quote.dstAmount) / 10 ** quote.dstDecimals;
      const jupPricePerSol = Number(jupiterQuote.inAmount) / 1e6 / (Number(jupiterQuote.outAmount) / 1e9);
      const solReceived = usdcSolReceived / jupPricePerSol;
      const jitoSolReceived = solReceived / jitoRate;
      const value = market.sol ? solReceived * market.sol : 0;
      const fee = quote.protocolFeeRaw ? Number(quote.protocolFeeRaw) / 1e18 : 0;
      paths.push({
        provider, quote, pathType,
        label: `${provider.displayName} + Jupiter -> Jito`,
        solReceived, jitoSolReceived, value,
        cost: value > 0 ? usdcAmount - value : 0,
        costPct: value > 0 ? ((usdcAmount - value) / usdcAmount) * 100 : 0,
        fee,
      });
    }
  }

  if (paths.length === 0) {
    console.error('  Failed to get quotes for any JitoSOL path.');
    for (const result of bridgeResults) {
      if (result.status === 'rejected') {
        console.error(`    ${result.reason?.message || 'unknown error'}`);
      }
    }
    return;
  }

  // Sort by JitoSOL received descending (best first)
  paths.sort((a, b) => b.jitoSolReceived - a.jitoSolReceived);

  // Display paths table
  console.log(`  ── JitoSOL Paths ${SEP}\n`);

  const rows = paths.map((p, i) => ({
    num: String(i + 1),
    label: p.label,
    receive: `${formatToken(p.solReceived, 4)} SOL`,
    jitosol: `~${formatToken(p.jitoSolReceived, 4)}`,
    fee: p.fee > 0 ? `${formatToken(p.fee, 6)} ETH` : 'included',
  }));

  const wLabel = Math.max(4, ...rows.map(r => r.label.length));
  const wRecv = Math.max(11, ...rows.map(r => r.receive.length));
  const wJito = Math.max(8, ...rows.map(r => r.jitosol.length));
  const wFee = Math.max(3, ...rows.map(r => r.fee.length));

  console.log(`  ${'#'}  ${('Path').padEnd(wLabel)}  ${('You receive').padEnd(wRecv)}  ${('JitoSOL').padEnd(wJito)}  ${'Fee'}`);
  console.log(`  ${'─'}  ${'─'.repeat(wLabel)}  ${'─'.repeat(wRecv)}  ${'─'.repeat(wJito)}  ${'─'.repeat(wFee)}`);
  for (const r of rows) {
    console.log(`  ${r.num}  ${r.label.padEnd(wLabel)}  ${r.receive.padEnd(wRecv)}  ${r.jitosol.padEnd(wJito)}  ${r.fee}`);
  }

  if (paths.some(p => p.value > 0)) {
    console.log('');
    for (let i = 0; i < paths.length; i++) {
      const p = paths[i];
      if (p.value > 0) {
        console.log(`  ${i + 1}: ${formatUSD(p.value)} value, ${formatUSD(p.cost)} cost (${formatToken(p.costPct, 2)}%)`);
      }
    }
  }
  console.log(`\n  ${SEP}\n`);

  if (dryRun) {
    console.log('  [DRY RUN] Skipping execution.\n');
    return;
  }

  // Path selection
  let selectedIdx: number;
  if (pathChoice) {
    // --path flag: 1 = first direct path, 2 = first jupiter path
    const wantType = parseInt(pathChoice, 10) === 1 ? 'direct' : 'jupiter';
    const found = paths.findIndex(p => p.pathType === wantType);
    if (found === -1) {
      console.error(`  Path ${pathChoice} is unavailable.`);
      return;
    }
    selectedIdx = found;
  } else if (paths.length === 1) {
    selectedIdx = 0;
    console.log(`  Only one path available.\n`);
  } else {
    const choice = await select('Select path', paths.length);
    if (choice === 0) {
      console.log('  Cancelled.\n');
      return;
    }
    selectedIdx = choice - 1;
  }

  const selected = paths[selectedIdx];

  // Show pre-balances before final confirm
  const preTracker = new BalanceTracker([
    ...evmTokens(network, account.address, ['USDC', 'ETH']),
    ...solTokens(network, solAddress, ['SOL', 'JitoSOL']),
  ]);
  await preTracker.snapshot();
  preTracker.printBefore();

  if (!await confirm(`Proceed?`)) {
    console.log('  Cancelled.\n');
    return;
  }

  if (selected.pathType === 'direct') {
    await executeJitosolPath1(usdcRaw, network, selected.provider, selected.quote, jitoRate, solAddress);
  } else {
    await executeJitosolPath2(usdcRaw, network, selected.provider, selected.quote, jitoRate, solAddress);
  }
}

// ── JitoSOL Path 1: USDC -> SOL (bridge) -> JitoSOL (Jito) ──

async function executeJitosolPath1(
  usdcRaw: bigint,
  network: Network,
  provider: BridgeProvider,
  quote: BridgeQuote,
  jitoRate: number,
  solAddress: string,
) {
  const signer = await resolveSigner();
  const account = await signer.getEvmAccount();
  const evmTracker = new BalanceTracker(evmTokens(network, account.address, ['USDC', 'ETH']));
  const solTracker = new BalanceTracker(solTokens(network, solAddress, ['SOL', 'JitoSOL']));
  await Promise.all([evmTracker.snapshot(), solTracker.snapshot()]);

  // Record SOL balance before bridge
  const solBefore = await getSolBalance(network, solAddress);

  // Step 1: Bridge USDC -> SOL
  console.log(`\n  ── Step 1: USDC -> SOL (${provider.displayName}) ${SEP}\n`);
  const { confirmed, orderId } = await executeBridgeTx(provider, quote, usdcRaw, network);
  if (!confirmed) {
    console.log('  Zap cancelled.');
    return;
  }

  const fulfilled = await pollBridgeFulfillment(provider, orderId);
  if (!fulfilled) {
    console.log(`  Check: wallet bridge status ${orderId}`);
    console.log('  After bridge completes, stake manually: wallet stake <amount> sol --run');
    return;
  }

  // Wait for balance update
  await new Promise(r => setTimeout(r, 3000));

  await evmTracker.snapshotAndPrint('Step 1: Source (Ethereum)');
  const afterBridgeSolIdx = await solTracker.snapshot();
  solTracker.printDeltas('Step 1: Destination (Solana)', 0, afterBridgeSolIdx);

  // Check how much SOL we received from the bridge
  const solAfter = await getSolBalance(network, solAddress);
  const bridged = solAfter - solBefore;
  console.log(`  SOL received: ~${formatToken(bridged, 4)} (balance: ${formatToken(solAfter, 4)})`);

  // Stake bridged SOL minus gas buffer
  const stakeAmount = Math.max(0, bridged - 0.02);
  if (stakeAmount <= 0) {
    console.log('  Insufficient SOL to stake after bridge.');
    return;
  }

  // Step 2: Jito stake
  console.log(`\n  ── Step 2: SOL -> JitoSOL (Jito) ${SEP}\n`);
  const staked = await executeJitoStake(stakeAmount, network);
  if (!staked) {
    console.log(`  Jito stake failed. You have ~${formatToken(bridged, 4)} SOL from the bridge.`);
    console.log('  Manually stake: wallet stake <amount> sol --run');
    return;
  }

  await solTracker.snapshotAndPrint('Step 2: SOL -> JitoSOL', afterBridgeSolIdx);
  solTracker.printDeltas('Total (Solana)', 0, solTracker.snapshotCount - 1);
  console.log('');
}

// ── JitoSOL Path 2: USDC -> USDC-SOL (bridge) -> SOL (Jupiter) -> JitoSOL (Jito) ──

async function executeJitosolPath2(
  usdcRaw: bigint,
  network: Network,
  provider: BridgeProvider,
  quote: BridgeQuote,
  jitoRate: number,
  solAddress: string,
) {
  const signer = await resolveSigner();
  const account = await signer.getEvmAccount();
  const evmTracker = new BalanceTracker(evmTokens(network, account.address, ['USDC', 'ETH']));
  const solTracker = new BalanceTracker(solTokens(network, solAddress, ['USDC', 'SOL', 'JitoSOL']));
  await Promise.all([evmTracker.snapshot(), solTracker.snapshot()]);

  // Record SOL balance before bridge
  const solBefore = await getSolBalance(network, solAddress);

  // Step 1: Bridge USDC -> USDC on Solana
  console.log(`\n  ── Step 1: USDC -> USDC on Solana (${provider.displayName}) ${SEP}\n`);
  const { confirmed, orderId } = await executeBridgeTx(provider, quote, usdcRaw, network);
  if (!confirmed) {
    console.log('  Zap cancelled.');
    return;
  }

  const fulfilled = await pollBridgeFulfillment(provider, orderId);
  if (!fulfilled) {
    console.log(`  Check: wallet bridge status ${orderId}`);
    console.log('  After bridge completes, swap + stake manually.');
    return;
  }

  // Wait for balance update
  await new Promise(r => setTimeout(r, 3000));

  await evmTracker.snapshotAndPrint('Step 1: Source (Ethereum)');
  const afterBridgeSolIdx = await solTracker.snapshot();
  solTracker.printDeltas('Step 1: Destination (Solana)', 0, afterBridgeSolIdx);

  // Check USDC on Solana
  const usdcSolBalance = await getSplTokenBalance(network, solAddress, SOLANA_MINTS.USDC);
  console.log(`  USDC on Solana: ${formatToken(usdcSolBalance, 2)}`);
  if (usdcSolBalance <= 0) {
    console.log('  No USDC on Solana to swap. Check: wallet bridge status ' + orderId);
    return;
  }

  // Step 2: Jupiter USDC -> SOL
  console.log(`\n  ── Step 2: USDC -> SOL (Jupiter) ${SEP}\n`);
  const usdcRawSol = Math.round(usdcSolBalance * 1e6).toString();
  const jupResult = await executeJupiterSwap(usdcRawSol, network);
  if (!jupResult.success) {
    console.log(`  Jupiter swap failed. You have ${formatToken(usdcSolBalance, 2)} USDC on Solana.`);
    console.log('  Manually swap with: wallet buy <amount> sol --run');
    return;
  }

  // Wait for balance update
  await new Promise(r => setTimeout(r, 2000));

  const afterJupiterIdx = await solTracker.snapshot();
  solTracker.printDeltas('Step 2: USDC -> SOL', afterBridgeSolIdx, afterJupiterIdx);

  // Check SOL received
  const solAfter = await getSolBalance(network, solAddress);
  const totalReceived = solAfter - solBefore;
  console.log(`  SOL balance: ${formatToken(solAfter, 4)} (received: ~${formatToken(totalReceived, 4)})`);

  // Stake SOL minus gas buffer
  const stakeAmount = Math.max(0, totalReceived - 0.02);
  if (stakeAmount <= 0) {
    console.log('  Insufficient SOL to stake.');
    return;
  }

  // Step 3: Jito stake
  console.log(`\n  ── Step 3: SOL -> JitoSOL (Jito) ${SEP}\n`);
  const staked = await executeJitoStake(stakeAmount, network);
  if (!staked) {
    console.log(`  Jito stake failed. You have ${formatToken(solAfter, 4)} SOL.`);
    console.log('  Manually stake: wallet stake <amount> sol --run');
    return;
  }

  await solTracker.snapshotAndPrint('Step 3: SOL -> JitoSOL', afterJupiterIdx);
  solTracker.printDeltas('Total (Solana)', 0, solTracker.snapshotCount - 1);
  console.log('');
}

// ── Entry Point ─────────────────────────────────────

export async function zapCommand(
  amount: string,
  asset: string,
  network: Network,
  dryRun: boolean,
  pathChoice?: string,
  providerFlag?: string,
) {
  validateAmount(amount);
  const a = asset.toLowerCase();

  if (a === 'steth') {
    await zapSteth(amount, network, dryRun, providerFlag);
  } else if (a === 'jitosol') {
    await zapJitosol(amount, network, dryRun, pathChoice, providerFlag);
  } else {
    console.error('  Supported assets:');
    console.error('    steth      USDC -> ETH -> stETH (Lido, ~3% APR)');
    console.error('    jitosol    USDC -> SOL -> JitoSOL (Jito, ~7% APR)');
    process.exit(1);
  }
}

// ── Zap History ─────────────────────────────────────

interface EtherscanTx {
  hash: string;
  from: string;
  to: string;
  value: string;
  timeStamp: string;
  isError: string;
  functionName: string;
}

interface HistoryEntry {
  timestamp: number;
  type: 'steth' | 'jitosol';
  step: string;
  detail: string;
  status: string;
  id: string;
}

export async function zapHistoryCommand(network: Network) {
  const explorer = EXPLORERS[network];
  const swapProviders = listSwapProviders();
  const bridgeProviders = listBridgeProviders();
  const swapNames = swapProviders.map(p => p.displayName).join(', ');
  const bridgeNames = bridgeProviders.map(p => p.displayName).join(', ');

  console.log(`\n  ── Zap History ${SEP}\n`);
  console.log(`  Fetching from ${swapNames}, ${bridgeNames}, Etherscan, Solana...\n`);

  // Fire all fetches in parallel
  const [swapRes, lidoRes, bridgeRes, jitoRes] = await Promise.allSettled([
    fetchSwapZapOrders(network),
    fetchLidoStakes(network, explorer),
    fetchBridgeZapOrders(),
    fetchJitoStakes(network),
  ]);

  const entries: HistoryEntry[] = [];

  // Swap USDC → WETH orders from all providers (stETH zap step 1)
  if (swapRes.status === 'fulfilled') {
    for (const o of swapRes.value) entries.push(o);
  } else {
    console.log('  Swap providers: failed to fetch');
  }

  // Lido submit() calls (stETH zap step 2)
  if (lidoRes.status === 'fulfilled') {
    for (const o of lidoRes.value) entries.push(o);
  } else {
    console.log('  Lido stakes: failed to fetch');
  }

  // Bridge USDC → SOL / USDC-SOL from all providers (JitoSOL zap step 1)
  if (bridgeRes.status === 'fulfilled') {
    for (const o of bridgeRes.value) entries.push(o);
  } else {
    console.log('  Bridge providers: failed to fetch');
  }

  // Jito deposits (JitoSOL zap step 2/3)
  if (jitoRes.status === 'fulfilled') {
    for (const o of jitoRes.value) entries.push(o);
  } else {
    console.log('  Jito stakes: failed to fetch');
  }

  if (entries.length === 0) {
    console.log('  No zap-related operations found.\n');
    return;
  }

  // Sort by timestamp descending
  entries.sort((a, b) => b.timestamp - a.timestamp);

  // Group consecutive entries that are likely the same zap (within 10 minutes)
  const groups: HistoryEntry[][] = [];
  let currentGroup: HistoryEntry[] = [];

  for (const entry of entries) {
    if (currentGroup.length === 0) {
      currentGroup.push(entry);
    } else {
      const lastTime = currentGroup[currentGroup.length - 1].timestamp;
      // Same zap if within 10 minutes and compatible type
      if (Math.abs(entry.timestamp - lastTime) < 600 && entry.type === currentGroup[0].type) {
        currentGroup.push(entry);
      } else {
        groups.push(currentGroup);
        currentGroup = [entry];
      }
    }
  }
  if (currentGroup.length > 0) groups.push(currentGroup);

  // Collect all entries for dynamic column widths
  const displayGroups = groups.slice(0, HISTORY_LIMIT);
  const allEntries = displayGroups.flatMap(g => g);
  const wStep = Math.max(...allEntries.map(e => e.step.length));
  const wDetail = Math.max(...allEntries.map(e => e.detail.length));

  // Display grouped
  for (const group of displayGroups) {
    const first = group[0];
    const date = new Date(first.timestamp * 1000);
    const dateStr = `${date.getMonth() + 1}/${date.getDate()} ${date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false })}`;
    const asset = first.type === 'steth' ? 'stETH' : 'JitoSOL';

    console.log(`  ${dateStr}  Zap -> ${asset}`);
    for (const entry of group) {
      console.log(`    ${entry.step.padEnd(wStep)}  ${entry.detail.padEnd(wDetail)}  ${entry.status.padEnd(10)}  ${entry.id}`);
    }
    console.log('');
  }

  console.log(`  Related commands: wallet swap history, wallet bridge history, wallet stake history\n`);
}

// ── History Fetchers ────────────────────────────────

async function fetchSwapZapOrders(network: Network): Promise<HistoryEntry[]> {
  const allProviders = listSwapProviders();
  const tokens = TOKENS[network];

  const results = await Promise.allSettled(
    allProviders.map(p => p.getHistory(network)),
  );

  const entries: HistoryEntry[] = [];

  for (let i = 0; i < allProviders.length; i++) {
    if (results[i].status !== 'fulfilled') continue;
    const provOrders = (results[i] as PromiseFulfilledResult<Awaited<ReturnType<SwapProvider['getHistory']>>>).value;
    const provName = allProviders[i].displayName;

    for (const o of provOrders) {
      // Only USDC → WETH sell orders (stETH zap step 1)
      if (o.sellToken.toLowerCase() !== tokens.USDC.toLowerCase()) continue;
      if (o.buyToken.toLowerCase() !== tokens.WETH.toLowerCase()) continue;
      if (o.kind !== 'sell') continue;

      const isFilled = o.status === 'fulfilled';
      const usdcAmt = Number(isFilled ? o.executedSellAmount : o.sellAmount) / 1e6;
      const ethAmt = Number(isFilled ? o.executedBuyAmount : o.buyAmount) / 1e18;
      const ts = Math.floor(new Date(o.createdAt).getTime() / 1000);

      entries.push({
        timestamp: ts,
        type: 'steth',
        step: provName,
        detail: `${formatToken(usdcAmt, 2)} USDC -> ${formatToken(ethAmt, 6)} ETH`,
        status: o.status,
        id: formatAddress(o.orderId, 6),
      });
    }
  }

  return entries;
}

async function fetchLidoStakes(network: Network, explorer: { evm: string }): Promise<HistoryEntry[]> {
  const apiKey = process.env.ETHERSCAN_API_KEY;
  if (!apiKey) return [];

  const signer = await resolveSigner();
  const account = await signer.getEvmAccount();
  const lido = LIDO_CONFIG[network];

  const params = new URLSearchParams({
    chainid: ETHERSCAN_CHAIN_ID[network],
    module: 'account',
    action: 'txlist',
    address: account.address,
    startblock: '0',
    endblock: '99999999',
    page: '1',
    offset: '50',
    sort: 'desc',
    apikey: apiKey,
  });

  const res = await withTimeout(fetch(`${ETHERSCAN_API}?${params}`), TIMEOUT);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = (await res.json()) as { status: string; result: EtherscanTx[] | string };

  if (data.status !== '1' || !Array.isArray(data.result)) return [];

  const entries: HistoryEntry[] = [];
  const stakeTxs = data.result.filter(tx =>
    tx.to.toLowerCase() === lido.stETH.toLowerCase() &&
    tx.functionName.startsWith('submit')
  );

  for (const tx of stakeTxs.slice(0, HISTORY_LIMIT)) {
    const ethVal = Number(tx.value) / 1e18;
    const status = tx.isError === '1' ? 'failed' : 'confirmed';

    entries.push({
      timestamp: Number(tx.timeStamp),
      type: 'steth',
      step: 'Lido',
      detail: `${formatToken(ethVal, 6)} ETH -> stETH`,
      status,
      id: formatAddress(tx.hash, 6),
    });
  }

  return entries;
}

async function fetchBridgeZapOrders(): Promise<HistoryEntry[]> {
  const allProviders = listBridgeProviders();
  const signer = await resolveSigner();
  const account = await signer.getEvmAccount();
  const solAddr = await signer.getSolanaAddress();

  const results = await Promise.allSettled(
    allProviders.map(p => p.getHistory(account.address, solAddr || undefined)),
  );

  const entries: HistoryEntry[] = [];

  for (let i = 0; i < allProviders.length; i++) {
    if (results[i].status !== 'fulfilled') continue;
    const provOrders = (results[i] as PromiseFulfilledResult<Awaited<ReturnType<BridgeProvider['getHistory']>>>).value;
    const provName = allProviders[i].displayName;

    for (const o of provOrders) {
      // Only Ethereum → Solana bridges (JitoSOL zap step 1)
      if (o.srcChainId !== 1 || o.dstChainId !== 7565164) continue;
      if (o.srcToken !== 'USDC') continue;

      const giveAmt = Number(o.srcAmount) / 10 ** o.srcDecimals;
      const takeAmt = Number(o.dstAmount) / 10 ** o.dstDecimals;
      const takeDec = o.dstToken === 'USDC' ? 2 : 4;

      entries.push({
        timestamp: o.createdAt,
        type: 'jitosol',
        step: provName,
        detail: `${formatToken(giveAmt, 2)} USDC -> ${formatToken(takeAmt, takeDec)} ${o.dstToken}`,
        status: o.status,
        id: o.orderId ? formatAddress(o.orderId, 6) : 'N/A',
      });
    }
  }

  return entries;
}

async function fetchJitoStakes(network: Network): Promise<HistoryEntry[]> {
  if (network === 'testnet') return [];
  const signer = await resolveSigner();
  const solAddress = await signer.getSolanaAddress();
  if (!solAddress) return [];

  const conn = getConnection(network);
  const userPk = new PublicKey(solAddress);
  const stakePoolAddr = JITO_CONFIG.stakePool;

  const sigs = await withTimeout(conn.getSignaturesForAddress(userPk, { limit: 50 }), TIMEOUT);
  const entries: HistoryEntry[] = [];

  for (const sig of sigs) {
    if (entries.length >= 10) break;
    try {
      const tx = await conn.getParsedTransaction(sig.signature, { maxSupportedTransactionVersion: 0 });
      if (!tx) continue;
      const accounts = tx.transaction.message.accountKeys.map(k => k.pubkey.toBase58());
      if (!accounts.includes(stakePoolAddr)) continue;

      const shortSig = sig.signature.slice(0, 8) + '...' + sig.signature.slice(-4);
      entries.push({
        timestamp: sig.blockTime || 0,
        type: 'jitosol',
        step: 'Jito',
        detail: 'SOL -> JitoSOL',
        status: sig.err ? 'failed' : 'confirmed',
        id: shortSig,
      });
    } catch { continue; }
  }

  return entries;
}

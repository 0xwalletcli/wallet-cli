import { VersionedTransaction } from '@solana/web3.js';
import { type Network, DEBRIDGE_CONFIG, TOKENS, EXPLORERS, SOLANA_CONFIG, HISTORY_LIMIT } from '../config.js';
import { resolveSigner } from '../signers/index.js';
import { getPublicClient, getERC20Balance, getERC20Allowance, approveERC20, getWalletClient, waitForReceipt, simulateTx } from '../lib/evm.js';
import { getConnection, getSolBalance, getSplTokenBalance } from '../lib/solana.js';
import { resolveAddress } from '../lib/addressbook.js';
import { parseTokenAmount, formatToken, formatAddress } from '../lib/format.js';
import { confirm, select, validateAmount, warnMainnet, warnDryRun } from '../lib/prompt.js';
import { resolveBridgeProvider } from '../lib/config.js';
import { getBridgeProvider, listBridgeProviders } from '../providers/registry.js';
import type { BridgeProvider, BridgeQuote } from '../providers/types.js';
import { BalanceTracker, evmTokens, solTokens } from '../lib/balancedelta.js';

const SEP = '──────────────────────────────────────────';
const QUOTE_TIMEOUT = 15_000;

type Direction = 'evm-to-solana' | 'solana-to-evm';

interface RouteInfo {
  direction: Direction;
  srcToken: string; // 'ETH' | 'USDC' | 'SOL'
  dstToken: string; // 'ETH' | 'USDC' | 'SOL'
}

function detectRoute(from: string, to: string): RouteInfo | null {
  // Existing routes
  if (from === 'ETH' && to === 'SOL') return { direction: 'evm-to-solana', srcToken: 'ETH', dstToken: 'SOL' };
  if (from === 'USDC' && to === 'SOL') return { direction: 'evm-to-solana', srcToken: 'USDC', dstToken: 'SOL' };
  if (from === 'SOL' && to === 'ETH') return { direction: 'solana-to-evm', srcToken: 'SOL', dstToken: 'ETH' };
  if (from === 'SOL' && to === 'USDC') return { direction: 'solana-to-evm', srcToken: 'SOL', dstToken: 'USDC' };

  // USDC cross-chain routes using USDC-SOL token identifier
  if (from === 'USDC' && to === 'USDC-SOL') return { direction: 'evm-to-solana', srcToken: 'USDC', dstToken: 'USDC' };
  if (from === 'USDC-SOL' && to === 'USDC') return { direction: 'solana-to-evm', srcToken: 'USDC', dstToken: 'USDC' };
  if (from === 'USDC-SOL' && to === 'ETH') return { direction: 'solana-to-evm', srcToken: 'USDC', dstToken: 'ETH' };
  if (from === 'USDC-SOL' && to === 'SOL') return { direction: 'solana-to-evm', srcToken: 'USDC', dstToken: 'SOL' };

  return null;
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), ms)),
  ]);
}

export async function bridgeCommand(
  amount: string,
  fromToken: string,
  toToken: string,
  network: Network,
  dryRun: boolean,
  recipient?: string,
  providerFlag?: string,
) {
  validateAmount(amount);
  const from = fromToken.toUpperCase();
  const to = toToken.toUpperCase();

  const route = detectRoute(from, to);
  if (!route) {
    console.error('  Supported bridges:');
    console.error('    Ethereum -> Solana:  bridge <amt> eth sol');
    console.error('                         bridge <amt> usdc sol');
    console.error('                         bridge <amt> usdc usdc-sol');
    console.error('    Solana -> Ethereum:  bridge <amt> sol eth');
    console.error('                         bridge <amt> sol usdc');
    console.error('                         bridge <amt> usdc-sol usdc');
    console.error('                         bridge <amt> usdc-sol eth');
    process.exit(1);
  }

  if (network === 'testnet') {
    console.error('  Bridges only support mainnet. Use --network mainnet.');
    process.exit(1);
  }

  if (route.direction === 'evm-to-solana') {
    await bridgeEvmToSolana(amount, route.srcToken, route.dstToken, network, dryRun, recipient, providerFlag);
  } else {
    await bridgeSolanaToEvm(amount, route.srcToken, route.dstToken, network, dryRun, recipient, providerFlag);
  }
}

// ── Multi-provider quote comparison ──────────────────────────

async function selectBridgeProvider(
  quoteParams: Parameters<BridgeProvider['getQuote']>[0],
  providerFlag?: string,
): Promise<{ provider: BridgeProvider; quote: BridgeQuote }> {
  const resolved = resolveBridgeProvider(providerFlag);

  if (resolved !== 'auto') {
    const provider = getBridgeProvider(resolved);
    console.log(`  Fetching quote from ${provider.displayName}...`);
    const quote = await provider.getQuote(quoteParams);
    return { provider, quote };
  }

  // Auto: fetch from all providers, compare, select
  const allProviders = listBridgeProviders();
  const names = allProviders.map(p => p.displayName).join(', ');
  console.log(`  Fetching quotes from ${names}...`);

  const results = await Promise.allSettled(
    allProviders.map(p => withTimeout(p.getQuote(quoteParams), QUOTE_TIMEOUT))
  );

  const quotes: { provider: BridgeProvider; quote: BridgeQuote }[] = [];
  for (let i = 0; i < allProviders.length; i++) {
    if (results[i].status === 'fulfilled') {
      quotes.push({ provider: allProviders[i], quote: (results[i] as PromiseFulfilledResult<BridgeQuote>).value });
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

  // Sort by dstAmount descending (best rate first)
  quotes.sort((a, b) => Number(b.quote.dstAmount) - Number(a.quote.dstAmount));

  if (quotes.length === 1) {
    console.log(`  Using ${quotes[0].provider.displayName} (only available provider).`);
    return quotes[0];
  }

  // Show comparison table
  console.log(`\n  ── Bridge Quotes ${SEP}\n`);

  const rows = quotes.map((q, i) => {
    const outAmt = Number(q.quote.dstAmount) / 10 ** q.quote.dstDecimals;
    const fee = q.quote.protocolFeeRaw ? Number(q.quote.protocolFeeRaw) / 1e18 : 0;
    return {
      num: String(i + 1),
      name: q.provider.displayName,
      receive: formatToken(outAmt, outAmt >= 100 ? 2 : 6),
      time: `~${q.quote.estimatedTime}s`,
      fee: fee > 0 ? `${formatToken(fee, 6)} ETH` : 'included',
    };
  });

  const wName = Math.max(8, ...rows.map(r => r.name.length));
  const wRecv = Math.max(11, ...rows.map(r => r.receive.length));
  const wTime = Math.max(8, ...rows.map(r => r.time.length));
  const wFee = Math.max(3, ...rows.map(r => r.fee.length));

  console.log(`  ${'#'}  ${('Provider').padEnd(wName)}  ${('You receive').padEnd(wRecv)}  ${('Est. time').padEnd(wTime)}  ${'Fee'}`);
  console.log(`  ${'─'}  ${'─'.repeat(wName)}  ${'─'.repeat(wRecv)}  ${'─'.repeat(wTime)}  ${'─'.repeat(wFee)}`);

  for (const r of rows) {
    console.log(`  ${r.num}  ${r.name.padEnd(wName)}  ${r.receive.padEnd(wRecv)}  ${r.time.padEnd(wTime)}  ${r.fee}`);
  }
  console.log('');

  const choice = await select('Select provider', quotes.length);
  if (choice === 0) {
    console.log('  Cancelled.\n');
    process.exit(0);
  }

  return quotes[choice - 1];
}

// ── Ethereum → Solana ──────────────────────────────────────────

async function bridgeEvmToSolana(
  amount: string,
  from: string,
  to: string,
  network: Network,
  dryRun: boolean,
  recipient?: string,
  providerFlag?: string,
) {
  const signer = await resolveSigner();
  const account = await signer.getEvmAccount();
  let solAddress: string;

  if (recipient) {
    solAddress = resolveAddress(recipient, 'solana');
  } else {
    const addr = await signer.getSolanaAddress();
    if (!addr) {
      console.error('  No Solana address configured and no --recipient specified.');
      process.exit(1);
    }
    solAddress = addr;
  }

  const db = DEBRIDGE_CONFIG;
  const srcToken = from === 'ETH' ? db.tokens.nativeETH : db.tokens.USDC_ETH;
  const dstToken = to === 'USDC' ? db.tokens.USDC_SOL : db.tokens.nativeSOL;
  const decimals = from === 'ETH' ? 18 : 6;
  const srcAmount = parseTokenAmount(amount, decimals);
  const dstLabel = to === 'USDC' ? 'USDC' : 'SOL';

  if (dryRun) warnDryRun();
  console.log(`  Bridge: ${amount} ${from} (Ethereum) -> ${dstLabel} (Solana)`);
  console.log(`  Chain:  Ethereum mainnet -> Solana mainnet`);
  console.log(`  From:   ${account.address}`);
  console.log(`  To:     ${solAddress}`);
  warnMainnet(network, dryRun);
  console.log('  Checking balance...');

  // Check balance
  let insufficientBalance = false;
  if (from === 'USDC') {
    const balance = await getERC20Balance(network, TOKENS[network].USDC, account.address);
    if (balance < srcAmount) {
      console.log(`  ⚠ Insufficient USDC balance (have: ${formatToken(Number(balance) / 1e6, 2)}, need: ${amount})`);
      insufficientBalance = true;
    }
  }

  // Check ETH for gas (+ value if bridging ETH)
  const client = getPublicClient(network);
  const ethBalance = await client.getBalance({ address: account.address });
  if (from === 'ETH') {
    const gasBuffer = BigInt(0.005e18);
    if (ethBalance < srcAmount + gasBuffer) {
      console.log(`  ⚠ Insufficient ETH (have: ${formatToken(Number(ethBalance) / 1e18, 6)}, need: ${amount} + gas)`);
      insufficientBalance = true;
    }
  } else {
    const minEth = BigInt(0.005e18);
    if (ethBalance < minEth) {
      console.log(`  ⚠ Insufficient ETH for gas (have: ${formatToken(Number(ethBalance) / 1e18, 6)}, need: ~0.005 ETH)`);
      insufficientBalance = true;
    }
  }

  // Get quote (multi-provider or single)
  const { provider, quote } = await selectBridgeProvider({
    srcChainId: '1',
    dstChainId: '7565164',
    srcToken,
    dstToken,
    amount: srcAmount.toString(),
    srcAddress: account.address,
    dstAddress: solAddress,
  }, providerFlag);

  const outAmount = Number(quote.dstAmount) / 10 ** quote.dstDecimals;
  const outDecimals = dstLabel === 'USDC' ? 2 : 6;
  const txValue = Number(quote.protocolFeeRaw) / 1e18;
  const protocolFee = from === 'ETH' ? txValue - Number(amount) : txValue;

  console.log(`\n  Provider:     ${provider.displayName}`);
  console.log(`  You send:     ${amount} ${from} on Ethereum`);
  console.log(`  You receive:  ~${formatToken(outAmount, outDecimals)} ${dstLabel} on Solana`);
  console.log(`  Protocol fee: ~${formatToken(protocolFee, 6)} ETH`);
  console.log(`  Est. time:    ~${quote.estimatedTime}s`);
  console.log(`  Order ID:     ${quote.orderId}`);
  if (quote.contractAddress) console.log(`  Contract:     ${quote.contractAddress}`);
  console.log('');

  if (dryRun) {
    console.log('  [DRY RUN] Skipping execution.\n');
    return;
  }

  // Validate the contract address
  if (quote.contractAddress && !provider.knownContracts.has(quote.contractAddress.toLowerCase())) {
    console.error(`  WARNING: Unknown contract address ${quote.contractAddress}`);
    console.error(`  This does not match any known ${provider.displayName} contract.`);
    if (!await confirm('This is unusual. Continue anyway?')) {
      console.log('  Cancelled.\n');
      return;
    }
  }

  // Set up balance trackers for both chains
  const evmTrackTokens = from === 'ETH' ? ['ETH'] : ['USDC', 'ETH'];
  const solTrackTokens = to === 'USDC' ? ['USDC'] : ['SOL'];
  const evmTracker = new BalanceTracker(evmTokens(network, account.address, evmTrackTokens));
  const solTracker = new BalanceTracker(solTokens(network, solAddress, solTrackTokens));
  await Promise.all([evmTracker.snapshot(), solTracker.snapshot()]);
  evmTracker.printBefore();

  if (!await confirm(`Proceed?`)) {
    console.log('  Cancelled.\n');
    return;
  }

  if (insufficientBalance) {
    console.log('  Insufficient balance — cannot execute.\n');
    return;
  }

  // If USDC, approve the contract
  if (from === 'USDC') {
    const spender = provider.getApprovalAddress(quote) as `0x${string}`;
    if (spender) {
      const allowance = await getERC20Allowance(network, TOKENS[network].USDC, account.address, spender);
      if (allowance < srcAmount) {
        console.log(`\n  Approval needed: ${amount} USDC to ${provider.displayName} (${spender})`);
        if (!await confirm('Approve?')) {
          console.log('  Cancelled.\n');
          return;
        }
        const MAX_UINT256 = 2n ** 256n - 1n;
        await approveERC20(network, TOKENS[network].USDC, spender, MAX_UINT256);
      }
    }
  }

  // Send the transaction
  const txData = provider.getTxData(quote);
  await simulateTx(network, {
    account: account.address,
    to: txData.to as `0x${string}`,
    data: txData.data as `0x${string}`,
    value: BigInt(txData.value!),
  });

  console.log('  Sending bridge transaction on Ethereum...');
  const { trackTx, clearTx } = await import('../lib/txtracker.js');
  const explorer = EXPLORERS[network];
  const wallet = await getWalletClient(network);
  const hash = await wallet.sendTransaction({
    account: account,
    to: txData.to as `0x${string}`,
    data: txData.data as `0x${string}`,
    value: BigInt(txData.value!),
  });

  trackTx(hash, 'evm', network);
  console.log(`  TX:  ${hash}`);
  console.log(`  URL: ${explorer.evm}/tx/${hash}`);
  console.log('  Waiting for Ethereum confirmation...');
  await waitForReceipt(network, hash);
  clearTx();
  console.log('  Transaction confirmed on Ethereum.');
  console.log(`\n  Order: ${quote.orderId}\n`);

  // Poll for Solana fulfillment via provider
  // LI.FI needs the source txHash; deBridge uses orderId
  const pollId = provider.id === 'lifi' ? hash : quote.orderId;
  console.log(`  Waiting for Solana fulfillment...`);
  const result = await provider.pollFulfillment(pollId);
  if (result.status === 'fulfilled') {
    console.log(`\n  Bridge complete! Status: fulfilled`);
    if (result.dstTxHash) {
      console.log(`  Solana TX:  ${result.dstTxHash}`);
      console.log(`  URL: ${explorer.solana}/tx/${result.dstTxHash}`);
    }
    await evmTracker.snapshotAndPrint('Source: Ethereum');
    await solTracker.snapshotAndPrint('Destination: Solana');
    console.log('');
  } else {
    console.log('\n  Timed out. Check with: wallet bridge status ' + pollId + '\n');
  }
}

// ── Solana → Ethereum ──────────────────────────────────────────

async function bridgeSolanaToEvm(
  amount: string,
  from: string,
  to: string,
  network: Network,
  dryRun: boolean,
  recipient?: string,
  providerFlag?: string,
) {
  const signer = await resolveSigner();
  const solAddress = await signer.getSolanaAddress();
  if (!solAddress) { console.error('  No Solana address configured.'); process.exit(1); }

  // Destination is EVM
  let evmAddress: string;
  if (recipient) {
    evmAddress = resolveAddress(recipient, 'evm');
  } else {
    const account = await signer.getEvmAccount();
    evmAddress = account.address;
  }

  const db = DEBRIDGE_CONFIG;
  const isSrcUsdc = from === 'USDC';
  const srcToken = isSrcUsdc ? db.tokens.USDC_SOL : db.tokens.nativeSOL;
  const dstToken = to === 'ETH' ? db.tokens.nativeETH : db.tokens.USDC_ETH;
  const srcDecimals = isSrcUsdc ? 6 : 9;
  const srcAmount = parseTokenAmount(amount, srcDecimals);
  const srcLabel = isSrcUsdc ? 'USDC' : 'SOL';

  if (dryRun) warnDryRun();
  console.log(`  Bridge: ${amount} ${srcLabel} (Solana) -> ${to} (Ethereum)`);
  console.log(`  Chain:  Solana mainnet -> Ethereum mainnet`);
  console.log(`  From:   ${solAddress}`);
  console.log(`  To:     ${evmAddress}`);
  warnMainnet(network, dryRun);
  console.log('  Checking balance...');

  // Check balance
  let insufficientBalance = false;
  const amountNum = Number(amount);
  if (isSrcUsdc) {
    const solConfig = SOLANA_CONFIG[network];
    const usdcBal = await getSplTokenBalance(network, solAddress, solConfig.usdcMint);
    if (usdcBal < amountNum) {
      console.log(`  ⚠ Insufficient USDC (have: ${formatToken(usdcBal, 2)}, need: ${amount})`);
      insufficientBalance = true;
    }
    // Still need SOL for tx fees
    const solBalance = await getSolBalance(network, solAddress);
    if (solBalance < 0.01) {
      console.log(`  ⚠ Insufficient SOL for fees (have: ${formatToken(solBalance, 6)}, need: ~0.01)`);
      insufficientBalance = true;
    }
  } else {
    const solBalance = await getSolBalance(network, solAddress);
    const feeBuffer = 0.01;
    if (solBalance < amountNum + feeBuffer) {
      console.log(`  ⚠ Insufficient SOL (have: ${formatToken(solBalance, 6)}, need: ${amount} + ~${feeBuffer} fees)`);
      insufficientBalance = true;
    }
  }

  // Get quote (multi-provider or single)
  const { provider, quote } = await selectBridgeProvider({
    srcChainId: '7565164',
    dstChainId: '1',
    srcToken,
    dstToken,
    amount: srcAmount.toString(),
    srcAddress: solAddress,
    dstAddress: evmAddress,
  }, providerFlag);

  const outAmount = Number(quote.dstAmount) / 10 ** quote.dstDecimals;
  const dstDecimals = to === 'ETH' ? 6 : 2;

  console.log(`\n  Provider:     ${provider.displayName}`);
  console.log(`  You send:     ${amount} ${srcLabel} on Solana`);
  console.log(`  You receive:  ~${formatToken(outAmount, dstDecimals)} ${to} on Ethereum`);
  console.log(`  Est. time:    ~${quote.estimatedTime}s`);
  console.log(`  Order ID:     ${quote.orderId}\n`);

  if (dryRun) {
    console.log('  [DRY RUN] Skipping execution.\n');
    return;
  }

  // Set up balance trackers for both chains
  const solTrackTokens = isSrcUsdc ? ['USDC', 'SOL'] : ['SOL'];
  const evmTrackTokens = to === 'ETH' ? ['ETH'] : ['USDC'];
  const solTracker = new BalanceTracker(solTokens(network, solAddress, solTrackTokens));
  const evmTracker = new BalanceTracker(evmTokens(network, evmAddress as `0x${string}`, evmTrackTokens));
  await Promise.all([solTracker.snapshot(), evmTracker.snapshot()]);
  solTracker.printBefore();

  if (!await confirm(`Proceed?`)) {
    console.log('  Cancelled.\n');
    return;
  }

  if (insufficientBalance) {
    console.log('  Insufficient balance — cannot execute.\n');
    return;
  }

  // Deserialize the Solana VersionedTransaction from provider
  const txData = provider.getTxData(quote);
  console.log('  Sending bridge transaction on Solana...');
  const { trackTx, clearTx } = await import('../lib/txtracker.js');
  const explorer = EXPLORERS[network];
  const conn = getConnection(network);

  const txBytes = Buffer.from(txData.data.slice(2), 'hex');
  const tx = VersionedTransaction.deserialize(txBytes);

  // Update blockhash (API's may be stale by the time user confirms)
  const { blockhash } = await conn.getLatestBlockhash();
  tx.message.recentBlockhash = blockhash;

  // Sign and send
  const signed = await signer.signSolanaVersionedTransaction(tx);
  const signature = await conn.sendTransaction(signed);

  trackTx(signature, 'solana', network);
  console.log(`  TX:  ${signature}`);
  console.log(`  URL: ${explorer.solana}/tx/${signature}`);
  console.log('  Waiting for Solana confirmation...');
  await conn.confirmTransaction(signature);
  clearTx();
  console.log('  Transaction confirmed on Solana.');
  console.log(`\n  Order: ${quote.orderId}\n`);

  // Poll for Ethereum fulfillment via provider
  // LI.FI needs the source txHash; deBridge uses orderId
  const pollId = provider.id === 'lifi' ? signature : quote.orderId;
  console.log(`  Waiting for Ethereum fulfillment...`);
  const result = await provider.pollFulfillment(pollId);
  if (result.status === 'fulfilled') {
    console.log(`\n  Bridge complete! Status: fulfilled`);
    if (result.dstTxHash) {
      console.log(`  Ethereum TX:  ${result.dstTxHash}`);
      console.log(`  URL: ${explorer.evm}/tx/${result.dstTxHash}`);
    }
    await solTracker.snapshotAndPrint('Source: Solana');
    await evmTracker.snapshotAndPrint('Destination: Ethereum');
    console.log('');
  } else {
    console.log('\n  Timed out. Check with: wallet bridge status ' + pollId + '\n');
  }
}

// ── bridge history ──────────────────────────────────────────

function chainName(chainId: number): string {
  if (chainId === 1) return 'Ethereum';
  if (chainId === 7565164) return 'Solana';
  return `Chain ${chainId}`;
}

export async function bridgeHistoryCommand(network: Network) {
  const allProviders = listBridgeProviders();
  const names = allProviders.map(p => p.displayName).join(', ');
  const signer = await resolveSigner();
  const account = await signer.getEvmAccount();
  const solAddr = await signer.getSolanaAddress();
  const explorer = EXPLORERS[network];

  console.log(`\n  Fetching bridge history from ${names}...\n`);

  const results = await Promise.allSettled(
    allProviders.map(p => p.getHistory(account.address, solAddr || undefined)),
  );

  // Merge all orders with provider label
  type OrderType = Awaited<ReturnType<BridgeProvider['getHistory']>>[0];
  const allOrders: { provider: string; order: OrderType }[] = [];
  for (let i = 0; i < allProviders.length; i++) {
    if (results[i].status === 'fulfilled') {
      const provOrders = (results[i] as PromiseFulfilledResult<OrderType[]>).value;
      for (const o of provOrders) {
        allOrders.push({ provider: allProviders[i].displayName, order: o });
      }
    }
  }

  if (allOrders.length === 0) {
    console.log('  No bridge orders found.\n');
    return;
  }

  // Sort by date descending, cap at 15
  allOrders.sort((a, b) => b.order.createdAt - a.order.createdAt);
  const recent = allOrders.slice(0, HISTORY_LIMIT);

  const STATUS_MAP: Record<string, string> = {
    ClaimedUnlock: 'fulfilled',
    SentUnlock: 'fulfilled',
    Fulfilled: 'fulfilled',
    Created: 'pending',
    SentOrderCancel: 'cancelled',
    OrderCancelled: 'cancelled',
    DONE: 'fulfilled',
    PENDING: 'pending',
    FAILED: 'failed',
    NOT_FOUND: 'unknown',
  };

  console.log(`  ── Recent Bridges ${SEP}\n`);

  for (const { provider, order: o } of recent) {
    const giveAmt = Number(o.srcAmount) / 10 ** o.srcDecimals;
    const takeAmt = Number(o.dstAmount) / 10 ** o.dstDecimals;
    const giveDec = o.srcToken === 'USDC' ? 2 : 4;
    const takeDec = o.dstToken === 'USDC' ? 2 : 4;

    const date = new Date(o.createdAt * 1000);
    const dateStr = `${date.getMonth() + 1}/${date.getDate()} ${date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false })}`;
    const sellCol = `${formatToken(giveAmt, giveDec).padStart(8)} ${o.srcToken.padEnd(5)}`;
    const buyCol = `${formatToken(takeAmt, takeDec)} ${o.dstToken}`.padEnd(12);

    let idStr = '';
    if (o.srcTxHash) {
      const txExplorer = o.srcChainId === 1 ? explorer.evm : explorer.solana;
      const shortHash = `${o.srcTxHash.slice(0, 8)}...${o.srcTxHash.slice(-6)}`;
      idStr = `\x1b]8;;${txExplorer}/tx/${o.srcTxHash}\x07${shortHash}\x1b]8;;\x07`;
    } else if (o.orderId) {
      const shortId = o.orderId.length > 16 ? `${o.orderId.slice(0, 8)}...${o.orderId.slice(-6)}` : o.orderId;
      idStr = shortId;
    }

    const status = STATUS_MAP[o.status] || o.status.toLowerCase();
    console.log(`  ${dateStr.padEnd(10)}${sellCol}-> ${buyCol}${status.padEnd(10)} ${provider.padEnd(11)} ${idStr}`);
  }
}

// ── bridge status ──────────────────────────────────────────

export async function bridgeStatusCommand(orderId: string, network: Network) {
  const explorer = EXPLORERS[network];

  console.log(`\n  Fetching bridge order...\n`);

  // Try all providers until one finds the order
  const allProviders = listBridgeProviders();
  let o;
  let matchedProvider: BridgeProvider | undefined;
  for (const provider of allProviders) {
    try {
      o = await provider.getOrderStatus(orderId);
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

  const giveAmt = Number(o.srcAmount) / 10 ** o.srcDecimals;
  const takeAmt = Number(o.dstAmount) / 10 ** o.dstDecimals;
  const giveDec = o.srcToken === 'USDC' ? 2 : 6;
  const takeDec = o.dstToken === 'USDC' ? 2 : 6;

  const isFulfilled = ['Fulfilled', 'SentUnlock', 'ClaimedUnlock'].includes(o.status);

  console.log(`  ── Bridge Order ${SEP}\n`);
  console.log(`  Provider:  ${matchedProvider.displayName}`);
  console.log(`  Order ID:  ${o.orderId}`);
  console.log(`  Status:    ${o.status}`);
  console.log(`  Created:   ${new Date(o.createdAt * 1000).toLocaleString()}`);
  console.log(`\n  You ${isFulfilled ? 'sent' : 'send'}:    ${formatToken(giveAmt, giveDec)} ${o.srcToken} on ${chainName(o.srcChainId)}`);
  console.log(`  You ${isFulfilled ? 'got' : 'get'}:     ${formatToken(takeAmt, takeDec)} ${o.dstToken} on ${chainName(o.dstChainId)}`);

  if (o.srcTxHash) {
    const srcExplorer = o.srcChainId === 1 ? explorer.evm : explorer.solana;
    console.log(`\n  Source TX:  ${o.srcTxHash}`);
    console.log(`  URL:       ${srcExplorer}/tx/${o.srcTxHash}`);
  }

  if (o.dstTxHash) {
    const dstExplorer = o.dstChainId === 1 ? explorer.evm : explorer.solana;
    console.log(`  Dest TX:   ${o.dstTxHash}`);
    console.log(`  URL:       ${dstExplorer}/tx/${o.dstTxHash}`);
  }

  console.log('');
}

/**
 * Peer off-ramp position management (internal implementation)
 *
 * Manages P2P USDC positions on Base chain via Peer.
 * User locks USDC → buyers pay fiat via Venmo/Zelle/CashApp/Revolut → escrow releases.
 * Called from `wallet withdraw` commands.
 */

import { resolveSigner } from '../signers/index.js';
import { formatToken, formatUSD } from '../lib/format.js';
import { confirm, validateAmount, warnDryRun } from '../lib/prompt.js';

// ── Supported platforms ─────────────────────────────────

export async function depositPlatformsCommand() {
  const { SUPPORTED_PLATFORMS, getPlatformLabel } = await import('../lib/peer.js');

  console.log('  Supported payment platforms on Peer:\n');

  const PLATFORM_DETAILS: Record<string, { handle: string; example: string }> = {
    venmo: { handle: 'username or phone', example: '@john-doe or 555-123-4567' },
    zelle: { handle: 'email or phone (registered with your bank)', example: 'you@citibank.com' },
    cashapp: { handle: '$cashtag', example: '$johndoe' },
    revolut: { handle: 'username or @tag', example: '@johndoe' },
  };

  console.log('  ┌─────────────────┬──────────────────────────────────────┬─────────────────────┐');
  console.log('  │ Platform        │ Handle Format                        │ Example             │');
  console.log('  ├─────────────────┼──────────────────────────────────────┼─────────────────────┤');

  for (const p of SUPPORTED_PLATFORMS) {
    const label = getPlatformLabel(p).padEnd(15);
    const details = PLATFORM_DETAILS[p];
    const handle = (details?.handle || '—').padEnd(36);
    const example = (details?.example || '—').padEnd(19);
    console.log(`  │ ${label} │ ${handle} │ ${example} │`);
  }

  console.log('  └─────────────────┴──────────────────────────────────────┴─────────────────────┘');
  console.log('\n  How off-ramp works (USDC → fiat):');
  console.log('    1. You lock USDC into Peer escrow on Base');
  console.log('    2. Buyers find your position on peer.xyz');
  console.log('    3. Buyer pays you fiat via your selected platform(s)');
  console.log('    4. Buyer proves payment with zkTLS → escrow releases USDC to buyer');
  console.log('    5. You keep the fiat + your spread\n');
  console.log('  Example:');
  console.log('    wallet withdraw 1000 --run         # lock USDC, select platforms + spread');
  console.log('    wallet withdraw list                # view your active positions');
  console.log('    wallet withdraw liquidity 1000      # check off-ramp liquidity\n');
}

// ── List deposits ───────────────────────────────────────

export async function depositListCommand(showClosed = false) {
  const { listDeposits } = await import('../providers/offramp/peer.js');
  const { getPlatformLabel } = await import('../lib/peer.js');

  console.log(`  Fetching ${showClosed ? 'closed' : 'active'} positions from Peer...\n`);

  const deposits = await listDeposits();
  const filtered = showClosed
    ? deposits.filter(d => !d.accepting && Number(d.remaining.replace(/,/g, '')) === 0)
    : deposits.filter(d => d.accepting || Number(d.remaining.replace(/,/g, '')) > 0);

  if (filtered.length === 0) {
    console.log(`  No ${showClosed ? 'closed' : 'active'} positions found.\n`);
    console.log('  Create one: wallet withdraw <amount> --run\n');
    return;
  }

  console.log('  ┌──────────┬──────────────┬──────────────┬──────────────┬────────────┬─────────────────────┐');
  console.log('  │ ID       │ Deposited    │ Available    │ Locked       │ Status     │ Payment Methods     │');
  console.log('  ├──────────┼──────────────┼──────────────┼──────────────┼────────────┼─────────────────────┤');

  for (const d of filtered) {
    const id = d.depositId.padEnd(8);
    const amt = d.amount.padStart(10) + '  ';
    const rem = d.remaining.padStart(10) + '  ';
    const lock = d.locked.padStart(10) + '  ';
    const status = (d.accepting ? 'Active' : 'Paused').padEnd(10);
    const methods = d.paymentMethods.map(m => getPlatformLabel(m)).join(', ');
    const methodsTrunc = methods.length > 19 ? methods.slice(0, 16) + '...' : methods.padEnd(19);
    console.log(`  │ ${id} │ ${amt}│ ${rem}│ ${lock}│ ${status} │ ${methodsTrunc} │`);
  }

  console.log('  └──────────┴──────────────┴──────────────┴──────────────┴────────────┴─────────────────────┘');

  const totalDeposited = filtered.reduce((s, d) => s + Number(d.amount.replace(/,/g, '')), 0);
  const totalAvailable = filtered.reduce((s, d) => s + Number(d.remaining.replace(/,/g, '')), 0);
  const totalLocked = filtered.reduce((s, d) => s + Number(d.locked.replace(/,/g, '')), 0);

  console.log(`\n  Total deposited: ${formatToken(totalDeposited, 2)} USDC`);
  console.log(`  Total available: ${formatToken(totalAvailable, 2)} USDC`);
  if (totalLocked > 0) console.log(`  Total locked:    ${formatToken(totalLocked, 2)} USDC`);

  const allSpreads = [...new Set(filtered.flatMap(d => d.spreads))];
  if (allSpreads.length > 0) console.log(`  Spreads:         ${allSpreads.join(', ')}`);

  console.log('');
}

// ── Liquidity preview ───────────────────────────────────

export async function depositLiquidityCommand(amountStr: string) {
  validateAmount(amountStr);
  const { fetchPeerLiquidity } = await import('./quote.js');

  console.log(`  Available USDC to buy with $${amountStr} fiat...\n`);

  const peer = await fetchPeerLiquidity(amountStr);

  if (peer.totalUsdc === 0 || peer.byPlatform.length === 0) {
    console.log('  No USDC available to buy right now.\n');
    console.log('  Peer liquidity is P2P — availability changes in real-time.\n');
    return;
  }

  console.log('  ┌─────────────────────┬──────────────────┬────────────────┬──────────┐');
  console.log('  │ Payment Method      │ Available USDC   │ Best Price     │ Sellers  │');
  console.log('  ├─────────────────────┼──────────────────┼────────────────┼──────────┤');

  for (const p of peer.byPlatform) {
    const label = (p.platform.charAt(0).toUpperCase() + p.platform.slice(1)).padEnd(19);
    const avail = formatUSD(p.totalUsdc, 0).padStart(16);
    const price = `${formatToken(p.bestSpread, 2)}% markup`.padStart(14);
    const sellers = String(p.quoteCount).padStart(8);
    console.log(`  │ ${label} │ ${avail} │ ${price} │ ${sellers} │`);
  }

  console.log('  └─────────────────────┴──────────────────┴────────────────┴──────────┘');
  console.log(`\n  ${formatUSD(peer.totalUsdc, 0)} USDC available from ${peer.byPlatform.reduce((s, p) => s + p.quoteCount, 0)} sellers`);
  if (peer.bestSpread != null) {
    console.log(`  Best price: ${formatToken(peer.bestSpread, 2)}% above market (you pay $${(Number(amountStr) * (1 + peer.bestSpread / 100)).toFixed(2)} for ${formatUSD(Number(amountStr), 0)} USDC)`);
  }
  console.log('');
}

// ── On-ramp: buy USDC with fiat ─────────────────────────

export async function depositBuyCommand(amountStr: string, dryRun: boolean, platformFilter?: string) {
  validateAmount(amountStr);
  const { getPeerClient, BASE_USDC, SUPPORTED_PLATFORMS, getPlatformLabel, rateToSpread } = await import('../lib/peer.js');
  const { createInterface } = await import('readline');

  const signer = await resolveSigner();
  const account = await signer.getEvmAccount();

  if (dryRun) warnDryRun();
  console.log(`  On-ramp: buy ${amountStr} USDC with fiat via Peer`);
  console.log(`  Chain: Base mainnet`);
  console.log(`  To: ${account.address}\n`);

  // Determine which platforms to query
  let platforms: string[];
  if (platformFilter) {
    const p = platformFilter.toLowerCase();
    if (!SUPPORTED_PLATFORMS.includes(p as any)) {
      console.error(`  Unknown platform: "${p}". Valid: ${SUPPORTED_PLATFORMS.join(', ')}`);
      return;
    }
    platforms = [p];
  } else {
    platforms = [...SUPPORTED_PLATFORMS];
  }

  console.log(`  Checking available USDC on ${platforms.map(getPlatformLabel).join(', ')}...`);

  // Fetch quotes — "I want X USDC, how much fiat do I pay?"
  const client = await getPeerClient();
  let quote: any;
  try {
    quote = await client.getQuote({
      paymentPlatforms: platforms,
      fiatCurrency: 'USD',
      user: account.address,
      recipient: account.address,
      destinationChainId: 8453,
      destinationToken: BASE_USDC,
      amount: amountStr,
      isExactFiat: false,
      includeNearbyQuotes: true,
      nearbySearchRange: 10,
      quotesToReturn: 10,
    });
  } catch (err: any) {
    console.error(`  Failed to fetch quotes: ${err.message}\n`);
    return;
  }

  const quotes = quote?.responseObject?.quotes || [];
  if (quotes.length === 0) {
    console.log('\n  No sellers found for this amount.\n');
    console.log('  Peer liquidity is P2P — availability changes in real-time.');
    console.log('  Try: wallet deposit liquidity <amount>  to check availability\n');
    return;
  }

  // Show available quotes
  console.log(`\n  Found ${quotes.length} seller${quotes.length > 1 ? 's' : ''}:\n`);
  console.log('  ┌────┬─────────────────────┬──────────────────┬──────────────────┬──────────┐');
  console.log('  │ #  │ Platform            │ You receive      │ You pay (fiat)   │ Markup   │');
  console.log('  ├────┼─────────────────────┼──────────────────┼──────────────────┼──────────┤');

  for (let i = 0; i < quotes.length; i++) {
    const q = quotes[i];
    const num = String(i + 1).padStart(2);
    const platform = (getPlatformLabel(q.paymentMethod || q.paymentPlatform || '?')).padEnd(19);
    const tokenAmt = q.tokenAmountFormatted || formatToken(Number(q.tokenAmount || 0) / 1e6, 2);
    const receive = `${tokenAmt} USDC`.padStart(16);
    const fiatAmt = q.fiatAmountFormatted || formatUSD(Number(q.fiatAmount || 0) / 100, 2);
    const pay = `$${fiatAmt}`.padStart(16);
    const spread = q.conversionRate ? `${formatToken(rateToSpread(q.conversionRate), 2)}%` : '?';
    const markup = spread.padStart(8);
    console.log(`  │ ${num} │ ${platform} │ ${receive} │ ${pay} │ ${markup} │`);
  }

  console.log('  └────┴─────────────────────┴──────────────────┴──────────────────┴──────────┘');

  if (dryRun) {
    console.log('\n  [DRY RUN] Skipping execution. Add --run to signal intent and buy.\n');
    return;
  }

  // Select a quote
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const choice = await new Promise<string>((resolve) => {
    rl.question(`\n  Select seller [1-${quotes.length}]: `, resolve);
  });
  rl.close();

  const idx = parseInt(choice.trim(), 10) - 1;
  if (isNaN(idx) || idx < 0 || idx >= quotes.length) {
    console.log('  Invalid selection. Cancelled.\n');
    return;
  }

  const selected = quotes[idx];
  const intent = selected.intent;

  // Show summary
  const tokenAmt = selected.tokenAmountFormatted || formatToken(Number(selected.tokenAmount || 0) / 1e6, 2);
  const fiatAmt = selected.fiatAmountFormatted || String(Number(selected.fiatAmount || 0) / 100);
  const platformLabel = getPlatformLabel(selected.paymentMethod || '');

  console.log('\n  ── On-ramp Summary ──');
  console.log(`  You receive: ${tokenAmt} USDC on Base`);
  console.log(`  You pay:     ~$${fiatAmt} via ${platformLabel}`);
  if (selected.payeeData) {
    const payeeKeys = Object.keys(selected.payeeData);
    if (payeeKeys.length > 0) {
      console.log(`  Pay to:      ${Object.values(selected.payeeData).join(', ')}`);
    }
  }
  console.log(`  Chain:       Base mainnet\n`);

  if (!await confirm('Signal intent and lock this trade?')) {
    console.log('  Cancelled.\n');
    return;
  }

  try {
    console.log('  Signaling intent...');
    const hash = await client.signalIntent({
      depositId: BigInt(intent.depositId),
      amount: BigInt(intent.amount),
      toAddress: intent.toAddress as `0x${string}`,
      processorName: intent.processorName,
      payeeDetails: intent.payeeDetails as `0x${string}`,
      fiatCurrencyCode: intent.fiatCurrencyCode,
      conversionRate: BigInt(selected.conversionRate),
    });
    console.log(`  Intent signaled! Trade locked.`);
    console.log(`  TX: ${hash}`);
    console.log(`  URL: https://basescan.org/tx/${hash}`);
    console.log(`\n  Next steps:`);
    console.log(`    1. Pay $${fiatAmt} via ${platformLabel} to the seller`);
    if (selected.payeeData) {
      for (const [key, val] of Object.entries(selected.payeeData)) {
        console.log(`       ${key}: ${val}`);
      }
    }
    console.log(`    2. Proof is generated automatically via zkTLS`);
    console.log(`    3. USDC is released to your wallet once verified\n`);
  } catch (err: any) {
    console.error(`  Signal intent failed: ${err.message}\n`);
  }
}

// ── Create deposit (off-ramp position) ──────────────────

export async function depositCreateCommand(amountStr: string, dryRun: boolean, platformFilter?: string) {
  validateAmount(amountStr);
  const { createDeposit } = await import('../providers/offramp/peer.js');
  const {
    getBaseUsdcBalance, formatUsdc, SUPPORTED_PLATFORMS, getPlatformLabel,
  } = await import('../lib/peer.js');
  const { createInterface } = await import('readline');

  const signer = await resolveSigner();
  const account = await signer.getEvmAccount();

  if (dryRun) warnDryRun();
  console.log(`  Off-ramp: ${amountStr} USDC → fiat via Peer`);
  console.log(`  Chain: Base mainnet`);
  console.log(`  From: ${account.address}\n`);

  console.log('  Checking USDC balance on Base...');
  const balance = await getBaseUsdcBalance(account.address);
  const balanceHuman = Number(balance) / 1e6;
  console.log(`  Balance: ${formatUsdc(balance)} USDC\n`);

  if (balanceHuman < Number(amountStr)) {
    console.error(`  Insufficient USDC on Base (have: ${formatUsdc(balance)}, need: ${amountStr}).`);
    console.error('  Bridge USDC to Base first: wallet bridge <amount> usdc usdc-base\n');
    return;
  }

  // Select payment platforms
  let selectedPlatforms: readonly string[];
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  if (platformFilter) {
    const p = platformFilter.toLowerCase();
    if (!SUPPORTED_PLATFORMS.includes(p as any)) {
      rl.close();
      console.error(`  Unknown platform: "${p}". Valid: ${SUPPORTED_PLATFORMS.join(', ')}`);
      return;
    }
    selectedPlatforms = [p];
    console.log(`  Platform: ${getPlatformLabel(p)}\n`);
  } else {
    console.log('  Select payment methods (enter numbers separated by commas):');
    for (let i = 0; i < SUPPORTED_PLATFORMS.length; i++) {
      console.log(`    ${i + 1}. ${getPlatformLabel(SUPPORTED_PLATFORMS[i])}`);
    }

    const platformAnswer = await new Promise<string>((resolve) => {
      rl.question('  Platforms [1,2,3,...]: ', resolve);
    });

    const platformIndices = platformAnswer.split(',').map(s => parseInt(s.trim(), 10) - 1);
    selectedPlatforms = platformIndices
      .filter(i => i >= 0 && i < SUPPORTED_PLATFORMS.length)
      .map(i => SUPPORTED_PLATFORMS[i]);

    if (selectedPlatforms.length === 0) {
      rl.close();
      console.log('  No valid platforms selected. Cancelled.\n');
      return;
    }

    console.log(`  Selected: ${selectedPlatforms.map(getPlatformLabel).join(', ')}\n`);
  }

  // Collect deposit data (payment handles) per platform — use saved handles if available
  const { getPaymentHandles } = await import('../lib/config.js');
  const savedHandles = getPaymentHandles();

  const HANDLE_HINTS: Record<string, string> = {
    venmo: 'username or phone (e.g., @john-doe or 555-123-4567)',
    zelle: 'email or phone registered with your bank',
    cashapp: '$cashtag (e.g., $johndoe)',
    revolut: 'username or @tag (e.g., @johndoe)',
  };

  const depositData: { [key: string]: string }[] = [];
  for (const platform of selectedPlatforms) {
    const label = getPlatformLabel(platform);
    const saved = (savedHandles as any)[platform];
    if (saved) {
      console.log(`  ${label}: ${saved} (from config)`);
      depositData.push({ processorName: platform, id: saved });
    } else {
      const hint = HANDLE_HINTS[platform] || 'handle/tag';
      const handle = await new Promise<string>((resolve) => {
        rl.question(`  ${label} (${hint}): `, resolve);
      });
      if (!handle.trim()) {
        rl.close();
        console.log(`  Empty handle for ${label}. Cancelled.\n`);
        return;
      }
      depositData.push({ processorName: platform, id: handle.trim() });
    }
  }

  // Spread percentage
  const spreadAnswer = await new Promise<string>((resolve) => {
    rl.question('  Spread % (e.g., 2 for 2%): ', resolve);
  });
  rl.close();
  const spreadPct = Number(spreadAnswer);

  if (isNaN(spreadPct) || spreadPct < 0 || spreadPct > 50) {
    console.error('  Invalid spread. Must be 0-50%.\n');
    return;
  }

  // Summary
  console.log('\n  ── Off-ramp Summary ──');
  console.log(`  Lock:       ${amountStr} USDC in escrow`);
  console.log(`  Platforms:  ${selectedPlatforms.map(getPlatformLabel).join(', ')}`);
  console.log(`  Spread:     ${spreadPct.toFixed(2)}% (your profit)`);
  console.log(`  You receive: ~$${(Number(amountStr) * (1 + spreadPct / 100)).toFixed(2)} fiat when buyer pays`);
  console.log(`  Chain:      Base mainnet\n`);

  if (dryRun) {
    console.log('  [DRY RUN] Skipping execution.\n');
    return;
  }

  if (!await confirm('Lock USDC and create position?')) {
    console.log('  Cancelled.\n');
    return;
  }

  try {
    const result = await createDeposit({
      amount: amountStr,
      platforms: selectedPlatforms as string[],
      depositData,
      spreadPct,
    });
    console.log(`  Position created! USDC locked in escrow.`);
    console.log(`  TX: ${result.hash}`);
    console.log(`  URL: https://basescan.org/tx/${result.hash}`);
    if (result.depositDetails?.length > 0) {
      for (const det of result.depositDetails) {
        console.log(`  Position ID: ${det.depositId || '(pending)'}`);
      }
    }
    console.log('');
  } catch (err: any) {
    console.error(`  Off-ramp failed: ${err.message}\n`);
  }
}

// ── Add funds ───────────────────────────────────────────

export async function depositAddFundsCommand(depositId: string, amountStr: string, dryRun: boolean) {
  validateAmount(amountStr);
  const { addFunds } = await import('../providers/offramp/peer.js');
  const { getBaseUsdcBalance, formatUsdc } = await import('../lib/peer.js');

  const signer = await resolveSigner();
  const account = await signer.getEvmAccount();

  console.log(`  Add Funds: ${amountStr} USDC to position #${depositId}`);
  console.log(`  Chain: Base mainnet`);
  console.log(`  From: ${account.address}\n`);

  console.log('  Checking USDC balance on Base...');
  const balance = await getBaseUsdcBalance(account.address);
  console.log(`  Balance: ${formatUsdc(balance)} USDC\n`);

  if (Number(balance) / 1e6 < Number(amountStr)) {
    console.error(`  Insufficient USDC on Base.\n`);
    return;
  }

  if (dryRun) {
    warnDryRun();
    console.log('  [DRY RUN] Skipping execution.\n');
    return;
  }

  if (!await confirm(`Add ${amountStr} USDC to position #${depositId}?`)) {
    console.log('  Cancelled.\n');
    return;
  }

  try {
    const hash = await addFunds(depositId, amountStr);
    console.log(`  Funds added!`);
    console.log(`  TX: ${hash}`);
    console.log(`  URL: https://basescan.org/tx/${hash}\n`);
  } catch (err: any) {
    console.error(`  Add funds failed: ${err.message}\n`);
  }
}

// ── Remove funds ────────────────────────────────────────

export async function depositRemoveFundsCommand(depositId: string, amountStr: string, dryRun: boolean) {
  validateAmount(amountStr);
  const { removeFunds } = await import('../providers/offramp/peer.js');

  console.log(`  Remove Funds: ${amountStr} USDC from position #${depositId}`);
  console.log(`  Chain: Base mainnet\n`);

  if (dryRun) {
    warnDryRun();
    console.log('  [DRY RUN] Skipping execution.\n');
    return;
  }

  if (!await confirm(`Remove ${amountStr} USDC from position #${depositId}?`)) {
    console.log('  Cancelled.\n');
    return;
  }

  try {
    const hash = await removeFunds(depositId, amountStr);
    console.log(`  Funds removed!`);
    console.log(`  TX: ${hash}`);
    console.log(`  URL: https://basescan.org/tx/${hash}\n`);
  } catch (err: any) {
    console.error(`  Remove funds failed: ${err.message}\n`);
  }
}

// ── Close deposit ───────────────────────────────────────

export async function depositCloseCommand(depositId: string, dryRun: boolean) {
  const { withdrawDeposit } = await import('../providers/offramp/peer.js');

  console.log(`  Close Position: #${depositId}`);
  console.log(`  Chain: Base mainnet`);
  console.log('  This will reclaim all remaining USDC from the position.\n');

  if (dryRun) {
    warnDryRun();
    console.log('  [DRY RUN] Skipping execution.\n');
    return;
  }

  if (!await confirm(`Close position #${depositId} and reclaim USDC?`)) {
    console.log('  Cancelled.\n');
    return;
  }

  try {
    const hash = await withdrawDeposit(depositId);
    console.log(`  Position closed!`);
    console.log(`  TX: ${hash}`);
    console.log(`  URL: https://basescan.org/tx/${hash}\n`);
  } catch (err: any) {
    console.error(`  Close position failed: ${err.message}\n`);
  }
}

// ── Pause / Resume ──────────────────────────────────────

export async function depositPauseResumeCommand(depositId: string, accepting: boolean, dryRun: boolean) {
  const { setAcceptingIntents } = await import('../providers/offramp/peer.js');
  const action = accepting ? 'Resume' : 'Pause';

  console.log(`  ${action} Position: #${depositId}`);
  console.log(`  Chain: Base mainnet\n`);

  if (dryRun) {
    warnDryRun();
    console.log('  [DRY RUN] Skipping execution.\n');
    return;
  }

  if (!await confirm(`${action} position #${depositId}?`)) {
    console.log('  Cancelled.\n');
    return;
  }

  try {
    const hash = await setAcceptingIntents(depositId, accepting);
    console.log(`  Position ${accepting ? 'resumed' : 'paused'}!`);
    console.log(`  TX: ${hash}`);
    console.log(`  URL: https://basescan.org/tx/${hash}\n`);
  } catch (err: any) {
    console.error(`  ${action} failed: ${err.message}\n`);
  }
}

// ── History ─────────────────────────────────────────────

export async function depositHistoryCommand() {
  const { getIntentHistory } = await import('../providers/offramp/peer.js');

  console.log('  Fetching off-ramp history from Peer...\n');

  const history = await getIntentHistory();
  if (history.length === 0) {
    console.log('  No intent history found.\n');
    return;
  }

  console.log('  Recent intents:\n');
  for (const p of history) {
    const date = new Date(p.createdAt).toLocaleDateString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric',
    });
    console.log(`    ${date}  ${p.amount.padStart(12)}  ${p.status}`);
  }
  console.log('');
}

/**
 * Peer deposit management commands
 *
 * Manages P2P USDC deposits on Base chain via Peer.
 * LP model: deposit USDC → buyers pay fiat via Venmo/Zelle/CashApp/Revolut.
 */

import { resolveSigner } from '../signers/index.js';
import { formatToken } from '../lib/format.js';
import { confirm, validateAmount, warnDryRun } from '../lib/prompt.js';

// ── List deposits ───────────────────────────────────────

export async function depositListCommand(showClosed = false) {
  const { listDeposits } = await import('../providers/offramp/peer.js');
  const { getPlatformLabel } = await import('../lib/peer.js');

  console.log(`  Fetching ${showClosed ? 'closed' : 'active'} deposits from Peer...\n`);

  const deposits = await listDeposits();
  const filtered = showClosed
    ? deposits.filter(d => !d.accepting && Number(d.remaining.replace(/,/g, '')) === 0)
    : deposits.filter(d => d.accepting || Number(d.remaining.replace(/,/g, '')) > 0);

  if (filtered.length === 0) {
    console.log(`  No ${showClosed ? 'closed' : 'active'} deposits found.\n`);
    console.log('  Create one: wallet deposit <amount>\n');
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
  const { getLiquidity } = await import('../providers/offramp/peer.js');
  const { getPlatformLabel, SUPPORTED_PLATFORMS } = await import('../lib/peer.js');

  const signer = await resolveSigner();
  const account = await signer.getEvmAccount();

  console.log(`  Fetching orderbook liquidity for $${amountStr}...\n`);

  const quote = await getLiquidity({
    amount: amountStr,
    platforms: [...SUPPORTED_PLATFORMS],
    address: account.address,
  });

  if (!quote || !quote.quotes || quote.quotes.length === 0) {
    console.log('  No liquidity available for this amount.\n');
    return;
  }

  console.log('  ┌─────────────────────┬──────────────┬──────────┬──────────────┐');
  console.log('  │ Payment Method      │ You Receive  │ Spread   │ Available    │');
  console.log('  ├─────────────────────┼──────────────┼──────────┼──────────────┤');

  for (const q of quote.quotes) {
    const method = getPlatformLabel(q.paymentPlatform || '?').padEnd(19);
    const receive = (`$${Number(q.fiatAmount || amountStr).toFixed(2)}`).padStart(12);
    const spread = q.spread ? `${(Number(q.spread) * 100).toFixed(2)}%`.padStart(8) : '   —    ';
    const avail = q.availableLiquidity
      ? formatToken(Number(q.availableLiquidity) / 1e6, 2).padStart(12)
      : '         —  ';
    console.log(`  │ ${method} │ ${receive} │ ${spread} │ ${avail} │`);
  }

  console.log('  └─────────────────────┴──────────────┴──────────┴──────────────┘');
  console.log('');
}

// ── Create deposit ──────────────────────────────────────

export async function depositCreateCommand(amountStr: string, dryRun: boolean) {
  validateAmount(amountStr);
  const { createDeposit } = await import('../providers/offramp/peer.js');
  const {
    getBaseUsdcBalance, formatUsdc, SUPPORTED_PLATFORMS, getPlatformLabel,
  } = await import('../lib/peer.js');
  const { createInterface } = await import('readline');

  const signer = await resolveSigner();
  const account = await signer.getEvmAccount();

  if (dryRun) warnDryRun();
  console.log(`  Create Deposit: ${amountStr} USDC on Peer`);
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
  console.log('  Select payment methods (enter numbers separated by commas):');
  for (let i = 0; i < SUPPORTED_PLATFORMS.length; i++) {
    console.log(`    ${i + 1}. ${getPlatformLabel(SUPPORTED_PLATFORMS[i])}`);
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const platformAnswer = await new Promise<string>((resolve) => {
    rl.question('  Platforms [1,2,3,...]: ', resolve);
  });

  const platformIndices = platformAnswer.split(',').map(s => parseInt(s.trim(), 10) - 1);
  const selectedPlatforms = platformIndices
    .filter(i => i >= 0 && i < SUPPORTED_PLATFORMS.length)
    .map(i => SUPPORTED_PLATFORMS[i]);

  if (selectedPlatforms.length === 0) {
    rl.close();
    console.log('  No valid platforms selected. Cancelled.\n');
    return;
  }

  console.log(`  Selected: ${selectedPlatforms.map(getPlatformLabel).join(', ')}\n`);

  // Collect deposit data (payment handles) per platform
  const HANDLE_HINTS: Record<string, string> = {
    venmo: 'username or phone (e.g., @john-doe or 555-123-4567)',
    zelle: 'email or phone registered with your bank',
    cashapp: '$cashtag (e.g., $johndoe)',
    revolut: 'username or @tag (e.g., @johndoe)',
  };

  const depositData: { [key: string]: string }[] = [];
  for (const platform of selectedPlatforms) {
    const label = getPlatformLabel(platform);
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
  console.log('\n  ── Deposit Summary ──');
  console.log(`  Amount:     ${amountStr} USDC`);
  console.log(`  Platforms:  ${selectedPlatforms.map(getPlatformLabel).join(', ')}`);
  console.log(`  Spread:     ${spreadPct.toFixed(2)}%`);
  console.log(`  Buyer pays: $${(Number(amountStr) * (1 + spreadPct / 100)).toFixed(2)} for ${amountStr} USDC`);
  console.log(`  Chain:      Base mainnet\n`);

  if (dryRun) {
    console.log('  [DRY RUN] Skipping execution.\n');
    return;
  }

  if (!await confirm('Create deposit?')) {
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
    console.log(`  Deposit created!`);
    console.log(`  TX: ${result.hash}`);
    console.log(`  URL: https://basescan.org/tx/${result.hash}`);
    if (result.depositDetails?.length > 0) {
      for (const det of result.depositDetails) {
        console.log(`  Deposit ID: ${det.depositId || '(pending)'}`);
      }
    }
    console.log('');
  } catch (err: any) {
    console.error(`  Deposit creation failed: ${err.message}\n`);
  }
}

// ── Add funds ───────────────────────────────────────────

export async function depositAddFundsCommand(depositId: string, amountStr: string, dryRun: boolean) {
  validateAmount(amountStr);
  const { addFunds } = await import('../providers/offramp/peer.js');
  const { getBaseUsdcBalance, formatUsdc } = await import('../lib/peer.js');

  const signer = await resolveSigner();
  const account = await signer.getEvmAccount();

  console.log(`  Add Funds: ${amountStr} USDC to deposit #${depositId}`);
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

  if (!await confirm(`Add ${amountStr} USDC to deposit #${depositId}?`)) {
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

  console.log(`  Remove Funds: ${amountStr} USDC from deposit #${depositId}`);
  console.log(`  Chain: Base mainnet\n`);

  if (dryRun) {
    warnDryRun();
    console.log('  [DRY RUN] Skipping execution.\n');
    return;
  }

  if (!await confirm(`Remove ${amountStr} USDC from deposit #${depositId}?`)) {
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

  console.log(`  Close Deposit: #${depositId}`);
  console.log(`  Chain: Base mainnet`);
  console.log('  This will withdraw all remaining funds from the deposit.\n');

  if (dryRun) {
    warnDryRun();
    console.log('  [DRY RUN] Skipping execution.\n');
    return;
  }

  if (!await confirm(`Close deposit #${depositId} and withdraw all funds?`)) {
    console.log('  Cancelled.\n');
    return;
  }

  try {
    const hash = await withdrawDeposit(depositId);
    console.log(`  Deposit closed!`);
    console.log(`  TX: ${hash}`);
    console.log(`  URL: https://basescan.org/tx/${hash}\n`);
  } catch (err: any) {
    console.error(`  Close deposit failed: ${err.message}\n`);
  }
}

// ── Pause / Resume ──────────────────────────────────────

export async function depositPauseResumeCommand(depositId: string, accepting: boolean, dryRun: boolean) {
  const { setAcceptingIntents } = await import('../providers/offramp/peer.js');
  const action = accepting ? 'Resume' : 'Pause';

  console.log(`  ${action} Deposit: #${depositId}`);
  console.log(`  Chain: Base mainnet\n`);

  if (dryRun) {
    warnDryRun();
    console.log('  [DRY RUN] Skipping execution.\n');
    return;
  }

  if (!await confirm(`${action} deposit #${depositId}?`)) {
    console.log('  Cancelled.\n');
    return;
  }

  try {
    const hash = await setAcceptingIntents(depositId, accepting);
    console.log(`  Deposit ${accepting ? 'resumed' : 'paused'}!`);
    console.log(`  TX: ${hash}`);
    console.log(`  URL: https://basescan.org/tx/${hash}\n`);
  } catch (err: any) {
    console.error(`  ${action} failed: ${err.message}\n`);
  }
}

// ── History ─────────────────────────────────────────────

export async function depositHistoryCommand() {
  const { getIntentHistory } = await import('../providers/offramp/peer.js');

  console.log('  Fetching deposit history from Peer...\n');

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

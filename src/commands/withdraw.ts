import { type Network, TOKENS, EXPLORERS } from '../config.js';
import { resolveSigner } from '../signers/index.js';
import { getPublicClient, getWalletClient, getERC20Balance, waitForReceipt } from '../lib/evm.js';
import { parseTokenAmount, formatToken, formatUSD } from '../lib/format.js';
import { confirm, validateAmount, warnMainnet, warnDryRun, select } from '../lib/prompt.js';
import { trackTx, clearTx } from '../lib/txtracker.js';
import { BalanceTracker, evmTokens } from '../lib/balancedelta.js';
import { resolveOfframpProvider } from '../lib/config.js';
import { getOfframpProvider, listConfiguredOfframpProviders } from '../providers/registry.js';
import type { OfframpProvider } from '../providers/types.js';

function resolveProvider(providerFlag?: string): OfframpProvider {
  const resolved = resolveOfframpProvider(providerFlag);

  if (resolved !== 'auto') {
    return getOfframpProvider(resolved);
  }

  // Auto: pick the first configured provider
  const configured = listConfiguredOfframpProviders();
  if (configured.length === 0) {
    console.error('  No off-ramp providers configured.');
    console.error('  Set EVM_PRIVATE_KEY in .env for Peer (P2P off-ramp).');
    console.error('  Set SPRITZ_API_KEY in .env for Spritz Finance (ACH).');
    console.error('  Run: wallet withdraw --help');
    process.exit(1);
  }
  return configured[0];
}

export async function withdrawCommand(
  amountStr: string,
  network: Network,
  dryRun: boolean,
  platformFilter?: string,
) {
  validateAmount(amountStr);
  const amount = Number(amountStr);

  if (network !== 'mainnet') {
    console.error('  Withdraw is mainnet only (off-ramp providers do not support testnet).');
    process.exit(1);
  }

  const provider = resolveProvider();

  // Peer: off-ramp via P2P escrow on Base
  if (provider.id === 'peer') {
    const { depositCreateCommand } = await import('./deposit.js');
    await depositCreateCommand(amountStr, dryRun, platformFilter);
    return;
  }

  if (dryRun) warnDryRun();
  console.log(`  Withdraw: ${amountStr} USDC -> bank account via ${provider.displayName}`);
  console.log(`  Chain: Ethereum ${network}`);
  warnMainnet(network, dryRun);

  const signer = await resolveSigner();
  const account = await signer.getEvmAccount();
  const tokens = TOKENS[network];
  const explorer = EXPLORERS[network];

  console.log(`  From: ${account.address}`);
  console.log('  Fetching accounts...');

  const accounts = await provider.listAccounts();
  if (!accounts || accounts.length === 0) {
    console.error(`  No accounts linked in ${provider.displayName}. Set up your account with the provider first.`);
    process.exit(1);
  }

  console.log('\n  Linked accounts:');
  for (let i = 0; i < accounts.length; i++) {
    const acct = accounts[i];
    const last4 = acct.accountNumber ? ` ****${acct.accountNumber.slice(-4)}` : '';
    console.log(`    ${i + 1}. ${acct.label}${last4}`);
  }

  let selectedAccount = accounts[0];
  if (accounts.length > 1) {
    const choice = await select('Select account', accounts.length);
    if (choice === 0) {
      console.log('  Cancelled.\n');
      return;
    }
    selectedAccount = accounts[choice - 1];
  }

  const last4 = selectedAccount.accountNumber ? ` ****${selectedAccount.accountNumber.slice(-4)}` : '';

  console.log('  Checking USDC balance...');
  const balance = await getERC20Balance(network, tokens.USDC, account.address);
  const parsedAmount = parseTokenAmount(amountStr, tokens.USDC_DECIMALS);

  let insufficientBalance = false;
  if (balance < parsedAmount) {
    console.log(`  Insufficient USDC (have: ${formatToken(Number(balance) / 10 ** tokens.USDC_DECIMALS, 2)}, need: ${amountStr})`);
    insufficientBalance = true;
  }

  console.log('  Fetching quote...');
  const quote = await provider.getQuote({
    amount: amountStr,
    bankAccountId: selectedAccount.id,
    tokenAddress: tokens.USDC,
    network,
  });

  console.log(`\n  You withdraw:  ${amountStr} USDC`);
  console.log(`  To:            ${selectedAccount.label}${last4}`);
  console.log(`  Via:           ${provider.displayName}`);
  if (quote.estimatedTime) console.log(`  ETA:           ${quote.estimatedTime}`);
  console.log(`  Chain:         Ethereum ${network}\n`);

  const tracker = new BalanceTracker(evmTokens(network, account.address, ['USDC', 'ETH']));

  if (dryRun) {
    console.log('  [DRY RUN] Skipping execution.\n');
    return;
  }

  await tracker.snapshot();
  tracker.printBefore();

  if (!await confirm('Proceed?')) {
    console.log('  Cancelled.\n');
    return;
  }

  if (insufficientBalance) {
    console.log('  Insufficient balance — cannot execute.\n');
    return;
  }

  console.log('  Sending transaction...');
  const wallet = await getWalletClient(network);

  try {
    const hash = await wallet.sendTransaction({
      account,
      to: quote.txParams.to as `0x${string}`,
      data: quote.txParams.data as `0x${string}`,
      value: quote.txParams.value ? BigInt(quote.txParams.value) : 0n,
      ...(quote.txParams.gasLimit ? { gas: BigInt(quote.txParams.gasLimit) } : {}),
    });
    trackTx(hash, 'evm', network);
    console.log(`  TX:  ${hash}`);
    console.log(`  URL: ${explorer.evm}/tx/${hash}`);
    console.log('  Waiting for confirmation...');
    await waitForReceipt(network, hash);
    clearTx();
    console.log('  Transaction confirmed. The provider will process the transfer.');
  } catch (err: any) {
    clearTx();
    console.error(`  Withdraw failed: ${err.message}`);
  }

  await tracker.snapshotAndPrint('Withdraw');
  console.log('');
}

export async function withdrawHistoryCommand(providerFlag?: string) {
  const provider = resolveProvider(providerFlag);
  console.log(`  Fetching withdrawal history from ${provider.displayName}...\n`);

  const history = await provider.getHistory();
  if (history.length === 0) {
    console.log('  No withdrawal history found.\n');
    return;
  }

  console.log('  Recent withdrawals:\n');
  for (const p of history) {
    const date = new Date(p.createdAt).toLocaleDateString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric',
    });
    console.log(`    ${date}  ${p.amount.padStart(12)}  ${p.status}`);
  }
  console.log('');
}

export async function withdrawLiquidityCommand(amountStr: string) {
  validateAmount(amountStr);
  const { fetchPeerLiquidity } = await import('./quote.js');
  const { formatToken: fmtToken, formatUSD: fmtUSD } = await import('../lib/format.js');

  console.log(`\n  Off-ramp Liquidity: ${amountStr} USDC → Fiat`);
  console.log('  Checking Peer P2P orderbook...\n');

  try {
    const peer = await fetchPeerLiquidity(amountStr);

    if (peer.totalUsdc === 0 || peer.byPlatform.length === 0) {
      console.log('  No Peer liquidity available for this amount.\n');
      console.log('  Peer liquidity is P2P — availability changes in real-time.');
      console.log('  Try again later or use: wallet withdraw <amount> (Spritz ACH)\n');
      return;
    }

    console.log('  ┌─────────────────┬──────────────────┬────────────────┬──────────┐');
    console.log('  │ Platform        │ LP Capacity      │ Best Spread    │ LPs      │');
    console.log('  ├─────────────────┼──────────────────┼────────────────┼──────────┤');

    for (const p of peer.byPlatform) {
      const label = (p.platform.charAt(0).toUpperCase() + p.platform.slice(1)).padEnd(15);
      const avail = fmtUSD(p.totalUsdc, 0).padStart(16);
      const spread = `${fmtToken(p.bestSpread, 2)}%`.padStart(14);
      const lps = String(p.quoteCount).padStart(8);
      console.log(`  │ ${label} │ ${avail} │ ${spread} │ ${lps} │`);
    }

    console.log('  └─────────────────┴──────────────────┴────────────────┴──────────┘');
    console.log(`\n  ${peer.byPlatform.reduce((s, p) => s + p.quoteCount, 0)} LPs can fill your ${fmtUSD(Number(amountStr), 0)} order (total LP capacity: ${fmtUSD(peer.totalUsdc, 0)})`);
    if (peer.bestSpread != null) {
      console.log(`  Best spread: ${fmtToken(peer.bestSpread, 2)}%`);
    }

    // Bridge cost estimate + net fiat
    try {
      const { getBridgeProvider } = await import('../providers/registry.js');
      const { resolveSigner } = await import('../signers/index.js');
      let srcAddr = '0x0000000000000000000000000000000000000001';
      try { srcAddr = (await (await resolveSigner()).getEvmAccount()).address; } catch {}
      const bridgeProvider = getBridgeProvider('debridge');
      const usdcRaw = String(Math.round(Number(amountStr) * 1e6));
      const quote = await bridgeProvider.getQuote({
        srcChainId: '1', dstChainId: '8453',
        srcToken: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
        dstToken: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        amount: usdcRaw, srcAddress: srcAddr, dstAddress: srcAddr,
      });
      const usdcReceived = Number(quote.dstAmount) / 10 ** quote.dstDecimals;
      const bridgeFee = Number(amountStr) - usdcReceived;
      const spreadEarnings = peer.bestSpread != null ? usdcReceived * (peer.bestSpread / 100) : 0;
      const netFiat = usdcReceived + spreadEarnings;
      console.log(`\n  Estimated breakdown for ${fmtUSD(Number(amountStr), 0)} USDC (at ${fmtToken(peer.bestSpread ?? 0, 2)}% spread):`);
      console.log(`    Bridge fee (Ethereum → Base):  -${fmtUSD(bridgeFee)}`);
      console.log(`    USDC locked in escrow:          ${fmtUSD(usdcReceived, 2)}`);
      if (peer.bestSpread != null) console.log(`    Spread you earn:               +${fmtUSD(spreadEarnings)} (buyer pays this on top)`);
      console.log(`    You receive (fiat):            ~${fmtUSD(netFiat)}`);
    } catch { /* bridge estimate is best-effort */ }

    console.log('\n  Note: You set your own spread when creating a position.');
    console.log('  Higher spread = more profit per fill, but slower to find buyers.');
    console.log('  You must wait for a buyer — fills are not instant.\n');
    console.log('  For full off-ramp quote: wallet quote <amount>');
    console.log('  To off-ramp: wallet withdraw <amount> --run\n');
  } catch (err: any) {
    console.error(`  Failed to fetch Peer liquidity: ${err.message}\n`);
  }
}

export async function withdrawAccountsCommand() {
  const provider = getOfframpProvider('spritz');
  console.log(`  Fetching linked accounts from ${provider.displayName}...\n`);

  const accounts = await provider.listAccounts();
  if (!accounts || accounts.length === 0) {
    console.log(`  No accounts linked. Set up your account with ${provider.displayName} first.\n`);
    return;
  }

  for (const acct of accounts) {
    const last4 = acct.accountNumber ? ` ****${acct.accountNumber.slice(-4)}` : '';
    console.log(`    ${acct.label}${last4}  (${acct.type || ''})`);
  }
  console.log('');
}

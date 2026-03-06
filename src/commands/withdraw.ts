import { type Network, TOKENS, EXPLORERS } from '../config.js';
import { resolveSigner } from '../signers/index.js';
import { getPublicClient, getWalletClient, getERC20Balance, waitForReceipt } from '../lib/evm.js';
import { parseTokenAmount, formatToken, formatUSD } from '../lib/format.js';
import { confirm, validateAmount, warnMainnet, warnDryRun } from '../lib/prompt.js';
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
    console.error('  No offramp providers configured.');
    console.error('  Set SPRITZ_API_KEY in .env for Spritz Finance.');
    console.error('  More providers coming soon (Peer/ZKP2P, Transak, MoonPay).');
    process.exit(1);
  }
  return configured[0];
}

export async function withdrawCommand(
  amountStr: string,
  network: Network,
  dryRun: boolean,
  providerFlag?: string,
) {
  validateAmount(amountStr);
  const amount = Number(amountStr);

  if (network !== 'mainnet') {
    console.error('  Withdraw is mainnet only (off-ramp providers do not support testnet).');
    process.exit(1);
  }

  const provider = resolveProvider(providerFlag);

  if (dryRun) warnDryRun();
  console.log(`  Withdraw: ${amountStr} USDC -> bank account via ${provider.displayName}`);
  console.log(`  Chain: Ethereum ${network}`);
  warnMainnet(network, dryRun);

  // Get signer + check balance
  const signer = await resolveSigner();
  const account = await signer.getEvmAccount();
  const tokens = TOKENS[network];
  const explorer = EXPLORERS[network];

  console.log(`  From: ${account.address}`);
  console.log('  Fetching accounts...');

  // List accounts and let user pick
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
    const { select } = await import('../lib/prompt.js');
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

export async function withdrawAccountsCommand(providerFlag?: string) {
  const provider = resolveProvider(providerFlag);
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

import { type Network, TOKENS, EXPLORERS } from '../config.js';
import { resolveSigner } from '../signers/index.js';
import { getPublicClient, getWalletClient, getERC20Balance, waitForReceipt } from '../lib/evm.js';
import { parseTokenAmount, formatToken, formatUSD } from '../lib/format.js';
import { confirm, validateAmount, warnMainnet, warnDryRun } from '../lib/prompt.js';
import { trackTx, clearTx } from '../lib/txtracker.js';
import { BalanceTracker, evmTokens } from '../lib/balancedelta.js';
import { listBankAccounts, createPaymentRequest, getWeb3PaymentParams, getPaymentHistory } from '../lib/spritz.js';

export async function withdrawCommand(
  amountStr: string,
  network: Network,
  dryRun: boolean,
) {
  validateAmount(amountStr);
  const amount = Number(amountStr);

  if (network !== 'mainnet') {
    console.error('  Withdraw is mainnet only (Spritz does not support testnet).');
    process.exit(1);
  }

  if (dryRun) warnDryRun();
  console.log(`  Withdraw: ${amountStr} USDC -> bank account via Spritz`);
  console.log(`  Chain: Ethereum ${network}`);
  warnMainnet(network, dryRun);

  // Get signer + check balance
  const signer = await resolveSigner();
  const account = await signer.getEvmAccount();
  const tokens = TOKENS[network];
  const explorer = EXPLORERS[network];

  console.log(`  From: ${account.address}`);
  console.log('  Fetching bank accounts...');

  // List bank accounts and let user pick
  const accounts = await listBankAccounts();
  if (!accounts || accounts.length === 0) {
    console.error('  No bank accounts linked in Spritz. Add one at https://app.spritz.finance');
    process.exit(1);
  }

  console.log('\n  Linked bank accounts:');
  for (let i = 0; i < accounts.length; i++) {
    const acct = accounts[i];
    const label = acct.name || acct.institution?.name || acct.holder || 'Bank Account';
    const lastFour = acct.accountNumber ? ` ****${acct.accountNumber.slice(-4)}` : '';
    console.log(`    ${i + 1}. ${label}${lastFour}`);
  }

  let selectedAccount: typeof accounts[0];
  if (accounts.length === 1) {
    selectedAccount = accounts[0];
  } else {
    const { select } = await import('../lib/prompt.js');
    const choice = await select('Select account', accounts.length);
    if (choice === 0) {
      console.log('  Cancelled.\n');
      return;
    }
    selectedAccount = accounts[choice - 1];
  }

  const acctLabel = selectedAccount.name || selectedAccount.institution?.name || selectedAccount.holder || 'Bank Account';
  const lastFour = selectedAccount.accountNumber ? ` ****${selectedAccount.accountNumber.slice(-4)}` : '';

  console.log('  Checking USDC balance...');
  const balance = await getERC20Balance(network, tokens.USDC, account.address);
  const parsedAmount = parseTokenAmount(amountStr, tokens.USDC_DECIMALS);

  let insufficientBalance = false;
  if (balance < parsedAmount) {
    console.log(`  Insufficient USDC (have: ${formatToken(Number(balance) / 10 ** tokens.USDC_DECIMALS, 2)}, need: ${amountStr})`);
    insufficientBalance = true;
  }

  console.log('  Creating payment request...');
  const paymentRequest = await createPaymentRequest(
    (selectedAccount as any).id,
    amount,
    tokens.USDC,
  );

  console.log('  Fetching transaction parameters...');
  const txParams = await getWeb3PaymentParams(paymentRequest, tokens.USDC);

  console.log(`\n  You withdraw:  ${amountStr} USDC`);
  console.log(`  To:            ${acctLabel}${lastFour}`);
  console.log(`  Via:           Spritz Finance`);
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
    const web3Params = txParams as any;
    const hash = await wallet.sendTransaction({
      account,
      to: web3Params.contractAddress as `0x${string}`,
      data: web3Params.calldata as `0x${string}`,
      value: web3Params.value ? BigInt(web3Params.value) : 0n,
      ...(web3Params.suggestedGasLimit ? { gas: BigInt(web3Params.suggestedGasLimit) } : {}),
    });
    trackTx(hash, 'evm', network);
    console.log(`  TX:  ${hash}`);
    console.log(`  URL: ${explorer.evm}/tx/${hash}`);
    console.log('  Waiting for confirmation...');
    await waitForReceipt(network, hash);
    clearTx();
    console.log('  Transaction confirmed. Spritz will process the ACH transfer (~1 business day).');
  } catch (err: any) {
    clearTx();
    console.error(`  Withdraw failed: ${err.message}`);
  }

  await tracker.snapshotAndPrint('Withdraw');
  console.log('');
}

export async function withdrawHistoryCommand() {
  console.log('  Fetching withdrawal history from Spritz...\n');

  const accounts = await listBankAccounts();
  if (!accounts || accounts.length === 0) {
    console.log('  No bank accounts linked.\n');
    return;
  }

  let allPayments: any[] = [];
  for (const acct of accounts) {
    try {
      const payments = await getPaymentHistory((acct as any).id);
      if (Array.isArray(payments)) {
        allPayments = allPayments.concat(payments);
      }
    } catch { /* skip accounts with no history */ }
  }

  if (allPayments.length === 0) {
    console.log('  No withdrawal history found.\n');
    return;
  }

  // Sort by date descending
  allPayments.sort((a: any, b: any) => {
    const dateA = new Date(a.createdAt || a.created || 0).getTime();
    const dateB = new Date(b.createdAt || b.created || 0).getTime();
    return dateB - dateA;
  });

  const limit = 10;
  const shown = allPayments.slice(0, limit);

  console.log('  Recent withdrawals:\n');
  for (const p of shown) {
    const date = new Date(p.createdAt || p.created || 0).toLocaleDateString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric',
    });
    const amount = p.amount ? formatUSD(p.amount / 100) : '?';
    const status = (p.status || 'unknown').toLowerCase();
    console.log(`    ${date}  ${amount.padStart(12)}  ${status}`);
  }
  console.log('');
}

export async function withdrawAccountsCommand() {
  console.log('  Fetching linked bank accounts from Spritz...\n');

  const accounts = await listBankAccounts();
  if (!accounts || accounts.length === 0) {
    console.log('  No bank accounts linked. Add one at https://app.spritz.finance\n');
    return;
  }

  for (const acct of accounts) {
    const label = acct.name || acct.institution?.name || acct.holder || 'Bank Account';
    const last4 = acct.accountNumber ? ` ****${acct.accountNumber.slice(-4)}` : '';
    const type = acct.bankAccountSubType || acct.bankAccountType || '';
    console.log(`    ${label}${last4}  (${type})`);
  }
  console.log('');
}

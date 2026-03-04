import { parseEther, formatEther } from 'viem';
import { type Network, EXPLORERS } from '../config.js';
import { resolveSigner } from '../signers/index.js';
import { getPublicClient, getWethBalance, wrapEth, unwrapWeth, waitForReceipt } from '../lib/evm.js';
import { getSolBalance, getWsolBalance, wrapSol, unwrapSol } from '../lib/solana.js';
import { formatToken } from '../lib/format.js';
import { confirm, validateAmount, warnMainnet, warnDryRun } from '../lib/prompt.js';
import { BalanceTracker, evmTokens, solTokens } from '../lib/balancedelta.js';

export async function wrapCommand(amount: string, token: string, network: Network, dryRun: boolean) {
  validateAmount(amount);
  const t = token.toLowerCase();

  if (t === 'eth') {
    await wrapEthCommand(amount, network, dryRun);
  } else if (t === 'sol') {
    await wrapSolCommand(amount, network, dryRun);
  } else {
    console.error('  Supported: eth (ETH -> WETH), sol (SOL -> WSOL)');
    process.exit(1);
  }
}

export async function unwrapCommand(token: string, network: Network, dryRun: boolean, amount?: string) {
  const t = token.toLowerCase();

  if (t === 'weth') {
    if (amount) validateAmount(amount);
    await unwrapWethCommand(network, dryRun, amount);
  } else if (t === 'wsol') {
    await unwrapWsolCommand(network, dryRun);
  } else {
    console.error('  Supported: weth (WETH -> ETH), wsol (WSOL -> SOL)');
    process.exit(1);
  }
}

// ── ETH -> WETH ──

async function wrapEthCommand(amount: string, network: Network, dryRun: boolean) {
  const signer = await resolveSigner();
  const account = await signer.getEvmAccount();
  const value = parseEther(amount);
  const explorer = EXPLORERS[network];

  if (dryRun) warnDryRun();
  console.log(`  Wrap: ${amount} ETH -> WETH`);
  console.log(`  Chain: Ethereum ${network}`);
  console.log(`  Wallet: ${account.address}`);
  warnMainnet(network, dryRun);
  console.log('  Checking balance...');

  const balance = await getPublicClient(network).getBalance({ address: account.address });
  const gasBuffer = parseEther('0.005');
  if (balance < value + gasBuffer) {
    console.log(`  Insufficient ETH (have: ${formatToken(Number(balance) / 1e18, 6)}, need: ${amount} + gas)\n`);
    return;
  }

  console.log(`\n  You wrap:    ${amount} ETH`);
  console.log(`  You receive: ${amount} WETH\n`);

  const tracker = new BalanceTracker(evmTokens(network, account.address, ['ETH', 'WETH']));

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

  console.log('  Sending transaction...');
  const { trackTx, clearTx } = await import('../lib/txtracker.js');
  try {
    const hash = await wrapEth(network, value);
    trackTx(hash, 'evm', network);
    console.log(`  TX:  ${hash}`);
    console.log(`  URL: ${explorer.evm}/tx/${hash}`);
    console.log('  Waiting for confirmation...');
    await waitForReceipt(network, hash);
    clearTx();
  } catch (err: any) {
    clearTx();
    console.error(`  Wrap failed: ${err.message}`);
  }
  await tracker.snapshotAndPrint('Wrap');
  console.log('');
}

// ── WETH -> ETH ──

async function unwrapWethCommand(network: Network, dryRun: boolean, amount?: string) {
  const signer = await resolveSigner();
  const account = await signer.getEvmAccount();
  const explorer = EXPLORERS[network];

  if (dryRun) warnDryRun();
  console.log('  Unwrap: WETH -> ETH');
  console.log(`  Chain: Ethereum ${network}`);
  console.log(`  Wallet: ${account.address}`);
  warnMainnet(network, dryRun);
  console.log('  Checking WETH balance...');

  const wethBal = await getWethBalance(network, account.address);
  if (wethBal === BigInt(0)) {
    console.log('  No WETH to unwrap.\n');
    return;
  }

  let value: bigint;
  if (amount) {
    value = parseEther(amount);
    if (value > wethBal) {
      console.log(`  Insufficient WETH (have: ${formatEther(wethBal)}, want: ${amount})`);
      console.log(`  Tip: run "wallet unwrap weth --run" to unwrap your full balance.\n`);
      return;
    }
  } else {
    value = wethBal;
  }

  const displayAmount = formatToken(Number(value) / 1e18, 6);
  console.log(`\n  You unwrap:  ${displayAmount} WETH`);
  console.log(`  You receive: ~${displayAmount} ETH\n`);

  const tracker = new BalanceTracker(evmTokens(network, account.address, ['ETH', 'WETH']));

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

  console.log('  Sending transaction...');
  const { trackTx, clearTx } = await import('../lib/txtracker.js');
  try {
    const hash = await unwrapWeth(network, value);
    trackTx(hash, 'evm', network);
    console.log(`  TX:  ${hash}`);
    console.log(`  URL: ${explorer.evm}/tx/${hash}`);
    console.log('  Waiting for confirmation...');
    await waitForReceipt(network, hash);
    clearTx();
  } catch (err: any) {
    clearTx();
    console.error(`  Unwrap failed: ${err.message}`);
  }
  await tracker.snapshotAndPrint('Unwrap');
  console.log('');
}

// ── SOL -> WSOL ──

async function wrapSolCommand(amount: string, network: Network, dryRun: boolean) {
  const signer = await resolveSigner();
  const walletAddr = await signer.getSolanaAddress();
  if (!walletAddr) { console.error('  No Solana address configured.'); process.exit(1); }
  const amountNum = Number(amount);
  const explorer = EXPLORERS[network];

  if (dryRun) warnDryRun();
  console.log(`  Wrap: ${amount} SOL -> WSOL`);
  console.log(`  Chain: Solana ${network}`);
  console.log(`  Wallet: ${walletAddr}`);
  warnMainnet(network, dryRun);
  console.log('  Checking balance...');

  const balance = await getSolBalance(network, walletAddr);
  if (balance < amountNum + 0.01) {
    console.log(`  Insufficient SOL (have: ${formatToken(balance, 6)}, need: ${amount} + fees)\n`);
    return;
  }

  console.log(`\n  You wrap:    ${amount} SOL`);
  console.log(`  You receive: ${amount} WSOL\n`);

  const tracker = new BalanceTracker(solTokens(network, walletAddr, ['SOL', 'WSOL']));

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

  console.log('  Sending transaction...');
  try {
    const sig = await wrapSol(network, signer, amountNum);
    const cluster = network === 'testnet' ? '?cluster=devnet' : '';
    console.log(`  TX:  ${sig}`);
    console.log(`  URL: ${explorer.solana}/tx/${sig}${cluster}`);
  } catch (err: any) {
    console.error(`  Wrap failed: ${err.message}`);
  }
  await tracker.snapshotAndPrint('Wrap');
  console.log('');
}

// ── WSOL -> SOL ──

async function unwrapWsolCommand(network: Network, dryRun: boolean) {
  const signer = await resolveSigner();
  const walletAddr = await signer.getSolanaAddress();
  if (!walletAddr) { console.error('  No Solana address configured.'); process.exit(1); }
  const explorer = EXPLORERS[network];

  if (dryRun) warnDryRun();
  console.log('  Unwrap: WSOL -> SOL');
  console.log(`  Chain: Solana ${network}`);
  console.log(`  Wallet: ${walletAddr}`);
  warnMainnet(network, dryRun);
  console.log('  Checking WSOL balance...');

  const wsolBal = await getWsolBalance(network, walletAddr);
  if (wsolBal === 0) {
    console.log('  No WSOL to unwrap.\n');
    return;
  }

  console.log(`\n  You unwrap:  ${formatToken(wsolBal, 6)} WSOL`);
  console.log(`  You receive: ~${formatToken(wsolBal, 6)} SOL`);
  console.log('  Note: WSOL always unwraps entire balance.\n');

  const tracker = new BalanceTracker(solTokens(network, walletAddr, ['SOL', 'WSOL']));

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

  console.log('  Sending transaction...');
  try {
    const sig = await unwrapSol(network, signer);
    const cluster = network === 'testnet' ? '?cluster=devnet' : '';
    console.log(`  TX:  ${sig}`);
    console.log(`  URL: ${explorer.solana}/tx/${sig}${cluster}`);
  } catch (err: any) {
    console.error(`  Unwrap failed: ${err.message}`);
  }
  await tracker.snapshotAndPrint('Unwrap');
  console.log('');
}

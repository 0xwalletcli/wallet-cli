import { parseEther, parseAbi } from 'viem';
import { PublicKey, Transaction, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { getAssociatedTokenAddressSync, createAssociatedTokenAccountInstruction, getAccount, NATIVE_MINT } from '@solana/spl-token';
import { type Network, TOKENS, WSOL_CONFIG, EXPLORERS } from '../config.js';
import { resolveSigner } from '../signers/index.js';
import { getPublicClient, getWalletClient, getERC20Balance, waitForReceipt } from '../lib/evm.js';
import { getConnection, getSolBalance, getWsolBalance, sendSol } from '../lib/solana.js';
import { resolveAddress } from '../lib/addressbook.js';
import { parseTokenAmount, formatToken } from '../lib/format.js';
import { confirm, validateAmount, warnMainnet, warnDryRun } from '../lib/prompt.js';
import { trackTx, clearTx } from '../lib/txtracker.js';
import { BalanceTracker, evmTokens, solTokens } from '../lib/balancedelta.js';

export async function sendCommand(
  amount: string,
  token: string,
  recipient: string,
  network: Network,
  dryRun: boolean,
) {
  validateAmount(amount);
  const t = token.toUpperCase();

  if (!['ETH', 'USDC', 'SOL', 'WSOL', 'WSOL-ETH'].includes(t)) {
    console.error('  Supported tokens: eth, usdc, sol, wsol, wsol-eth');
    process.exit(1);
  }

  if (dryRun) warnDryRun();
  const chain = ['SOL', 'WSOL'].includes(t) ? 'Solana' : 'Ethereum';
  console.log(`  Send: ${amount} ${t}`);
  console.log(`  Chain: ${chain} ${network}`);
  warnMainnet(network, dryRun);

  if (t === 'SOL') {
    await sendSolCommand(amount, recipient, network, dryRun);
  } else if (t === 'WSOL') {
    await sendWsolCommand(amount, recipient, network, dryRun);
  } else if (t === 'WSOL-ETH') {
    await sendEvmCommand(amount, 'WSOL-ETH', recipient, network, dryRun);
  } else {
    await sendEvmCommand(amount, t, recipient, network, dryRun);
  }
}

async function sendEvmCommand(amount: string, token: string, recipient: string, network: Network, dryRun: boolean) {
  const signer = await resolveSigner();
  const account = await signer.getEvmAccount();
  const to = resolveAddress(recipient, 'evm') as `0x${string}`;
  const explorer = EXPLORERS[network];

  console.log(`  From: ${account.address}`);
  console.log(`  To:   ${to}`);
  console.log('  Checking balance...');

  if (token === 'ETH') {
    const value = parseEther(amount);
    const client = getPublicClient(network);
    const balance = await client.getBalance({ address: account.address });

    let insufficientBalance = false;
    if (balance < value) {
      console.log(`  ⚠ Insufficient ETH (have: ${formatToken(Number(balance) / 1e18, 6)}, need: ${amount})`);
      insufficientBalance = true;
    }

    console.log(`\n  You send:  ${amount} ETH`);
    console.log(`  To:        ${to}`);
    console.log(`  Chain:     Ethereum ${network}\n`);

    const tracker = new BalanceTracker(evmTokens(network, account.address, ['ETH']));

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

    console.log('  Sending transaction...');
    const wallet = await getWalletClient(network);
    try {
      const hash = await wallet.sendTransaction({ account, to, value });
      trackTx(hash, 'evm', network);
      console.log(`  TX:  ${hash}`);
      console.log(`  URL: ${explorer.evm}/tx/${hash}`);
      console.log('  Waiting for confirmation...');
      await waitForReceipt(network, hash);
      clearTx();
    } catch (err: any) {
      clearTx();
      console.error(`  Send failed: ${err.message}`);
    }
    await tracker.snapshotAndPrint('Send');
    console.log('');

  } else if (token === 'USDC') {
    const tokens = TOKENS[network];
    const parsedAmount = parseTokenAmount(amount, tokens.USDC_DECIMALS);
    const balance = await getERC20Balance(network, tokens.USDC, account.address);

    let insufficientBalance = false;
    if (balance < parsedAmount) {
      console.log(`  ⚠ Insufficient USDC (have: ${formatToken(Number(balance) / 10 ** tokens.USDC_DECIMALS, 2)}, need: ${amount})`);
      insufficientBalance = true;
    }

    console.log(`\n  You send:  ${amount} USDC`);
    console.log(`  To:        ${to}`);
    console.log(`  Chain:     Ethereum ${network}\n`);

    const tracker = new BalanceTracker(evmTokens(network, account.address, ['USDC', 'ETH']));

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

    console.log('  Sending transaction...');
    const wallet = await getWalletClient(network);
    try {
      const hash = await wallet.writeContract({
        account,
        address: tokens.USDC,
        abi: parseAbi(['function transfer(address to, uint256 amount) returns (bool)']),
        functionName: 'transfer',
        args: [to, parsedAmount],
      });
      trackTx(hash, 'evm', network);
      console.log(`  TX:  ${hash}`);
      console.log(`  URL: ${explorer.evm}/tx/${hash}`);
      console.log('  Waiting for confirmation...');
      await waitForReceipt(network, hash);
      clearTx();
    } catch (err: any) {
      clearTx();
      console.error(`  Send failed: ${err.message}`);
    }
    await tracker.snapshotAndPrint('Send');
    console.log('');

  } else if (token === 'WSOL-ETH') {
    const tokens = TOKENS[network];
    const parsedAmount = parseTokenAmount(amount, tokens.WSOL_DECIMALS);
    const balance = await getERC20Balance(network, tokens.WSOL, account.address);

    let insufficientBalance = false;
    if (balance < parsedAmount) {
      console.log(`  ⚠ Insufficient WSOL-ETH (have: ${formatToken(Number(balance) / 10 ** tokens.WSOL_DECIMALS, 6)}, need: ${amount})`);
      insufficientBalance = true;
    }

    console.log(`\n  You send:  ${amount} WSOL-ETH`);
    console.log(`  To:        ${to}`);
    console.log(`  Chain:     Ethereum ${network}\n`);

    const tracker = new BalanceTracker(evmTokens(network, account.address, ['WSOL-ETH', 'ETH']));

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

    console.log('  Sending transaction...');
    const wallet = await getWalletClient(network);
    try {
      const hash = await wallet.writeContract({
        account,
        address: tokens.WSOL,
        abi: parseAbi(['function transfer(address to, uint256 amount) returns (bool)']),
        functionName: 'transfer',
        args: [to, parsedAmount],
      });
      trackTx(hash, 'evm', network);
      console.log(`  TX:  ${hash}`);
      console.log(`  URL: ${explorer.evm}/tx/${hash}`);
      console.log('  Waiting for confirmation...');
      await waitForReceipt(network, hash);
      clearTx();
    } catch (err: any) {
      clearTx();
      console.error(`  Send failed: ${err.message}`);
    }
    await tracker.snapshotAndPrint('Send');
    console.log('');
  }
}

async function sendSolCommand(amount: string, recipient: string, network: Network, dryRun: boolean) {
  const signer = await resolveSigner();
  const walletAddr = await signer.getSolanaAddress();
  if (!walletAddr) { console.error('  No Solana address configured.'); process.exit(1); }
  const to = resolveAddress(recipient, 'solana');
  const amountNum = Number(amount);
  const explorer = EXPLORERS[network];

  console.log(`  From: ${walletAddr}`);
  console.log(`  To:   ${to}`);
  console.log('  Checking balance...');

  const balance = await getSolBalance(network, walletAddr);
  let insufficientBalance = false;
  if (balance < amountNum + 0.001) {
    console.log(`  ⚠ Insufficient SOL (have: ${formatToken(balance, 6)}, need: ${amount} + fees)`);
    insufficientBalance = true;
  }

  console.log(`\n  You send:  ${amount} SOL`);
  console.log(`  To:        ${to}`);
  console.log(`  Chain:     Solana ${network}\n`);

  const tracker = new BalanceTracker(solTokens(network, walletAddr, ['SOL']));

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

  console.log('  Sending transaction...');
  try {
    const sig = await sendSol(network, signer, to, amountNum);
    const cluster = network === 'testnet' ? '?cluster=devnet' : '';
    console.log(`  TX:  ${sig}`);
    console.log(`  URL: ${explorer.solana}/tx/${sig}${cluster}`);
  } catch (err: any) {
    console.error(`  Send failed: ${err.message}`);
  }
  await tracker.snapshotAndPrint('Send');
  console.log('');
}

async function sendWsolCommand(amount: string, recipient: string, network: Network, dryRun: boolean) {
  const signer = await resolveSigner();
  const walletAddr = await signer.getSolanaAddress();
  if (!walletAddr) { console.error('  No Solana address configured.'); process.exit(1); }
  const to = resolveAddress(recipient, 'solana');
  const amountNum = Number(amount);
  const explorer = EXPLORERS[network];
  const lamports = Math.round(amountNum * LAMPORTS_PER_SOL);

  console.log(`  From: ${walletAddr}`);
  console.log(`  To:   ${to}`);
  console.log('  Checking WSOL balance...');

  const balance = await getWsolBalance(network, walletAddr);
  let insufficientBalance = false;
  if (balance < amountNum) {
    console.log(`  ⚠ Insufficient WSOL (have: ${formatToken(balance, 6)}, need: ${amount})`);
    insufficientBalance = true;
  }

  console.log(`\n  You send:  ${amount} WSOL`);
  console.log(`  To:        ${to}`);
  console.log(`  Chain:     Solana ${network}\n`);

  const tracker = new BalanceTracker(solTokens(network, walletAddr, ['WSOL', 'SOL']));

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

  console.log('  Sending transaction...');
  const conn = getConnection(network);
  const fromPubkey = new PublicKey(walletAddr);
  const toPubkey = new PublicKey(to);
  const toAta = getAssociatedTokenAddressSync(NATIVE_MINT, toPubkey);

  const tx = new Transaction();

  // Create recipient's WSOL ATA if needed
  try {
    await getAccount(conn, toAta);
  } catch {
    tx.add(createAssociatedTokenAccountInstruction(
      fromPubkey,
      toAta,
      toPubkey,
      NATIVE_MINT,
    ));
  }

  // Transfer WSOL (SPL token transfer)
  const { createTransferInstruction } = await import('@solana/spl-token');
  const fromAta = getAssociatedTokenAddressSync(NATIVE_MINT, fromPubkey);
  tx.add(createTransferInstruction(fromAta, toAta, fromPubkey, BigInt(lamports)));

  try {
    const sig = await signer.signAndSendSolanaTransaction(conn, tx);
    const cluster = network === 'testnet' ? '?cluster=devnet' : '';
    console.log(`  TX:  ${sig}`);
    console.log(`  URL: ${explorer.solana}/tx/${sig}${cluster}`);
  } catch (err: any) {
    console.error(`  Send failed: ${err.message}`);
  }
  await tracker.snapshotAndPrint('Send');
  console.log('');
}

import { parseEther, parseAbi } from 'viem';
import { PublicKey, Transaction, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { depositSol } from '@solana/spl-stake-pool';
import { type Network, LIDO_CONFIG, JITO_CONFIG, ETHERSCAN_API, ETHERSCAN_CHAIN_ID, EXPLORERS, HISTORY_LIMIT } from '../config.js';
import { resolveSigner } from '../signers/index.js';
import { getPublicClient, getWalletClient, waitForReceipt } from '../lib/evm.js';
import { getConnection, getSolBalance } from '../lib/solana.js';
import { formatToken, formatAddress, txLink } from '../lib/format.js';
import { confirm, validateAmount, warnMainnet, warnDryRun } from '../lib/prompt.js';
import { BalanceTracker, evmTokens, solTokens } from '../lib/balancedelta.js';

const SEP = '──────────────────────────────────────────';

export async function stakeCommand(
  amount: string,
  token: string,
  network: Network,
  dryRun: boolean,
) {
  validateAmount(amount);
  const t = token.toUpperCase();

  if (t === 'ETH') {
    await stakeEth(amount, network, dryRun);
  } else if (t === 'SOL') {
    await stakeSol(amount, network, dryRun);
  } else {
    console.error('  Supported: eth (Lido stETH), sol (Jito JitoSOL)');
    process.exit(1);
  }
}

async function stakeEth(amount: string, network: Network, dryRun: boolean) {
  const signer = await resolveSigner();
  const account = await signer.getEvmAccount();
  const lido = LIDO_CONFIG[network];
  const value = parseEther(amount);

  if (dryRun) warnDryRun();
  console.log(`  Stake: ${amount} ETH -> stETH (Lido)`);
  console.log(`  Chain: Ethereum ${network}`);
  console.log(`  Wallet: ${account.address}`);
  console.log(`  Lido contract: ${lido.stETH}`);
  warnMainnet(network, dryRun);
  console.log('  Checking balance...');

  // Check ETH balance
  const client = getPublicClient(network);
  const balance = await client.getBalance({ address: account.address });
  const gasBuffer = parseEther('0.005');

  let insufficientBalance = false;
  if (balance < value + gasBuffer) {
    console.log(`  ⚠ Insufficient ETH (have: ${formatToken(Number(balance) / 1e18, 6)}, need: ${amount} + gas)`);
    insufficientBalance = true;
  }

  console.log(`  You stake: ${amount} ETH`);
  console.log(`  You receive: ~${amount} stETH (1:1)\n`);

  const tracker = new BalanceTracker(evmTokens(network, account.address, ['ETH', 'stETH']));

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

  console.log('  Submitting to Lido...');
  const { trackTx, clearTx } = await import('../lib/txtracker.js');
  const explorer = EXPLORERS[network];
  const wallet = await getWalletClient(network);
  try {
    const hash = await wallet.writeContract({
      account,
      address: lido.stETH,
      abi: parseAbi(['function submit(address _referral) payable returns (uint256)']),
      functionName: 'submit',
      args: ['0x0000000000000000000000000000000000000000' as `0x${string}`],
      value,
    });

    trackTx(hash, 'evm', network);
    console.log(`  TX:  ${hash}`);
    console.log(`  URL: ${explorer.evm}/tx/${hash}`);
    console.log('  Waiting for confirmation...');
    await waitForReceipt(network, hash);
    clearTx();
  } catch (err: any) {
    clearTx();
    console.error(`  Stake failed: ${err.message}`);
  }
  await tracker.snapshotAndPrint('Stake');
  console.log('');
}

async function stakeSol(amount: string, network: Network, dryRun: boolean) {
  if (network === 'testnet') {
    console.error('  Jito staking is mainnet-only.');
    process.exit(1);
  }

  const signer = await resolveSigner();
  const walletAddr = await signer.getSolanaAddress();
  if (!walletAddr) { console.error('  No Solana address configured.'); process.exit(1); }
  const amountNum = Number(amount);
  const lamports = Math.round(amountNum * LAMPORTS_PER_SOL);

  if (dryRun) warnDryRun();
  console.log(`  Stake: ${amount} SOL -> JitoSOL (Jito)`);
  console.log(`  Chain: Solana ${network}`);
  console.log(`  Wallet: ${walletAddr}`);
  console.log(`  Stake pool: ${JITO_CONFIG.stakePool}`);
  warnMainnet(network, dryRun);
  console.log('  Checking balance...');

  // Check SOL balance
  const balance = await getSolBalance(network, walletAddr);
  let insufficientBalance = false;
  if (balance < amountNum + 0.01) {
    console.log(`  ⚠ Insufficient SOL (have: ${formatToken(balance, 6)}, need: ${amount} + fees)`);
    insufficientBalance = true;
  }

  console.log(`\n  You stake: ${amount} SOL`);
  console.log('  You receive: JitoSOL (rate varies)\n');

  const tracker = new BalanceTracker(solTokens(network, walletAddr, ['SOL', 'JitoSOL']));

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

  const conn = getConnection(network);
  const stakePoolAddress = new PublicKey(JITO_CONFIG.stakePool);
  const userPubkey = new PublicKey(walletAddr);

  console.log('  Building transaction...');
  const { instructions, signers: ephemeralSigners } = await depositSol(
    conn,
    stakePoolAddress,
    userPubkey,
    lamports,
  );

  const tx = new Transaction();
  for (const ix of instructions) {
    tx.add(ix);
  }

  // Add ephemeral signers (e.g., stake account keypairs)
  // For EnvSigner, signAndSendSolanaTransaction handles the user keypair
  // Ephemeral signers need to be added to the tx before sending
  if (ephemeralSigners.length > 0) {
    tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
    tx.feePayer = userPubkey;
    tx.partialSign(...ephemeralSigners);
  }

  console.log('  Sending transaction...');
  try {
    const sig = await signer.signAndSendSolanaTransaction(conn, tx);
    const explorer = EXPLORERS[network];
    console.log(`  TX:  ${sig}`);
    console.log(`  URL: ${explorer.solana}/tx/${sig}`);
  } catch (err: any) {
    console.error(`  Stake failed: ${err.message}`);
  }
  await tracker.snapshotAndPrint('Stake');
  console.log('');
}

// ── Stake History ──

interface EtherscanTx {
  hash: string;
  from: string;
  to: string;
  value: string;
  timeStamp: string;
  isError: string;
  functionName: string;
}

export async function stakeHistoryCommand(network: Network) {
  const explorer = EXPLORERS[network];

  console.log(`\n  ── Recent Stakes ${SEP}\n`);
  console.log('  Fetching history...');

  // ── Build parallel fetch promises ──
  const apiKey = process.env.ETHERSCAN_API_KEY;
  const signer = await resolveSigner();
  const solAddress = await signer.getSolanaAddress();

  type EvmRow = { date: Date; ethVal: number; ok: boolean; hash: string };
  interface JitoRow { date: Date | null; solAmt: number; jitoAmt: number; err: boolean; sig: string }

  const evmPromise: Promise<EvmRow[]> = (async () => {
    if (!apiKey) return [];
    const account = await signer.getEvmAccount();
    const lido = LIDO_CONFIG[network];
    const params = new URLSearchParams({
      chainid: ETHERSCAN_CHAIN_ID[network],
      module: 'account', action: 'txlist',
      address: account.address, startblock: '0', endblock: '99999999',
      page: '1', offset: '50', sort: 'desc', apikey: apiKey,
    });
    const res = await fetch(`${ETHERSCAN_API}?${params}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as { status: string; result: EtherscanTx[] | string };
    if (data.status !== '1' || !Array.isArray(data.result)) return [];
    return data.result
      .filter(tx => tx.to.toLowerCase() === lido.stETH.toLowerCase() && tx.functionName.startsWith('submit'))
      .slice(0, HISTORY_LIMIT)
      .map(tx => ({
        date: new Date(Number(tx.timeStamp) * 1000),
        ethVal: Number(tx.value) / 1e18,
        ok: tx.isError !== '1',
        hash: tx.hash,
      }));
  })();

  const solPromise: Promise<JitoRow[]> = (async () => {
    if (!solAddress || network === 'testnet') return [];
    const conn = getConnection(network);
    const userPk = new PublicKey(solAddress);
    const stakePoolAddr = JITO_CONFIG.stakePool;
    const jitoSolMint = JITO_CONFIG.jitoSolMint;
    const sigs = await conn.getSignaturesForAddress(userPk, { limit: 50 });
    const rows: JitoRow[] = [];
    for (const sig of sigs) {
      if (rows.length >= HISTORY_LIMIT) break;
      try {
        const tx = await conn.getParsedTransaction(sig.signature, { maxSupportedTransactionVersion: 0 });
        if (!tx?.meta) continue;
        const accounts = tx.transaction.message.accountKeys.map(k => k.pubkey.toBase58());
        if (!accounts.includes(stakePoolAddr)) continue;
        const myIndex = accounts.indexOf(solAddress);
        if (myIndex < 0) continue;
        const solDiff = (tx.meta.postBalances[myIndex] - tx.meta.preBalances[myIndex]) / 1e9;
        const fee = myIndex === 0 ? (tx.meta.fee || 0) / 1e9 : 0;
        const solChange = Math.abs(solDiff + fee);
        let jitoChange = 0;
        const pre = tx.meta.preTokenBalances || [];
        const post = tx.meta.postTokenBalances || [];
        for (const p of post) {
          if ((p as any).owner !== solAddress || p.mint !== jitoSolMint) continue;
          const preEntry = pre.find((x: any) => x.accountIndex === p.accountIndex);
          const preAmt = preEntry ? Number(preEntry.uiTokenAmount.uiAmount || 0) : 0;
          const postAmt = Number(p.uiTokenAmount.uiAmount || 0);
          jitoChange = postAmt - preAmt;
        }
        rows.push({
          date: sig.blockTime ? new Date(sig.blockTime * 1000) : null,
          solAmt: solChange, jitoAmt: Math.abs(jitoChange),
          err: !!sig.err, sig: sig.signature,
        });
      } catch { continue; }
    }
    return rows;
  })();

  // ── Await both in parallel ──
  const [evmResult, solResult] = await Promise.allSettled([evmPromise, solPromise]);

  // ── Print EVM ──
  if (!apiKey) {
    console.log('  Ethereum: ETHERSCAN_API_KEY not set (needed for history)');
  } else if (evmResult.status === 'fulfilled' && evmResult.value.length > 0) {
    console.log('  Ethereum (Lido):');
    for (const tx of evmResult.value) {
      const dateStr = `${tx.date.getMonth() + 1}/${tx.date.getDate()} ${tx.date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false })}`.padEnd(12);
      const status = tx.ok ? 'OK  ' : 'FAIL';
      const amtCol = `${formatToken(tx.ethVal, 6).padStart(10)} ETH -> stETH`.padEnd(24);
      console.log(`    ${dateStr}${amtCol} (Lido)  ${status}  ${txLink(tx.hash, explorer.evm)}`);
    }
    console.log('');
  } else if (evmResult.status === 'rejected') {
    console.log(`  Ethereum: Failed to fetch (${evmResult.reason?.message})\n`);
  } else {
    console.log('  Ethereum: No Lido stake transactions found.\n');
  }

  // ── Print Solana ──
  if (!solAddress) {
    console.log('  Solana: no wallet configured\n');
  } else if (network === 'testnet') {
    console.log('  Solana: Jito staking is mainnet-only\n');
  } else if (solResult.status === 'fulfilled' && solResult.value.length > 0) {
    console.log('  Solana (Jito):');
    for (const r of solResult.value) {
      const dateStr = (r.date ? `${r.date.getMonth() + 1}/${r.date.getDate()} ${r.date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false })}` : '?').padEnd(12);
      const status = r.err ? 'FAIL' : 'OK  ';
      const sellCol = `${formatToken(r.solAmt, 4).padStart(8)} SOL`;
      const buyCol = `${formatToken(r.jitoAmt, 4).padStart(8)} JitoSOL`;
      console.log(`    ${dateStr}${sellCol} -> ${buyCol}  (Jito)  ${status}  ${txLink(r.sig, explorer.solana)}`);
    }
    console.log('');
  } else if (solResult.status === 'rejected') {
    console.log(`  Solana: Failed to fetch (${solResult.reason?.message})\n`);
  } else {
    console.log('  Solana: No Jito stake transactions found.\n');
  }
}

import { parseEther, parseAbi, decodeFunctionData } from 'viem';
import { PublicKey, Transaction } from '@solana/web3.js';
import { withdrawSol } from '@solana/spl-stake-pool';
import { type Network, LIDO_CONFIG, JITO_CONFIG, ETHERSCAN_API, ETHERSCAN_CHAIN_ID, EXPLORERS, HISTORY_LIMIT } from '../config.js';
import { resolveSigner } from '../signers/index.js';
import { getPublicClient, getWalletClient, getERC20Balance, getERC20Allowance, approveERC20, waitForReceipt } from '../lib/evm.js';
import { getConnection, getSplTokenBalance } from '../lib/solana.js';
import { formatToken, formatAddress, txLink, link } from '../lib/format.js';
import { confirm, warnMainnet, warnDryRun } from '../lib/prompt.js';
import { BalanceTracker, evmTokens, solTokens } from '../lib/balancedelta.js';

const SEP = '──────────────────────────────────────────';

/** Estimate remaining time for a pending Lido withdrawal */
function estimateRemaining(requestId: bigint, lastFinalizedId: bigint, requestTimestamp: bigint): string {
  const ageSec = Math.floor(Date.now() / 1000) - Number(requestTimestamp);
  const ageDays = ageSec / 86400;
  const ageLabel = ageDays < 1 ? `${Math.floor(ageSec / 3600)}h ago` : `${ageDays.toFixed(1)}d ago`;

  // Position in queue relative to last finalized
  const position = Number(requestId - lastFinalizedId);

  if (position <= 0) {
    // Should be finalized already — might be a race condition
    return `${ageLabel}, finalizing soon`;
  }

  // Lido typically finalizes in 1-5 days.
  // Requests close to the finalized frontier finish sooner.
  if (ageDays >= 4) {
    return `${ageLabel}, finalizing soon`;
  } else if (ageDays >= 2) {
    const remaining = Math.max(1, Math.ceil(5 - ageDays));
    return `${ageLabel}, ~${remaining}d remaining`;
  } else {
    return `${ageLabel}, ~1-5d total`;
  }
}

const WITHDRAWAL_QUEUE_ABI = parseAbi([
  'function requestWithdrawals(uint256[] amounts, address owner) returns (uint256[])',
  'function getWithdrawalRequests(address owner) view returns (uint256[])',
  'function getWithdrawalStatus(uint256[] requestIds) view returns ((uint256 amountOfStETH, uint256 amountOfShares, address owner, uint256 timestamp, bool isFinalized, bool isClaimed)[])',
  'function findCheckpointHints(uint256[] requestIds, uint256 firstIndex, uint256 lastIndex) view returns (uint256[])',
  'function claimWithdrawals(uint256[] requestIds, uint256[] hints)',
  'function getLastCheckpointIndex() view returns (uint256)',
  'function getLastFinalizedRequestId() view returns (uint256)',
]);

export async function unstakeCommand(
  amount: string,
  token: string,
  network: Network,
  dryRun: boolean,
) {
  const t = token.toUpperCase();

  if (t === 'STETH' || t === 'ETH') {
    if (amount.toLowerCase() === 'claim') {
      await claimLido(network, dryRun);
    } else {
      const num = Number(amount);
      if (isNaN(num) || num <= 0) {
        console.error(`  Invalid amount: "${amount}". Must be a positive number or "claim".`);
        process.exit(1);
      }
      await unstakeEth(amount, network, dryRun);
    }
  } else if (t === 'JITOSOL' || t === 'SOL') {
    const num = Number(amount);
    if (isNaN(num) || num <= 0) {
      console.error(`  Invalid amount: "${amount}". Must be a positive number.`);
      process.exit(1);
    }
    await unstakeSol(amount, network, dryRun);
  } else {
    console.error('  Supported: steth (Lido stETH → ETH), jitosol (Jito JitoSOL → SOL)');
    process.exit(1);
  }
}

// ── Lido: Request Withdrawal ──

async function unstakeEth(amount: string, network: Network, dryRun: boolean) {
  const signer = await resolveSigner();
  const account = await signer.getEvmAccount();
  const lido = LIDO_CONFIG[network];
  const value = parseEther(amount);

  if (dryRun) warnDryRun();
  console.log(`\n  Unstake: ${amount} stETH → ETH (Lido Withdrawal Queue)`);
  console.log(`  Chain: Ethereum ${network}`);
  console.log(`  Wallet: ${account.address}`);
  console.log(`  Withdrawal Queue: ${lido.withdrawalQueue}`);
  warnMainnet(network, dryRun);
  console.log('  Checking stETH balance...');

  let balance = await getERC20Balance(network, lido.stETH, account.address);
  const balanceFormatted = Number(balance) / 1e18;

  // stETH is a rebasing token — balance can be a few wei less than expected.
  // If within 1000 wei (~dust), use the actual balance to avoid precision failures.
  const dust = BigInt(1000);
  if (balance < value && value - balance <= dust) {
    balance = value; // close enough, use requested amount
  }

  let insufficientBalance = false;
  if (balance < value) {
    console.log(`  ⚠ Insufficient stETH (have: ${formatToken(balanceFormatted, 6)}, need: ${amount})`);
    insufficientBalance = true;
  }

  console.log(`  stETH balance: ${formatToken(balanceFormatted, 6)}`);
  console.log(`\n  You request: ${amount} stETH withdrawal`);
  console.log('  Wait time:   ~1-5 days (Lido queue)\n');

  const tracker = new BalanceTracker(evmTokens(network, account.address, ['stETH', 'ETH']));

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

  // Check and approve stETH to withdrawal queue
  // stETH is rebasing — its transferSharesFrom does a shares round-trip that can
  // consume slightly more allowance than the token amount. Use max approval (like Jumper)
  // to avoid ALLOWANCE_EXCEEDED errors from rounding.
  const client = getPublicClient(network);
  const MAX_UINT256 = 2n ** 256n - 1n;
  const allowance = await getERC20Allowance(network, lido.stETH, account.address, lido.withdrawalQueue);
  if (allowance < value) {
    console.log(`\n  Approval needed: stETH to Withdrawal Queue (unlimited)`);
    if (!await confirm('Approve stETH?')) {
      console.log('  Cancelled.\n');
      return;
    }
    await approveERC20(network, lido.stETH, lido.withdrawalQueue, MAX_UINT256);
  }

  console.log('  Requesting withdrawal...');
  const { trackTx, clearTx } = await import('../lib/txtracker.js');
  const explorer = EXPLORERS[network];
  const wallet = await getWalletClient(network);
  try {
    const hash = await wallet.writeContract({
      account,
      address: lido.withdrawalQueue,
      abi: WITHDRAWAL_QUEUE_ABI,
      functionName: 'requestWithdrawals',
      args: [[value], account.address],
    });

    trackTx(hash, 'evm', network);
    console.log(`  TX:  ${hash}`);
    console.log(`  URL: ${explorer.evm}/tx/${hash}`);
    console.log('  Waiting for confirmation...');
    await waitForReceipt(network, hash);
    clearTx();
    await tracker.snapshotAndPrint('Withdrawal Request');
    console.log('  ETH available after withdrawal finalization (~1-5 days).');
  } catch (err: any) {
    clearTx();
    const msg = err.shortMessage || err.message || String(err);
    console.error(`  Withdrawal request failed: ${msg}`);
    console.log('  This can happen due to stETH rebasing precision or testnet contract state.');
    await tracker.snapshotAndPrint('Withdrawal Request');
    console.log('');
    return;
  }
  console.log('  Check status with: wallet balance');
  console.log('  Claim when ready:  wallet unstake claim eth\n');
}

// ── Lido: Claim Finalized Withdrawals ──

async function claimLido(network: Network, dryRun: boolean) {
  const signer = await resolveSigner();
  const account = await signer.getEvmAccount();
  const lido = LIDO_CONFIG[network];
  const client = getPublicClient(network);

  if (dryRun) warnDryRun();
  console.log('\n  Checking Lido withdrawal requests...');

  // Get all requests for this owner
  const requestIds = await client.readContract({
    address: lido.withdrawalQueue,
    abi: WITHDRAWAL_QUEUE_ABI,
    functionName: 'getWithdrawalRequests',
    args: [account.address],
  }) as bigint[];

  if (requestIds.length === 0) {
    console.log('  No pending withdrawal requests.\n');
    return;
  }

  // Get status of all requests
  const statuses = await client.readContract({
    address: lido.withdrawalQueue,
    abi: WITHDRAWAL_QUEUE_ABI,
    functionName: 'getWithdrawalStatus',
    args: [requestIds],
  }) as readonly { amountOfStETH: bigint; timestamp: bigint; isFinalized: boolean; isClaimed: boolean }[];

  const claimable: bigint[] = [];
  let totalClaimable = 0n;

  for (let i = 0; i < requestIds.length; i++) {
    const s = statuses[i];
    if (s.isFinalized && !s.isClaimed) {
      claimable.push(requestIds[i]);
      totalClaimable += s.amountOfStETH;
    }
  }

  // Show all requests
  const pending = statuses.filter(s => !s.isFinalized && !s.isClaimed);
  console.log(`  Total requests: ${requestIds.length}`);
  console.log(`  Claimable:      ${claimable.length} (~${formatToken(Number(totalClaimable) / 1e18, 6)} ETH)`);
  console.log(`  Pending:        ${pending.length}\n`);

  if (claimable.length === 0) {
    console.log('  Nothing to claim yet. Check back later.\n');
    return;
  }

  const tracker = new BalanceTracker(evmTokens(network, account.address, ['ETH', 'stETH']));

  if (dryRun) {
    console.log(`  [DRY RUN] Would claim ${claimable.length} request(s).\n`);
    return;
  }

  await tracker.snapshot();
  tracker.printBefore();

  if (!await confirm(`Proceed?`)) {
    console.log('  Cancelled.\n');
    return;
  }

  // Get hints for claiming
  console.log('  Getting checkpoint hints...');
  const lastIndex = await client.readContract({
    address: lido.withdrawalQueue,
    abi: WITHDRAWAL_QUEUE_ABI,
    functionName: 'getLastCheckpointIndex',
  }) as bigint;

  const hints = await client.readContract({
    address: lido.withdrawalQueue,
    abi: WITHDRAWAL_QUEUE_ABI,
    functionName: 'findCheckpointHints',
    args: [claimable, 1n, lastIndex],
  }) as bigint[];

  console.log('  Claiming withdrawals...');
  const { trackTx, clearTx } = await import('../lib/txtracker.js');
  const explorer = EXPLORERS[network];
  const wallet = await getWalletClient(network);
  try {
    const hash = await wallet.writeContract({
      account,
      address: lido.withdrawalQueue,
      abi: WITHDRAWAL_QUEUE_ABI,
      functionName: 'claimWithdrawals',
      args: [claimable, hints],
    });

    trackTx(hash, 'evm', network);
    console.log(`  TX:  ${hash}`);
    console.log(`  URL: ${explorer.evm}/tx/${hash}`);
    console.log('  Waiting for confirmation...');
    await waitForReceipt(network, hash);
    clearTx();
  } catch (err: any) {
    clearTx();
    console.error(`  Claim failed: ${err.message}`);
  }
  await tracker.snapshotAndPrint('Claim');
  console.log('');
}

// ── Jito: JitoSOL → SOL ──

async function unstakeSol(amount: string, network: Network, dryRun: boolean) {
  if (network === 'testnet') {
    console.error('  Jito unstaking is mainnet-only.');
    process.exit(1);
  }

  const signer = await resolveSigner();
  const walletAddr = await signer.getSolanaAddress();
  if (!walletAddr) { console.error('  No Solana address configured.'); process.exit(1); }
  const amountNum = Number(amount);

  if (dryRun) warnDryRun();
  console.log(`\n  Unstake: ${amount} JitoSOL → SOL (Jito)`);
  console.log(`  Chain: Solana ${network}`);
  console.log(`  Wallet: ${walletAddr}`);
  console.log(`  Stake pool: ${JITO_CONFIG.stakePool}`);
  warnMainnet(network, dryRun);
  console.log('  Checking JitoSOL balance...');

  const jitoBal = await getSplTokenBalance(network, walletAddr, JITO_CONFIG.jitoSolMint);
  console.log(`  JitoSOL balance: ${formatToken(jitoBal, 6)}`);

  let insufficientBalance = false;
  if (jitoBal < amountNum) {
    console.log(`  ⚠ Insufficient JitoSOL (have: ${formatToken(jitoBal, 6)}, need: ${amount})`);
    insufficientBalance = true;
  }

  console.log(`\n  You unstake: ${amount} JitoSOL`);
  console.log('  You receive: ~SOL (rate varies, instant from pool reserve)\n');

  const tracker = new BalanceTracker(solTokens(network, walletAddr, ['JitoSOL', 'SOL']));

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
  const { instructions, signers: ephemeralSigners } = await withdrawSol(
    conn,
    stakePoolAddress,
    userPubkey,
    userPubkey,
    amountNum,
  );

  const tx = new Transaction();
  for (const ix of instructions) {
    tx.add(ix);
  }

  // Partial-sign with ephemeral signers before user signs
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
    console.error(`  Unstake failed: ${err.message}`);
  }
  await tracker.snapshotAndPrint('Unstake');
  console.log('');
}

// ── Unstake History ──

interface EtherscanTx {
  hash: string;
  from: string;
  to: string;
  value: string;
  timeStamp: string;
  isError: string;
  functionName: string;
  input: string;
}

export async function unstakeHistoryCommand(network: Network) {
  const explorer = EXPLORERS[network];

  console.log(`\n  ── Recent Unstakes ${SEP}\n`);
  console.log('  Fetching history...');

  // ── Build parallel fetch promises ──
  const apiKey = process.env.ETHERSCAN_API_KEY;
  const signer = await resolveSigner();
  const solAddress = await signer.getSolanaAddress();

  type EvmRow = { date: Date; label: string; ok: boolean; hash: string; amount?: number; unit?: string };
  interface Withdrawal { id: bigint; amt: number; dateStr: string; isFinalized: boolean; estimate?: string }
  interface JitoRow { date: Date | null; jitoAmt: number; solAmt: number; err: boolean; sig: string }

  // EVM: Etherscan tx history + internal txs (for claim ETH amounts)
  const evmPromise: Promise<EvmRow[]> = (async () => {
    if (!apiKey) return [];
    const account = await signer.getEvmAccount();
    const lido = LIDO_CONFIG[network];
    const baseParams = {
      chainid: ETHERSCAN_CHAIN_ID[network],
      module: 'account',
      address: account.address, startblock: '0', endblock: '99999999',
      page: '1', offset: '50', sort: 'desc', apikey: apiKey,
    };

    // Fetch txlist + internal txs in parallel
    const [txRes, internalRes] = await Promise.all([
      fetch(`${ETHERSCAN_API}?${new URLSearchParams({ ...baseParams, action: 'txlist' })}`),
      fetch(`${ETHERSCAN_API}?${new URLSearchParams({ ...baseParams, action: 'txlistinternal' })}`),
    ]);
    if (!txRes.ok) throw new Error(`HTTP ${txRes.status}`);
    const txData = (await txRes.json()) as { status: string; result: EtherscanTx[] | string };

    // Build map of internal ETH received per tx hash (for claims)
    const internalEth = new Map<string, number>();
    if (internalRes.ok) {
      const intData = (await internalRes.json()) as { status: string; result: Array<{ hash: string; to: string; value: string }> | string };
      if (intData.status === '1' && Array.isArray(intData.result)) {
        for (const itx of intData.result) {
          if (itx.to.toLowerCase() !== account.address.toLowerCase()) continue;
          const prev = internalEth.get(itx.hash) ?? 0;
          internalEth.set(itx.hash, prev + Number(itx.value) / 1e18);
        }
      }
    }

    if (txData.status !== '1' || !Array.isArray(txData.result)) return [];
    return txData.result
      .filter(tx => tx.to.toLowerCase() === lido.withdrawalQueue.toLowerCase())
      .slice(0, HISTORY_LIMIT)
      .map(tx => {
        const fn = tx.functionName.split('(')[0];
        const label = fn === 'requestWithdrawals' ? 'request' :
                      fn === 'claimWithdrawals' ? 'claim' : fn;
        let amount: number | undefined;
        let unit: string | undefined;

        if (fn === 'requestWithdrawals' && tx.input && tx.input.length > 10) {
          try {
            const decoded = decodeFunctionData({ abi: WITHDRAWAL_QUEUE_ABI, data: tx.input as `0x${string}` });
            const amounts = decoded.args[0] as bigint[];
            amount = amounts.reduce((sum, a) => sum + Number(a), 0) / 1e18;
            unit = 'stETH';
          } catch { /* ignore decode errors */ }
        } else if (fn === 'claimWithdrawals') {
          const ethAmt = internalEth.get(tx.hash);
          if (ethAmt) { amount = ethAmt; unit = 'ETH'; }
        }

        return {
          date: new Date(Number(tx.timeStamp) * 1000),
          label, ok: tx.isError !== '1', hash: tx.hash, amount, unit,
        };
      });
  })();

  // EVM: Pending Lido withdrawals
  const pendingPromise: Promise<{ withdrawals: Withdrawal[]; claimable: number } | null> = (async () => {
    if (!apiKey) return null;
    const account = await signer.getEvmAccount();
    const lido = LIDO_CONFIG[network];
    const client = getPublicClient(network);
    const [requestIds, lastFinalizedId] = await Promise.all([
      client.readContract({
        address: lido.withdrawalQueue, abi: WITHDRAWAL_QUEUE_ABI,
        functionName: 'getWithdrawalRequests', args: [account.address],
      }) as Promise<bigint[]>,
      client.readContract({
        address: lido.withdrawalQueue, abi: WITHDRAWAL_QUEUE_ABI,
        functionName: 'getLastFinalizedRequestId',
      }) as Promise<bigint>,
    ]);
    if (requestIds.length === 0) return { withdrawals: [], claimable: 0 };
    const statuses = await client.readContract({
      address: lido.withdrawalQueue, abi: WITHDRAWAL_QUEUE_ABI,
      functionName: 'getWithdrawalStatus', args: [requestIds],
    }) as readonly { amountOfStETH: bigint; timestamp: bigint; isFinalized: boolean; isClaimed: boolean }[];
    const withdrawals: Withdrawal[] = [];
    let claimable = 0;
    for (let i = 0; i < requestIds.length; i++) {
      const s = statuses[i];
      if (s.isClaimed) continue;
      const date = new Date(Number(s.timestamp) * 1000);
      const w: Withdrawal = {
        id: requestIds[i],
        amt: Number(s.amountOfStETH) / 1e18,
        dateStr: `${date.getMonth() + 1}/${date.getDate()}`,
        isFinalized: s.isFinalized,
      };
      if (!s.isFinalized) w.estimate = estimateRemaining(requestIds[i], lastFinalizedId, s.timestamp);
      if (s.isFinalized) claimable++;
      withdrawals.push(w);
    }
    return { withdrawals, claimable };
  })();

  // Solana: Jito unstakes
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
        let jitoChange = 0;
        const pre = tx.meta.preTokenBalances || [];
        const post = tx.meta.postTokenBalances || [];
        for (const p of post) {
          if ((p as any).owner !== solAddress || p.mint !== jitoSolMint) continue;
          const preEntry = pre.find((x: any) => x.accountIndex === p.accountIndex);
          const preAmt = preEntry ? Number(preEntry.uiTokenAmount.uiAmount || 0) : 0;
          const postAmt = Number(p.uiTokenAmount.uiAmount || 0);
          jitoChange = preAmt - postAmt;
        }
        rows.push({
          date: sig.blockTime ? new Date(sig.blockTime * 1000) : null,
          jitoAmt: Math.abs(jitoChange), solAmt: Math.abs(solDiff + fee),
          err: !!sig.err, sig: sig.signature,
        });
      } catch { continue; }
    }
    return rows;
  })();

  // ── Await all in parallel ──
  const [evmResult, pendingResult, solResult] = await Promise.allSettled([evmPromise, pendingPromise, solPromise]);

  // ── Print EVM history ──
  if (!apiKey) {
    console.log('  Ethereum: ETHERSCAN_API_KEY not set (needed for history)');
  } else if (evmResult.status === 'fulfilled' && evmResult.value.length > 0) {
    console.log('  Ethereum (Lido):');
    for (const tx of evmResult.value) {
      const dateStr = `${tx.date.getMonth() + 1}/${tx.date.getDate()} ${tx.date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false })}`.padEnd(12);
      const amtStr = tx.amount ? `${formatToken(tx.amount, 6).padStart(10)} ${tx.unit}` : '';
      const desc = `${tx.label}${amtStr ? ` ${amtStr}` : ''}`.padEnd(28);
      const status = tx.ok ? 'OK  ' : 'FAIL';
      console.log(`    ${dateStr}${desc} (Lido)  ${status}  ${txLink(tx.hash, explorer.evm)}`);
    }
    console.log('');
  } else if (evmResult.status === 'rejected') {
    console.log(`  Ethereum: Failed to fetch (${evmResult.reason?.message})\n`);
  } else {
    console.log('  Ethereum: No Lido unstake transactions found.\n');
  }

  // ── Print pending withdrawals ──
  if (apiKey) {
    console.log(`  ── Pending Lido Withdrawals ${SEP}\n`);
    if (pendingResult.status === 'fulfilled' && pendingResult.value) {
      const { withdrawals, claimable } = pendingResult.value;
      if (withdrawals.length === 0) {
        console.log('    No pending withdrawal requests.\n');
      } else {
        for (const w of withdrawals) {
          const reqLink = link('https://stake.lido.fi/withdrawals/claim', `#${w.id}`);
          const amt = formatToken(w.amt, 6);
          if (w.isFinalized) {
            console.log(`    Request ${reqLink}:  ${amt} stETH  requested ${w.dateStr}  Ready to claim`);
          } else {
            console.log(`    Request ${reqLink}:  ${amt} stETH  requested ${w.dateStr}  Pending (${w.estimate})`);
          }
        }
        if (claimable > 0) {
          console.log(`\n    ${claimable} ready to claim. Run: wallet unstake claim eth --run`);
        }
        console.log('');
      }
    } else if (pendingResult.status === 'rejected') {
      console.log(`    Failed to fetch withdrawal status (${pendingResult.reason?.message})\n`);
    }
  }

  // ── Print Solana ──
  if (!solAddress) {
    console.log('  Solana: SOLANA_ADDRESS not configured\n');
  } else if (network === 'testnet') {
    console.log('  Solana: Jito unstaking is mainnet-only\n');
  } else if (solResult.status === 'fulfilled' && solResult.value.length > 0) {
    console.log('  Solana (Jito):');
    for (const r of solResult.value) {
      const dateStr = (r.date ? `${r.date.getMonth() + 1}/${r.date.getDate()} ${r.date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false })}` : '?').padEnd(12);
      const status = r.err ? 'FAIL' : 'OK  ';
      const sellCol = r.jitoAmt > 0 ? `${formatToken(r.jitoAmt, 4).padStart(8)} JitoSOL` : '         JitoSOL';
      const buyCol = r.jitoAmt > 0 ? `${formatToken(r.solAmt, 4).padStart(8)} SOL` : '          SOL';
      console.log(`    ${dateStr}${sellCol} -> ${buyCol} ${status}  ${txLink(r.sig, explorer.solana)}`);
    }
    console.log('');
  } else if (solResult.status === 'rejected') {
    console.log(`  Solana: Failed to fetch (${solResult.reason?.message})\n`);
  } else {
    console.log('  Solana: No Jito unstake transactions found.\n');
  }
}

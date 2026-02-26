import { parseAbi } from 'viem';
import { PublicKey } from '@solana/web3.js';
import { getStakePoolAccount } from '@solana/spl-stake-pool';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import { type Network, TOKENS, SOLANA_CONFIG, LIDO_CONFIG, JITO_CONFIG, WSOL_CONFIG, EXPLORERS, STAKING_URLS, ETHERSCAN_API, ETHERSCAN_CHAIN_ID, getEvmAccount, getSolanaAddress } from '../config.js';
import { getPublicClient, getERC20Balance } from '../lib/evm.js';
import { getConnection, getSolBalance, getSplTokenBalance, getWsolBalance } from '../lib/solana.js';
import { formatToken, formatAddress, formatUSD, link } from '../lib/format.js';
import { listAddresses } from '../lib/addressbook.js';
import { fetchLidoApr, fetchJitoApy } from '../lib/staking.js';
import { fetchPrices as fetchMarketPrices } from '../lib/prices.js';

const STETH_ABI = parseAbi([
  'function getPooledEthByShares(uint256 sharesAmount) view returns (uint256)',
]);

const WITHDRAWAL_QUEUE_ABI = parseAbi([
  'function getWithdrawalRequests(address owner) view returns (uint256[])',
  'function getWithdrawalStatus(uint256[] requestIds) view returns ((uint256 amountOfStETH, uint256 amountOfShares, address owner, uint256 timestamp, bool isFinalized, bool isClaimed)[])',
  'function getLastFinalizedRequestId() view returns (uint256)',
]);

const SEP = '──────────────────────────────────────────';

function isEvmAddress(s: string): boolean {
  return s.startsWith('0x') && s.length === 42;
}

function isSolanaAddress(s: string): boolean {
  return !s.startsWith('0x') && s.length >= 32 && s.length <= 44 && /^[1-9A-HJ-NP-Za-km-z]+$/.test(s);
}

// ── Staking data helpers ──

async function fetchPrices(): Promise<{ eth: number; sol: number } | null> {
  try {
    const p = await fetchMarketPrices(['eth', 'sol']);
    return { eth: p.eth ?? 0, sol: p.sol ?? 0 };
  } catch { return null; }
}

async function fetchStEthDeposits(network: Network, address: string): Promise<number | null> {
  const apiKey = process.env.ETHERSCAN_API_KEY;
  if (!apiKey) return null;

  const lido = LIDO_CONFIG[network];
  const params = new URLSearchParams({
    chainid: ETHERSCAN_CHAIN_ID[network],
    module: 'account',
    action: 'txlist',
    address,
    startblock: '0',
    endblock: '99999999',
    page: '1',
    offset: '50',
    sort: 'desc',
    apikey: apiKey,
  });

  try {
    const res = await fetch(`${ETHERSCAN_API}?${params}`);
    if (!res.ok) return null;
    const data = (await res.json()) as { status: string; result: Array<{ to: string; value: string; isError: string; functionName: string }> };
    if (data.status !== '1' || !Array.isArray(data.result)) return null;

    const stakeTxs = data.result.filter(tx =>
      tx.to?.toLowerCase() === lido.stETH.toLowerCase() &&
      tx.functionName?.startsWith('submit') &&
      tx.isError !== '1'
    );

    if (stakeTxs.length === 0) return null;
    return stakeTxs.reduce((sum, tx) => sum + Number(tx.value) / 1e18, 0);
  } catch { return null; }
}

async function fetchJitoDeposits(network: Network, address: string): Promise<number | null> {
  if (network !== 'mainnet') return null;
  try {
    const conn = getConnection(network);
    const userPk = new PublicKey(address);
    const jitoMint = new PublicKey(JITO_CONFIG.jitoSolMint);
    const stakePool = JITO_CONFIG.stakePool;

    // Query user's JitoSOL ATA — not the stake pool (per CLAUDE.md Solana RPC constraints)
    const ata = getAssociatedTokenAddressSync(jitoMint, userPk);
    const sigs = await conn.getSignaturesForAddress(ata, { limit: 10 });
    if (sigs.length === 0) return null;

    // Fetch all transactions in parallel for speed
    const txs = await Promise.all(
      sigs.map(sig =>
        conn.getParsedTransaction(sig.signature, { maxSupportedTransactionVersion: 0 }).catch(() => null)
      )
    );

    let totalSolDeposited = 0;
    let found = false;

    for (const tx of txs) {
      if (!tx?.meta) continue;
      const accounts = tx.transaction.message.accountKeys.map(k =>
        typeof k === 'string' ? k : k.pubkey.toBase58()
      );

      if (!accounts.includes(stakePool)) continue;

      // User's SOL balance decrease = deposit amount (minus small tx fee)
      const userIdx = accounts.findIndex(a => a === address);
      if (userIdx < 0) continue;

      const pre = tx.meta.preBalances[userIdx];
      const post = tx.meta.postBalances[userIdx];
      const diff = (pre - post) / 1e9;

      if (diff > 0.01) { // Significant deposit (> 0.01 SOL, excludes fee-only txs)
        totalSolDeposited += diff;
        found = true;
      }
    }

    return found ? totalSolDeposited : null;
  } catch { return null; }
}

/** Show balance for an external EVM address (simplified — no staking/withdrawals) */
async function externalEvmBalance(network: Network, address: string, label?: string) {
  const explorer = EXPLORERS[network];
  const tokens = TOKENS[network];
  const client = getPublicClient(network);
  const evmAddr = address as `0x${string}`;

  const displayLabel = label ? `"${label}" (${formatAddress(address, 6)})` : formatAddress(address, 6);
  console.log(`\n  Balance for ${displayLabel}`);
  console.log(`  Network: ${network}`);
  console.log(`\n  ── Ethereum ${SEP}`);
  console.log('  Fetching...');

  try {
    const [ethBalance, usdcBalance, wsolEthBalance] = await Promise.all([
      client.getBalance({ address: evmAddr }),
      getERC20Balance(network, tokens.USDC, evmAddr),
      getERC20Balance(network, tokens.WSOL, evmAddr).catch(() => BigInt(0)),
    ]);

    const ethAmount = Number(ethBalance) / 1e18;
    const usdcAmount = Number(usdcBalance) / 10 ** tokens.USDC_DECIMALS;
    const wsolEthAmount = Number(wsolEthBalance) / 10 ** tokens.WSOL_DECIMALS;

    console.log(`    ETH:      ${formatToken(ethAmount, 6)}`);
    console.log(`    USDC:     ${formatToken(usdcAmount, 2)}`);
    if (wsolEthAmount > 0) {
      console.log(`    WSOL-ETH: ${formatToken(wsolEthAmount, 6)}`);
    }
    console.log(`  Explorer: ${explorer.evm}/address/${address}`);
  } catch (err: any) {
    console.log(`  Failed to fetch (${err.shortMessage || err.message})`);
  }
  console.log('');
}

/** Show balance for an external Solana address (simplified) */
async function externalSolanaBalance(network: Network, address: string, label?: string) {
  const explorer = EXPLORERS[network];
  const solConfig = SOLANA_CONFIG[network];

  const displayLabel = label ? `"${label}" (${formatAddress(address, 6)})` : formatAddress(address, 6);
  console.log(`\n  Balance for ${displayLabel}`);
  console.log(`  Network: ${network}`);
  console.log(`\n  ── Solana ${SEP}`);
  console.log('  Fetching...');

  try {
    const [solBal, usdcBal] = await Promise.all([
      getSolBalance(network, address),
      getSplTokenBalance(network, address, solConfig.usdcMint),
    ]);

    console.log(`    SOL:    ${formatToken(solBal, 6)}`);
    console.log(`    USDC:   ${formatToken(usdcBal, 2)}`);
    const clusterParam = network === 'testnet' ? '?cluster=devnet' : '';
    const solAccountPath = network === 'testnet' ? '/address' : '/account';
    console.log(`  Explorer: ${explorer.solana}${solAccountPath}/${address}${clusterParam}`);
  } catch (err: any) {
    console.log(`  Failed to fetch (${err.message})`);
  }
  console.log('');
}

export async function balanceCommand(network: Network, target?: string, full = false) {
  // If a target is provided, show external wallet balance
  if (target) {
    if (isEvmAddress(target)) {
      return externalEvmBalance(network, target);
    }
    if (isSolanaAddress(target)) {
      return externalSolanaBalance(network, target);
    }
    // Look up in address book
    const entries = listAddresses();
    const entry = entries.find(e => e.name.toLowerCase() === target.toLowerCase());
    if (!entry) {
      console.log(`\n  "${target}" not found in address book and doesn't look like a valid address.`);
      console.log(`  Use 'wallet address add' to save addresses, or pass a 0x... (EVM) or base58 (Solana) address.\n`);
      return;
    }
    if (entry.evm) await externalEvmBalance(network, entry.evm, entry.name);
    if (entry.solana) await externalSolanaBalance(network, entry.solana, entry.name);
    if (!entry.evm && !entry.solana) {
      console.log(`\n  "${entry.name}" has no addresses registered.\n`);
    }
    return;
  }

  // Full dashboard for own wallet
  const account = getEvmAccount();
  const evmAddress = account.address;
  const solAddress = getSolanaAddress();
  const explorer = EXPLORERS[network];
  const tokens = TOKENS[network];
  const lido = LIDO_CONFIG[network];
  const client = getPublicClient(network);

  console.log(`\n  Network: ${network}`);
  console.log('  Fetching...');

  let stEthAmount = 0;
  let jitoSolBalance = 0;
  let jitoSolRate = 1; // JitoSOL → SOL exchange rate
  let stEthRate = 1;   // stETH → ETH share rate

  // Buffer balance output for reordered display (staking/withdrawals shown first)
  const evmLines: string[] = [];
  const solLines: string[] = [];

  // Fetch prices early (in parallel with balance fetches below)
  const pricesPromise = network === 'mainnet' ? fetchPrices() : Promise.resolve(null);

  // ── Fetch Ethereum data (buffered) ──
  evmLines.push(`\n  ── Ethereum ${SEP}`);
  evmLines.push(`    Wallet:   ${link(`${explorer.evm}/address/${evmAddress}`, evmAddress)}`);

  let evmTotalUsd = 0;
  let withdrawalData: { unclaimed: { id: bigint; amountOfStETH: bigint; timestamp: bigint; isFinalized: boolean }[]; lastFinalizedId: bigint } | null = null;

  try {
    const [ethBalance, usdcBalance, wethBalance, stEthBalance, wsolEthBalance, stEthRateRaw, withdrawalRequestIds] = await Promise.all([
      client.getBalance({ address: evmAddress }),
      getERC20Balance(network, tokens.USDC, evmAddress),
      getERC20Balance(network, tokens.WETH, evmAddress).catch(() => BigInt(0)),
      getERC20Balance(network, lido.stETH, evmAddress),
      getERC20Balance(network, tokens.WSOL, evmAddress).catch(() => BigInt(0)),
      client.readContract({
        address: lido.stETH,
        abi: STETH_ABI,
        functionName: 'getPooledEthByShares',
        args: [BigInt(1e18)],
      }).catch(() => BigInt(1e18)),
      client.readContract({
        address: lido.withdrawalQueue,
        abi: WITHDRAWAL_QUEUE_ABI,
        functionName: 'getWithdrawalRequests',
        args: [evmAddress],
      }).catch(() => [] as bigint[]) as Promise<bigint[]>,
    ]);

    // Fetch withdrawal statuses + last finalized ID (for time estimates)
    if (withdrawalRequestIds.length > 0) {
      try {
        const [statuses, lastFinalizedId] = await Promise.all([
          client.readContract({
            address: lido.withdrawalQueue,
            abi: WITHDRAWAL_QUEUE_ABI,
            functionName: 'getWithdrawalStatus',
            args: [withdrawalRequestIds],
          }) as Promise<readonly { amountOfStETH: bigint; amountOfShares: bigint; owner: string; timestamp: bigint; isFinalized: boolean; isClaimed: boolean }[]>,
          client.readContract({
            address: lido.withdrawalQueue,
            abi: WITHDRAWAL_QUEUE_ABI,
            functionName: 'getLastFinalizedRequestId',
          }) as Promise<bigint>,
        ]);
        const unclaimed = statuses
          .map((s, i) => ({ id: withdrawalRequestIds[i], amountOfStETH: s.amountOfStETH, timestamp: s.timestamp, isFinalized: s.isFinalized, isClaimed: s.isClaimed }))
          .filter(s => !s.isClaimed);
        if (unclaimed.length > 0) {
          withdrawalData = { unclaimed, lastFinalizedId };
        }
      } catch { /* skip */ }
    }

    const prices = await pricesPromise;
    const ethPrice = prices?.eth ?? 0;
    const solPrice = prices?.sol ?? 0;

    const ethAmount = Number(ethBalance) / 1e18;
    const usdcAmount = Number(usdcBalance) / 10 ** tokens.USDC_DECIMALS;
    const wethAmount = Number(wethBalance) / 10 ** tokens.WETH_DECIMALS;
    stEthAmount = Number(stEthBalance) / 1e18;
    stEthRate = Number(stEthRateRaw) / 1e18;
    const wsolEthAmount = Number(wsolEthBalance) / 10 ** tokens.WSOL_DECIMALS;

    const ethUsd = ethAmount * ethPrice;
    const wethUsd = wethAmount * ethPrice;
    const stEthInEth = stEthAmount * stEthRate;
    const stEthUsd = stEthInEth * ethPrice;
    const wsolEthUsd = wsolEthAmount * solPrice;

    const usdSuffix = (v: number) => ethPrice > 0 ? `  (${formatUSD(v)})` : '';

    evmLines.push(`    ETH:      ${formatToken(ethAmount, 6)}${usdSuffix(ethUsd)}`);
    if (wethAmount > 0) {
      evmLines.push(`    WETH:     ${formatToken(wethAmount, 6)}${usdSuffix(wethUsd)}`);
    }
    evmLines.push(`    USDC:     ${formatToken(usdcAmount, 2)}`);
    if (wsolEthAmount > 0) {
      evmLines.push(`    WSOL-ETH: ${formatToken(wsolEthAmount, 6)}${solPrice > 0 ? `  (${formatUSD(wsolEthUsd)})` : ''}`);
    }
    const stEthLabel = link(STAKING_URLS.lido, 'stETH');
    if (stEthAmount > 0) {
      evmLines.push(`    ${stEthLabel}:    ${formatToken(stEthAmount, 6)} (≈ ${formatToken(stEthInEth, 6)} ETH)${usdSuffix(stEthUsd)}`);
    } else {
      evmLines.push(`    ${stEthLabel}:    ${formatToken(stEthAmount, 6)}`);
    }

    // Pending Lido withdrawals — show as balance line + include in total
    let pendingUsd = 0;
    if (withdrawalData) {
      const pendingSteth = withdrawalData.unclaimed.reduce((sum, r) => sum + Number(r.amountOfStETH), 0) / 1e18;
      const claimableSteth = withdrawalData.unclaimed.filter(r => r.isFinalized).reduce((sum, r) => sum + Number(r.amountOfStETH), 0) / 1e18;
      const pendingInEth = pendingSteth * stEthRate;
      pendingUsd = pendingInEth * ethPrice;
      const claimCount = withdrawalData.unclaimed.filter(r => r.isFinalized).length;
      const pendingCount = withdrawalData.unclaimed.filter(r => !r.isFinalized).length;
      const parts: string[] = [];
      if (claimCount > 0) parts.push(`${claimCount} claimable`);
      if (pendingCount > 0) parts.push(`${pendingCount} pending`);
      evmLines.push(`    Pending:  ${formatToken(pendingSteth, 6)} stETH (${parts.join(', ')})${usdSuffix(pendingUsd)}`);
    }

    evmTotalUsd = ethUsd + wethUsd + usdcAmount + wsolEthUsd + stEthUsd + pendingUsd;
    if (ethPrice > 0) {
      evmLines.push(`    Total:    ${formatUSD(evmTotalUsd)}`);
    }
  } catch (err: any) {
    evmLines.push(`  Failed to fetch (${err.shortMessage || err.message})`);
  }

  // ── Fetch Solana data (buffered) ──
  solLines.push(`\n  ── Solana ${SEP}`);

  let solTotalUsd = 0;

  if (!solAddress) {
    solLines.push('    No SOLANA_ADDRESS configured in .env');
  } else {
    const clusterParam = network === 'testnet' ? '?cluster=devnet' : '';
    const solAccountPath = network === 'testnet' ? '/address' : '/account';
    const solExplorerUrl = `${explorer.solana}${solAccountPath}/${solAddress}${clusterParam}`;
    solLines.push(`    Wallet:   ${link(solExplorerUrl, solAddress!)}`);

    try {
      const solConfig = SOLANA_CONFIG[network];
      const conn = getConnection(network);
      const [solBal, solUsdcBal, wsolBal, jitoBal, jitoPool] = await Promise.all([
        getSolBalance(network, solAddress),
        getSplTokenBalance(network, solAddress, solConfig.usdcMint),
        getWsolBalance(network, solAddress),
        network === 'mainnet'
          ? getSplTokenBalance(network, solAddress, JITO_CONFIG.jitoSolMint)
          : Promise.resolve(0),
        network === 'mainnet'
          ? getStakePoolAccount(conn, new PublicKey(JITO_CONFIG.stakePool)).catch(() => null)
          : Promise.resolve(null),
      ]);

      const prices = await pricesPromise;
      const solPrice = prices?.sol ?? 0;

      jitoSolBalance = jitoBal;
      if (jitoPool) {
        const pool = jitoPool.account.data;
        jitoSolRate = Number(pool.totalLamports) / Number(pool.poolTokenSupply);
      }

      const solUsd = solBal * solPrice;
      const wsolUsd = wsolBal * solPrice;
      const jitoInSol = jitoSolBalance * jitoSolRate;
      const jitoUsd = jitoInSol * solPrice;
      const usdSuffix = (v: number) => solPrice > 0 ? `  (${formatUSD(v)})` : '';

      solLines.push(`    SOL:      ${formatToken(solBal, 6)}${usdSuffix(solUsd)}`);
      if (wsolBal > 0) {
        solLines.push(`    WSOL:     ${formatToken(wsolBal, 6)}${usdSuffix(wsolUsd)}`);
      }
      solLines.push(`    USDC:     ${formatToken(solUsdcBal, 2)}`);
      if (network === 'mainnet') {
        const jitoLabel = link(STAKING_URLS.jito, 'JitoSOL');
        if (jitoSolBalance > 0) {
          solLines.push(`    ${jitoLabel}:  ${formatToken(jitoSolBalance, 6)} (≈ ${formatToken(jitoInSol, 6)} SOL)${usdSuffix(jitoUsd)}`);
        } else {
          solLines.push(`    ${jitoLabel}:  ${formatToken(jitoSolBalance, 6)}`);
        }
      }

      solTotalUsd = solUsd + wsolUsd + solUsdcBal + jitoUsd;
      if (solPrice > 0) {
        solLines.push(`    Total:    ${formatUSD(solTotalUsd)}`);
      }
    } catch (err: any) {
      solLines.push(`    Failed to fetch (${err.message})`);
    }
  }

  // ── Display: Staking (shown first, only in full mode) ──
  const hasStaking = stEthAmount > 0 || (network === 'mainnet' && jitoSolBalance > 0);
  if (full && hasStaking) {
    console.log(`\n  ── Staking ${SEP}`);

    const [lidoAprResult, jitoApyResult, depositsResult, jitoDepositsResult] = await Promise.allSettled([
      stEthAmount > 0 ? fetchLidoApr() : Promise.resolve(null),
      (network === 'mainnet' && jitoSolBalance > 0) ? fetchJitoApy() : Promise.resolve(null),
      stEthAmount > 0 ? fetchStEthDeposits(network, evmAddress) : Promise.resolve(null),
      (network === 'mainnet' && jitoSolBalance > 0 && solAddress) ? fetchJitoDeposits(network, solAddress) : Promise.resolve(null),
    ]);

    const lidoApr = lidoAprResult.status === 'fulfilled' ? lidoAprResult.value : null;
    const jitoApy = jitoApyResult.status === 'fulfilled' ? jitoApyResult.value : null;
    const prices = await pricesPromise; // reuse already-fetched prices
    const totalDeposited = depositsResult.status === 'fulfilled' ? depositsResult.value : null;
    const jitoDeposited = jitoDepositsResult.status === 'fulfilled' ? jitoDepositsResult.value : null;

    if (stEthAmount > 0) {
      const stEthInEth = stEthAmount * stEthRate;
      console.log(`    ${link(STAKING_URLS.lido, 'stETH')}:    ${formatToken(stEthAmount, 6)} (≈ ${formatToken(stEthInEth, 6)} ETH)`);
      console.log(`    Rate:     1 stETH = ${formatToken(stEthRate, 4)} ETH`);
      if (lidoApr != null) {
        console.log(`    APR:      ${lidoApr.toFixed(2)}%`);
      }
      if (prices?.eth) {
        const usdValue = stEthInEth * prices.eth;
        console.log(`    Value:    ${formatUSD(usdValue)} (ETH @ ${formatUSD(prices.eth)})`);
      }
      if (totalDeposited != null && totalDeposited > 0) {
        const earned = stEthInEth - totalDeposited;
        if (earned >= 0) {
          const earnedUsd = prices?.eth ? ` (~${formatUSD(earned * prices.eth)})` : '';
          console.log(`    Earned:   +${formatToken(earned, 6)} ETH${earnedUsd}`);
        }
      }
      if (lidoApr != null && prices?.eth) {
        const stEthInEth2 = stEthAmount * stEthRate;
        const yieldEth = stEthInEth2 * (lidoApr / 100);
        const yieldUsd = yieldEth * prices.eth;
        console.log(`    Yield:    ~${formatToken(yieldEth, 6)} ETH/yr (~${formatUSD(yieldUsd)}/yr)`);
      }
    }

    if (network === 'mainnet' && jitoSolBalance > 0) {
      const jitoInSol = jitoSolBalance * jitoSolRate;
      if (stEthAmount > 0) console.log('');
      console.log(`    ${link(STAKING_URLS.jito, 'JitoSOL')}:  ${formatToken(jitoSolBalance, 6)} (≈ ${formatToken(jitoInSol, 6)} SOL)`);
      console.log(`    Rate:     1 JitoSOL = ${formatToken(jitoSolRate, 4)} SOL`);
      if (jitoApy != null) {
        console.log(`    APY:      ${(jitoApy * 100).toFixed(2)}%`);
      }
      if (prices?.sol) {
        const usdValue = jitoInSol * prices.sol;
        console.log(`    Value:    ${formatUSD(usdValue)} (SOL @ ${formatUSD(prices.sol)})`);
        if (jitoDeposited != null && jitoDeposited > 0) {
          const earned = jitoInSol - jitoDeposited;
          if (earned >= 0) {
            const earnedUsd = ` (~${formatUSD(earned * prices.sol)})`;
            console.log(`    Earned:   +${formatToken(earned, 6)} SOL${earnedUsd}`);
          }
        }
        if (jitoApy != null) {
          const yieldSol = jitoInSol * jitoApy;
          const yieldUsd = yieldSol * prices.sol;
          console.log(`    Yield:    ~${formatToken(yieldSol, 6)} SOL/yr (~${formatUSD(yieldUsd)}/yr)`);
        }
      }
    }

  }

  // ── Display: Pending Withdrawals (shown second, only in full mode) ──
  if (full && withdrawalData && withdrawalData.unclaimed.length > 0) {
    console.log(`\n  ── Pending Withdrawals ${SEP}`);
    for (const req of withdrawalData.unclaimed) {
      const amt = formatToken(Number(req.amountOfStETH) / 1e18, 6);
      const date = new Date(Number(req.timestamp) * 1000).toLocaleDateString();
      if (req.isFinalized) {
        console.log(`    Lido ${link('https://stake.lido.fi/withdrawals/claim', `#${req.id}`)}:  ${amt} stETH  →  CLAIMABLE`);
      } else {
        const ageSec = Math.floor(Date.now() / 1000) - Number(req.timestamp);
        const ageDays = ageSec / 86400;
        let timeLabel: string;
        if (ageDays >= 4) {
          timeLabel = 'finalizing soon';
        } else if (ageDays >= 2) {
          const remaining = Math.max(1, Math.ceil(5 - ageDays));
          timeLabel = `~${remaining}d remaining`;
        } else {
          timeLabel = '~1-5d total';
        }
        console.log(`    Lido ${link('https://stake.lido.fi/withdrawals/claim', `#${req.id}`)}:  ${amt} stETH  →  Pending (${timeLabel})`);
      }
    }
    const claimableCount = withdrawalData.unclaimed.filter(r => r.isFinalized).length;
    if (claimableCount > 0) {
      console.log(`\n  Run: wallet unstake claim eth`);
    }
  }

  // ── Display: Ethereum balances (shown third) ──
  for (const line of evmLines) console.log(line);

  // ── Display: Solana balances (shown fourth) ──
  for (const line of solLines) console.log(line);

  // ── Grand Total ──
  const grandTotal = evmTotalUsd + solTotalUsd;
  if (grandTotal > 0) {
    console.log(`\n  ── Grand Total ${SEP}`);
    console.log(`  ${formatUSD(grandTotal)}`);
  }

  console.log('');
}

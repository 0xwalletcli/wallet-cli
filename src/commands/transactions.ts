import { PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { type Network, ETHERSCAN_API, ETHERSCAN_CHAIN_ID, EXPLORERS, TOKENS, LIDO_CONFIG, JITO_CONFIG, WSOL_CONFIG, SOLANA_MINTS, HISTORY_LIMIT } from '../config.js';
import { resolveSigner } from '../signers/index.js';
import { getConnection } from '../lib/solana.js';
import { formatToken, formatAddress } from '../lib/format.js';
import { listAddresses } from '../lib/addressbook.js';

const SEP = '──────────────────────────────────────────';

// Known Solana token mints → human-readable symbol
const SOLANA_MINT_SYMBOLS: Record<string, string> = {
  [SOLANA_MINTS.USDC]: 'USDC',
  [JITO_CONFIG.jitoSolMint]: 'JitoSOL',
  [WSOL_CONFIG.mint]: 'SOL',
};
function resolveSolanaMint(mint: string | undefined): string {
  if (!mint) return 'SPL';
  return SOLANA_MINT_SYMBOLS[mint] || 'SPL';
}

interface EtherscanTx {
  hash: string;
  from: string;
  to: string;
  value: string;
  timeStamp: string;
  isError: string;
  functionName: string;
}

interface EtherscanTokenTx {
  hash: string;
  from: string;
  to: string;
  value: string;
  timeStamp: string;
  tokenSymbol: string;
  tokenDecimal: string;
  contractAddress: string;
}

interface EtherscanInternalTx {
  hash: string;
  from: string;
  to: string;
  value: string;
  timeStamp: string;
  isError: string;
  type: string;
}

interface EvmEntry {
  timestamp: number;
  hash: string;
  amount: number;
  symbol: string;
  isSend: boolean;
  counterparty: string;
  label: string;
  failed: boolean;
}

function termLink(text: string, url: string): string {
  return `\x1b]8;;${url}\x07${text}\x1b]8;;\x07`;
}

export async function transactionsCommand(network: Network, limit: number) {
  const signer = await resolveSigner();
  const evmAccount = await signer.getEvmAccount();
  const evmAddress = evmAccount.address.toLowerCase();
  const solAddress = await signer.getSolanaAddress();
  const tokens = TOKENS[network];
  const explorer = EXPLORERS[network];

  // Build address book lookup for friendly names
  const addressBook = listAddresses();
  function resolveLabel(address: string): string {
    const lower = address.toLowerCase();
    const entry = addressBook.find(e =>
      e.evm?.toLowerCase() === lower || e.solana?.toLowerCase() === lower
    );
    return entry ? entry.name : formatAddress(address, 4);
  }

  console.log(`\n  Network: ${network}`);
  console.log('  Fetching...');

  const apiKey = process.env.ETHERSCAN_API_KEY;

  // Fetch ETH txs + token txs + Solana sigs in parallel
  const baseParams = {
    chainid: ETHERSCAN_CHAIN_ID[network],
    module: 'account',
    address: evmAddress,
    startblock: '0',
    endblock: '99999999',
    page: '1',
    offset: String(limit),
    sort: 'desc',
    apikey: apiKey || '',
  };

  const evmTxPromise = apiKey ? (async () => {
    const params = new URLSearchParams({ ...baseParams, action: 'txlist' });
    const res = await fetch(`${ETHERSCAN_API}?${params}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as { status: string; result: EtherscanTx[] | string };
  })() : null;

  const tokenTxPromise = apiKey ? (async () => {
    const params = new URLSearchParams({ ...baseParams, action: 'tokentx' });
    const res = await fetch(`${ETHERSCAN_API}?${params}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as { status: string; result: EtherscanTokenTx[] | string };
  })() : null;

  const internalTxPromise = apiKey ? (async () => {
    const params = new URLSearchParams({ ...baseParams, action: 'txlistinternal' });
    const res = await fetch(`${ETHERSCAN_API}?${params}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as { status: string; result: EtherscanInternalTx[] | string };
  })() : null;

  const solPromise = solAddress ? (async () => {
    const conn = getConnection(network);
    const pubkey = new PublicKey(solAddress);
    return conn.getSignaturesForAddress(pubkey, { limit: limit * 3 });
  })() : null;

  const [evmTxResult, tokenTxResult, internalTxResult, solResult] = await Promise.allSettled([
    evmTxPromise ?? Promise.resolve(null),
    tokenTxPromise ?? Promise.resolve(null),
    internalTxPromise ?? Promise.resolve(null),
    solPromise ?? Promise.resolve(null),
  ]);

  // ── Ethereum Transactions ──
  console.log(`\n  ── Ethereum Transactions ${SEP}`);
  if (!apiKey) {
    console.log('  No ETHERSCAN_API_KEY in .env');
    console.log('  Get a free key: https://etherscan.io/apis\n');
  } else if (evmTxResult.status === 'rejected' && tokenTxResult.status === 'rejected') {
    console.log(`  Failed to fetch (${evmTxResult.reason?.message || evmTxResult.reason})`);
  } else {
    const entries: EvmEntry[] = [];

    // ETH transfers
    if (evmTxResult.status === 'fulfilled') {
      const data = evmTxResult.value as { status: string; result: EtherscanTx[] | string } | null;
      if (data && data.status === '1' && Array.isArray(data.result)) {
        for (const tx of data.result) {
          const ethValue = Number(tx.value) / 1e18;
          const isSend = tx.from.toLowerCase() === evmAddress;
          entries.push({
            timestamp: Number(tx.timeStamp),
            hash: tx.hash,
            amount: ethValue,
            symbol: 'ETH',
            isSend,
            counterparty: isSend ? tx.to : tx.from,
            label: tx.functionName ? tx.functionName.split('(')[0] : (ethValue > 0 ? 'transfer' : 'contract'),
            failed: tx.isError === '1',
          });
        }
      }
    }

    // ERC-20 token transfers — only show supported tokens
    const knownTokens = new Set([
      tokens.USDC.toLowerCase(),
      tokens.WETH.toLowerCase(),
      tokens.WSOL.toLowerCase(),
      LIDO_CONFIG[network].stETH.toLowerCase(),
    ]);
    if (tokenTxResult.status === 'fulfilled') {
      const data = tokenTxResult.value as { status: string; result: EtherscanTokenTx[] | string } | null;
      if (data && data.status === '1' && Array.isArray(data.result)) {
        for (const tx of data.result) {
          if (!knownTokens.has(tx.contractAddress.toLowerCase())) continue;
          const decimals = Number(tx.tokenDecimal) || 18;
          const amount = Number(tx.value) / 10 ** decimals;
          const isSend = tx.from.toLowerCase() === evmAddress;
          entries.push({
            timestamp: Number(tx.timeStamp),
            hash: tx.hash,
            amount,
            symbol: tx.tokenSymbol || '???',
            isSend,
            counterparty: isSend ? tx.to : tx.from,
            label: 'transfer',
            failed: false,
          });
        }
      }
    }

    // Internal ETH transfers (from contract calls like withdraw, execute)
    if (internalTxResult.status === 'fulfilled') {
      const data = internalTxResult.value as { status: string; result: EtherscanInternalTx[] | string } | null;
      if (data && data.status === '1' && Array.isArray(data.result)) {
        for (const tx of data.result) {
          const ethValue = Number(tx.value) / 1e18;
          if (ethValue <= 0) continue;
          const isSend = tx.from.toLowerCase() === evmAddress;
          entries.push({
            timestamp: Number(tx.timeStamp),
            hash: tx.hash,
            amount: ethValue,
            symbol: 'ETH',
            isSend,
            counterparty: isSend ? tx.to : tx.from,
            label: 'transfer',
            failed: tx.isError === '1',
          });
        }
      }
    }

    // Deduplicate: when a tx hash has entries with amounts, drop zero-amount entries for same hash
    const hashesWithAmounts = new Set(entries.filter(e => e.amount > 0).map(e => e.hash));
    const deduped = entries.filter(e => e.amount > 0 || !hashesWithAmounts.has(e.hash));

    if (deduped.length === 0) {
      console.log('  No transactions found.\n');
    } else {
      // Sort by timestamp desc, take top `limit`
      deduped.sort((a, b) => b.timestamp - a.timestamp);
      const display = deduped.slice(0, limit);

      for (const e of display) {
        const date = new Date(e.timestamp * 1000);
        const time = date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
        const dateStr = `${date.getMonth() + 1}/${date.getDate()} ${time}`;
        const arrow = e.isSend ? '→' : '←';
        const counterparty = resolveLabel(e.counterparty);
        const status = e.failed ? ' FAIL' : '';
        const shortHash = e.hash.slice(0, 8) + '...' + e.hash.slice(-6);
        const txUrl = `${explorer.evm}/tx/${e.hash}`;
        const link = termLink(shortHash, txUrl);
        const amtStr = e.amount > 0
          ? `${formatToken(e.amount, 4).padStart(10)} ${e.symbol.padEnd(6)}`
          : `${''.padStart(10)} ${''.padEnd(6)}`;
        const lbl = (e.label + status).slice(0, 12).padEnd(12);

        console.log(`   ${dateStr.padEnd(12)}${amtStr} ${arrow} ${counterparty.padEnd(12)} ${lbl} ${link}`);
      }
      console.log(`  Explorer: ${explorer.evm}/address/${evmAddress}`);
    }
  }

  // ── Solana Transactions ──
  console.log(`\n  ── Solana Transactions ${SEP}`);
  if (!solAddress) {
    console.log('  No SOLANA_ADDRESS configured in .env\n');
  } else if (solResult.status === 'rejected') {
    console.log(`  Failed to fetch (${solResult.reason?.message || solResult.reason})`);
  } else {
    const sigs = solResult.value as { signature: string; blockTime: number | null; err: any; memo: string | null }[] | null;
    if (!sigs || sigs.length === 0) {
      console.log('  No transactions found.\n');
    } else {
      // Fetch parsed transaction details for SOL amounts + token transfers
      // Use a tight timeout — if RPC is slow/429, fall back to basic display
      // Suppress @solana/web3.js retry messages during fetch
      const conn = getConnection(network);
      const origLog = console.log;
      const origWarn = console.warn;
      const origInfo = console.info;
      const origError = console.error;
      const origStderrWrite = process.stderr.write;
      console.log = (...args: any[]) => {
        if (typeof args[0] === 'string' && args[0].includes('429')) return;
        origLog(...args);
      };
      console.warn = (...args: any[]) => {
        if (typeof args[0] === 'string' && args[0].includes('429')) return;
        origWarn(...args);
      };
      console.info = () => {};
      console.error = (...args: any[]) => {
        if (typeof args[0] === 'string' && args[0].includes('429')) return;
        origError(...args);
      };
      process.stderr.write = function(chunk: any, ...rest: any[]) {
        if (typeof chunk === 'string' && chunk.includes('429')) return true;
        return origStderrWrite.apply(process.stderr, [chunk, ...rest] as any);
      } as any;
      // Fetch parsed txs individually (batch calls fail on public RPCs)
      const parsedTxs = await Promise.race([
        Promise.all(sigs.map(s =>
          conn.getParsedTransaction(s.signature, { maxSupportedTransactionVersion: 0 }).catch(() => null)
        )),
        new Promise<null>(resolve => setTimeout(() => resolve(null), 10000)),
      ]).catch(() => null);
      console.log = origLog;
      console.warn = origWarn;
      console.info = origInfo;
      console.error = origError;
      process.stderr.write = origStderrWrite;

      if (!parsedTxs) {
        console.log('  (RPC too slow to fetch details — showing signatures only)');
      }
      const solAddr = solAddress;
      const clusterParam = network === 'testnet' ? '?cluster=devnet' : '';
      const solAccountPath = network === 'testnet' ? '/address' : '/account';
      const solTxPath = network === 'testnet' ? '/tx' : '/tx';

      let displayed = 0;
      for (let i = 0; i < sigs.length; i++) {
        if (displayed >= limit) break;
        const sig = sigs[i];
        const parsed = parsedTxs?.[i];
        const date = sig.blockTime ? new Date(sig.blockTime * 1000) : null;
        const time = date ? date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false }) : '';
        const dateStr = date ? `${date.getMonth() + 1}/${date.getDate()} ${time}` : '?';
        const failed = sig.err ? ' FAIL' : '';
        const shortHash = sig.signature.slice(0, 8) + '...' + sig.signature.slice(-6);
        const txUrl = `${explorer.solana}${solTxPath}/${sig.signature}${clusterParam}`;
        const link = termLink(shortHash, txUrl);

        // Try to extract SOL transfer amount and direction
        let amount = 0;
        let symbol = 'SOL';
        let arrow = ' ';
        let counterparty = '';
        let label = '';

        if (parsed?.meta) {
          const meta = parsed.meta;
          const accounts = parsed.transaction.message.accountKeys.map(k => k.pubkey.toBase58());
          const myIndex = accounts.indexOf(solAddr);

          if (myIndex >= 0 && meta.preBalances && meta.postBalances) {
            // SOL balance change (in lamports)
            const diff = meta.postBalances[myIndex] - meta.preBalances[myIndex];
            const fee = myIndex === 0 ? (meta.fee || 0) : 0;
            const solChange = (diff + fee) / LAMPORTS_PER_SOL; // add back fee to show true transfer amount

            if (Math.abs(solChange) > 0.000001) {
              amount = Math.abs(solChange);
              arrow = solChange > 0 ? '←' : '→';
            }
          }

          // Check for token transfers (SPL)
          if (meta.preTokenBalances && meta.postTokenBalances) {
            for (const post of meta.postTokenBalances) {
              if (post.owner !== solAddr) continue;
              const pre = meta.preTokenBalances.find(p => p.accountIndex === post.accountIndex);
              const preAmt = pre ? Number(pre.uiTokenAmount.uiAmount || 0) : 0;
              const postAmt = Number(post.uiTokenAmount.uiAmount || 0);
              const diff = postAmt - preAmt;
              if (Math.abs(diff) > 0.000001) {
                amount = Math.abs(diff);
                symbol = resolveSolanaMint(post.mint);
                arrow = diff > 0 ? '←' : '→';
              }
            }
          }

          // Scan ALL instructions (+ inner) for label and counterparty
          const ixs = parsed.transaction.message.instructions as any[];
          const innerIxs = (meta.innerInstructions || []).flatMap((g: any) => g.instructions || []) as any[];
          const allIxs = [...ixs, ...innerIxs];

          // Identify known programs from account keys
          const accountStrs = accounts;
          const knownPrograms: Record<string, string> = {
            'src5qyZHqTqecJV4aY6Cb6zDZLMDzrDKKezs22MPo94': 'deBridge',
            'dst5MGcFPoBeREFAA5E3tU5ij8m5uVYwkzkSAbsLbNo': 'deBridge',
            'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4': 'Jupiter',
            'J1TnP8zvVxbtF5KFp5xRmWuvG9McnhzmBd9XGfCyuxFP': 'Jito',
          };
          for (const addr of accountStrs) {
            if (knownPrograms[addr] && !label) {
              label = knownPrograms[addr];
            }
          }

          // Scan instructions for transfer info
          for (const ix of allIxs) {
            if (counterparty && label) break;
            if (ix.parsed?.type) {
              const type = ix.parsed.type;
              if (!label || label === 'system') {
                if (type === 'transfer' || type === 'transferChecked') label = label || 'transfer';
                else if (type === 'createAccount') label = label || 'create';
                else if (!label) label = type;
              }
            }
            if (!counterparty && ix.parsed?.info) {
              const info = ix.parsed.info;
              if (arrow === '←' && info.source && info.source !== solAddr) {
                counterparty = resolveLabel(info.source);
              } else if (arrow === '→' && info.destination && info.destination !== solAddr) {
                counterparty = resolveLabel(info.destination);
              } else if (info.lamports) {
                const other = arrow === '→' ? info.destination : info.source;
                if (other && other !== solAddr) counterparty = resolveLabel(other);
              }
            }
          }
        }

        // Skip txs where wallet had no balance change (referenced but not involved)
        if (parsed?.meta && amount === 0 && !failed) continue;
        displayed++;

        const amtStr = amount > 0
          ? `${formatToken(amount, 4).padStart(10)} ${symbol.padEnd(8)}`
          : `${''.padStart(10)} ${''.padEnd(8)}`;
        const arrowStr = arrow !== ' ' ? arrow : ' ';
        const cpStr = counterparty ? counterparty.padEnd(12) : ''.padEnd(12);
        const lbl = ((label || '') + failed).slice(0, 12).padEnd(12);

        console.log(`   ${dateStr.padEnd(12)}${amtStr} ${arrowStr} ${cpStr} ${lbl} ${link}`);
      }
      console.log(`  Explorer: ${explorer.solana}${solAccountPath}/${solAddress}${clusterParam}`);
    }
  }

  console.log('');
}

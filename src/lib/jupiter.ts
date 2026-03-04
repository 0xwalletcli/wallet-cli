import { VersionedTransaction, PublicKey } from '@solana/web3.js';
import { JUPITER_CONFIG, SOLANA_MINTS, HISTORY_LIMIT, type Network } from '../config.js';
import { getConnection } from './solana.js';
import type { Signer } from '../signers/types.js';

// ── Types ────────────────────────────────────────────

export interface JupiterQuote {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  otherAmountThreshold: string;
  swapMode: string;
  priceImpactPct: string;
  routePlan: unknown[];
}

export interface JupiterSwapRecord {
  signature: string;
  timestamp: number;        // unix seconds
  sellToken: string;        // symbol (SOL, USDC)
  buyToken: string;
  sellAmount: number;       // human-readable
  buyAmount: number;
  status: 'fulfilled' | 'failed';
}

// ── Token helpers ────────────────────────────────────

const MINT_TO_SYMBOL: Record<string, string> = {
  [SOLANA_MINTS.SOL]: 'SOL',
  [SOLANA_MINTS.USDC]: 'USDC',
};

const SYMBOL_TO_MINT: Record<string, string> = {
  SOL: SOLANA_MINTS.SOL,
  USDC: SOLANA_MINTS.USDC,
};

const SYMBOL_TO_DECIMALS: Record<string, number> = {
  SOL: 9,
  USDC: 6,
};

export function getSolanaMint(symbol: string): string {
  const mint = SYMBOL_TO_MINT[symbol.toUpperCase()];
  if (!mint) throw new Error(`Unknown Solana token: ${symbol}`);
  return mint;
}

export function getSolanaDecimals(symbol: string): number {
  return SYMBOL_TO_DECIMALS[symbol.toUpperCase()] ?? 9;
}

export function resolveSolanaTokenSymbol(mint: string): string {
  return MINT_TO_SYMBOL[mint] ?? mint.slice(0, 6) + '...';
}

// ── Jupiter API ──────────────────────────────────────

export async function getJupiterQuote(params: {
  inputMint: string;
  outputMint: string;
  amount: string;
  swapMode: 'ExactIn' | 'ExactOut';
  slippageBps?: number;
}): Promise<JupiterQuote> {
  const qs = new URLSearchParams({
    inputMint: params.inputMint,
    outputMint: params.outputMint,
    amount: params.amount,
    swapMode: params.swapMode,
    slippageBps: String(params.slippageBps ?? 100),
  });

  const res = await fetch(`${JUPITER_CONFIG.api}/quote?${qs}`);
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Jupiter quote failed: ${err}`);
  }
  return (await res.json()) as JupiterQuote;
}

export async function buildAndSendJupiterSwap(params: {
  userPublicKey: string;
  quote: JupiterQuote;
  signer: Signer;
  network: Network;
}): Promise<string> {
  const { userPublicKey, quote, signer, network } = params;

  const swapRes = await fetch(`${JUPITER_CONFIG.api}/swap`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      userPublicKey,
      quoteResponse: quote,
      dynamicSlippage: { maxBps: 300 },
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: 'auto',
    }),
  });

  if (!swapRes.ok) {
    const err = await swapRes.text();
    throw new Error(`Jupiter swap failed: ${err}`);
  }

  const { swapTransaction } = (await swapRes.json()) as { swapTransaction: string };
  const conn = getConnection(network);
  const txBuf = Buffer.from(swapTransaction, 'base64');
  const tx = VersionedTransaction.deserialize(txBuf);
  const signed = await signer.signSolanaVersionedTransaction(tx);

  return conn.sendTransaction(signed, { maxRetries: 3 });
}

// ── On-chain history ─────────────────────────────────

const JUPITER_PROGRAM = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';

export async function getJupiterHistory(
  network: Network,
  walletAddress: string,
  limit = HISTORY_LIMIT,
): Promise<JupiterSwapRecord[]> {
  const conn = getConnection(network);
  const pubkey = new PublicKey(walletAddress);

  const sigs = await conn.getSignaturesForAddress(pubkey, { limit: 50 });
  const results: JupiterSwapRecord[] = [];

  // Fetch parsed txs individually (batch fails on public RPC)
  for (const sig of sigs) {
    if (results.length >= limit) break;
    try {
      const parsed = await conn.getParsedTransaction(sig.signature, {
        maxSupportedTransactionVersion: 0,
      });
      if (!parsed?.meta) continue;

      // Check if Jupiter program is in account keys
      const accounts = parsed.transaction.message.accountKeys.map(
        (k: any) => (typeof k === 'string' ? k : k.pubkey?.toBase58?.() ?? String(k)),
      );
      if (!accounts.includes(JUPITER_PROGRAM)) continue;

      // Find user's account index
      const myIndex = accounts.indexOf(walletAddress);
      if (myIndex < 0) continue;

      // SOL balance change (add back fee to get true transfer amount)
      const solDiff = (parsed.meta.postBalances[myIndex] - parsed.meta.preBalances[myIndex]) / 1e9;
      const fee = myIndex === 0 ? (parsed.meta.fee || 0) / 1e9 : 0;
      const solChange = solDiff + fee;

      // USDC token balance change
      let usdcChange = 0;
      const pre = parsed.meta.preTokenBalances || [];
      const post = parsed.meta.postTokenBalances || [];
      for (const p of post) {
        if (p.owner !== walletAddress || p.mint !== SOLANA_MINTS.USDC) continue;
        const preEntry = pre.find(
          (x: any) => x.accountIndex === p.accountIndex,
        );
        const preAmt = preEntry ? Number(preEntry.uiTokenAmount.uiAmount || 0) : 0;
        const postAmt = Number(p.uiTokenAmount.uiAmount || 0);
        usdcChange = postAmt - preAmt;
      }

      // Determine swap direction
      let sellToken: string, buyToken: string, sellAmount: number, buyAmount: number;
      if (usdcChange < -0.001 && solChange > 0.0001) {
        sellToken = 'USDC'; buyToken = 'SOL';
        sellAmount = Math.abs(usdcChange); buyAmount = solChange;
      } else if (solChange < -0.0001 && usdcChange > 0.001) {
        sellToken = 'SOL'; buyToken = 'USDC';
        sellAmount = Math.abs(solChange); buyAmount = usdcChange;
      } else {
        continue; // not a recognizable USDC<->SOL swap
      }

      results.push({
        signature: sig.signature,
        timestamp: sig.blockTime ?? 0,
        sellToken,
        buyToken,
        sellAmount,
        buyAmount,
        status: sig.err ? 'failed' : 'fulfilled',
      });
    } catch {
      // skip failed RPC calls
    }
  }

  return results;
}

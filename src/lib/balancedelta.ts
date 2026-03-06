import { type Network, TOKENS, BASE_TOKENS, LIDO_CONFIG, JITO_CONFIG, SOLANA_MINTS } from '../config.js';
import { getPublicClient, getERC20Balance } from './evm.js';
import { getSolBalance, getSplTokenBalance, getWsolBalance } from './solana.js';
import { formatToken } from './format.js';

// ── Types ──

export interface TrackedToken {
  symbol: string;
  decimals: number;
  fetch: () => Promise<number>;
}

export interface BalanceDelta {
  symbol: string;
  before: number;
  after: number;
  change: number;
  decimals: number;
}

// ── BalanceTracker ──

export class BalanceTracker {
  private tokens: TrackedToken[];
  private snapshots: Map<string, number>[] = [];

  constructor(tokens: TrackedToken[]) {
    this.tokens = tokens;
  }

  /** Take a snapshot of all tracked balances (in parallel). Returns snapshot index. */
  async snapshot(): Promise<number> {
    const balances = new Map<string, number>();
    const results = await Promise.allSettled(this.tokens.map(t => t.fetch()));
    for (let i = 0; i < this.tokens.length; i++) {
      const r = results[i];
      balances.set(
        this.tokens[i].symbol,
        r.status === 'fulfilled' ? r.value : 0,
      );
    }
    this.snapshots.push(balances);
    return this.snapshots.length - 1;
  }

  /** Compute deltas between two snapshots. Only returns tokens that changed. */
  deltas(fromIdx: number, toIdx: number): BalanceDelta[] {
    const from = this.snapshots[fromIdx];
    const to = this.snapshots[toIdx];
    const result: BalanceDelta[] = [];
    for (const token of this.tokens) {
      const before = from.get(token.symbol) ?? 0;
      const after = to.get(token.symbol) ?? 0;
      const change = after - before;
      // Skip dust: >0.000001 for most tokens, >0.01 for USDC
      const threshold = token.decimals <= 2 ? 0.01 : 0.000001;
      if (Math.abs(change) > threshold) {
        result.push({ symbol: token.symbol, before, after, change, decimals: token.decimals });
      }
    }
    return result;
  }

  /** Print formatted balance changes between two snapshots. */
  printDeltas(label?: string, fromIdx?: number, toIdx?: number): void {
    const from = fromIdx ?? 0;
    const to = toIdx ?? this.snapshots.length - 1;
    if (from === to || this.snapshots.length < 2) return;

    const ds = this.deltas(from, to);
    if (ds.length === 0) {
      console.log(`\n  Balance update pending — run 'wallet balance' to verify.`);
      return;
    }

    const header = label ? `Balance Changes (${label})` : 'Balance Changes';
    const line = '─'.repeat(Math.max(0, 42 - header.length));
    console.log(`\n  ── ${header} ${line}`);

    const symW = Math.max(...ds.map(d => d.symbol.length));

    for (const d of ds) {
      const dec = d.decimals <= 2 ? 2 : Math.min(d.decimals, 6);
      const beforeStr = formatToken(d.before, dec);
      const afterStr = formatToken(d.after, dec);
      const sign = d.change >= 0 ? '+' : '';
      const changeStr = `(${sign}${formatToken(d.change, dec)})`;
      console.log(`  ${d.symbol.padEnd(symW)}  ${beforeStr} -> ${afterStr}  ${changeStr}`);
    }
  }

  /** Print the most recent snapshot's balances as a "before" summary. */
  printBefore(): void {
    if (this.snapshots.length === 0) return;
    const snap = this.snapshots[this.snapshots.length - 1];
    const entries = this.tokens.map(t => ({
      symbol: t.symbol,
      value: snap.get(t.symbol) ?? 0,
      decimals: t.decimals,
    }));
    const symW = Math.max(...entries.map(e => e.symbol.length));
    console.log(`\n  ── Balances ──────────────────────────────`);
    for (const e of entries) {
      const dec = e.decimals <= 2 ? 2 : Math.min(e.decimals, 6);
      console.log(`  ${e.symbol.padEnd(symW)}  ${formatToken(e.value, dec)}`);
    }
  }

  /** Take "after" snapshot and print deltas from a previous snapshot. */
  async snapshotAndPrint(label?: string, fromIdx?: number): Promise<void> {
    // Brief delay to let RPC index the latest block's state changes
    await new Promise(r => setTimeout(r, 2000));
    const toIdx = await this.snapshot();
    const from = fromIdx ?? toIdx - 1;
    this.printDeltas(label, from, toIdx);
  }

  get snapshotCount(): number {
    return this.snapshots.length;
  }
}

// ── Factory Functions ──

/** Build TrackedToken list for EVM tokens. */
export function evmTokens(network: Network, address: `0x${string}`, which: string[]): TrackedToken[] {
  const tokens = TOKENS[network];
  const result: TrackedToken[] = [];
  for (const sym of which) {
    switch (sym) {
      case 'ETH':
        result.push({ symbol: 'ETH', decimals: 6, fetch: async () => {
          const bal = await getPublicClient(network).getBalance({ address });
          return Number(bal) / 1e18;
        }});
        break;
      case 'WETH':
        result.push({ symbol: 'WETH', decimals: 6, fetch: async () => {
          const bal = await getERC20Balance(network, tokens.WETH, address);
          return Number(bal) / 1e18;
        }});
        break;
      case 'USDC':
        result.push({ symbol: 'USDC', decimals: 2, fetch: async () => {
          const bal = await getERC20Balance(network, tokens.USDC, address);
          return Number(bal) / 10 ** tokens.USDC_DECIMALS;
        }});
        break;
      case 'stETH':
        result.push({ symbol: 'stETH', decimals: 6, fetch: async () => {
          const lido = LIDO_CONFIG[network];
          const bal = await getERC20Balance(network, lido.stETH, address);
          return Number(bal) / 1e18;
        }});
        break;
      case 'WSOL-ETH':
        result.push({ symbol: 'WSOL-ETH', decimals: 6, fetch: async () => {
          const bal = await getERC20Balance(network, tokens.WSOL, address);
          return Number(bal) / 10 ** tokens.WSOL_DECIMALS;
        }});
        break;
    }
  }
  return result;
}

/** Build TrackedToken list for Base chain tokens. */
export function baseTokens(network: Network, address: `0x${string}`, which: string[]): TrackedToken[] {
  const tokens = BASE_TOKENS[network];
  const result: TrackedToken[] = [];
  for (const sym of which) {
    switch (sym) {
      case 'ETH-BASE':
        result.push({ symbol: 'ETH-BASE', decimals: 6, fetch: async () => {
          const bal = await getPublicClient(network, 'base').getBalance({ address });
          return Number(bal) / 1e18;
        }});
        break;
      case 'USDC-BASE':
        result.push({ symbol: 'USDC-BASE', decimals: 2, fetch: async () => {
          const bal = await getERC20Balance(network, tokens.USDC, address, 'base');
          return Number(bal) / 10 ** tokens.USDC_DECIMALS;
        }});
        break;
    }
  }
  return result;
}

/** Build TrackedToken list for Solana tokens. */
export function solTokens(network: Network, pubkey: string, which: string[]): TrackedToken[] {
  const result: TrackedToken[] = [];
  for (const sym of which) {
    switch (sym) {
      case 'SOL':
        result.push({ symbol: 'SOL', decimals: 6, fetch: () => getSolBalance(network, pubkey) });
        break;
      case 'WSOL':
        result.push({ symbol: 'WSOL', decimals: 6, fetch: () => getWsolBalance(network, pubkey) });
        break;
      case 'USDC':
        result.push({ symbol: 'USDC', decimals: 2, fetch: () => getSplTokenBalance(network, pubkey, SOLANA_MINTS.USDC) });
        break;
      case 'JitoSOL':
        result.push({ symbol: 'JitoSOL', decimals: 6, fetch: () => getSplTokenBalance(network, pubkey, JITO_CONFIG.jitoSolMint) });
        break;
    }
  }
  return result;
}

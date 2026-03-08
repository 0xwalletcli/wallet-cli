/**
 * Peer off-ramp provider
 *
 * Decentralized P2P USDC off-ramp on Base chain.
 * LP model: deposit USDC → buyers pay fiat via Venmo/Zelle/CashApp/Revolut.
 * Non-custodial, no KYC/KYB, no broker reporting.
 */

import type { OfframpProvider, OfframpBankAccount, OfframpQuote, OfframpOrderSummary } from '../types.js';
import { registerOfframpProvider } from '../registry.js';
import {
  getPeerClient, getBaseUsdcBalance, formatUsdc, parseUsdc,
  BASE_USDC, USDC_DECIMALS, SUPPORTED_PLATFORMS, getPlatformLabel,
  isValidPlatform, spreadToRate, rateToSpread,
} from '../../lib/peer.js';
import { formatToken, formatUSD } from '../../lib/format.js';
import { resolveSigner } from '../../signers/index.js';

// ── Deposit management (Peer-specific, exported for withdraw command) ──

export interface PeerDeposit {
  depositId: string;
  amount: string;           // total deposited (human-readable)
  remaining: string;        // available liquidity (human-readable)
  locked: string;           // locked in active intents (human-readable)
  accepting: boolean;       // accepting new intents
  paymentMethods: string[]; // ['venmo', 'zelle', ...]
  spreads: string[];        // ['2.00%', '2.50%', ...]
  intentCount: number;
}

/** List user's deposits from on-chain */
export async function listDeposits(): Promise<PeerDeposit[]> {
  const client = await getPeerClient();
  const deposits = await client.getDeposits();

  return deposits.map((d: any) => {
    const dep = d.deposit;
    const remaining = Number(dep.remainingDepositAmount) / 1e6;
    const total = Number(dep.depositAmount) / 1e6;
    const outstanding = Number(dep.outstandingIntentAmount) / 1e6;

    const methods: string[] = [];
    const spreads: string[] = [];
    for (const pm of d.paymentMethods || []) {
      const name = pm.processorName || pm.paymentMethod || '?';
      methods.push(name);
      for (const curr of pm.currencies || []) {
        const rate = Number(curr.conversionRate) / 1e18;
        spreads.push(`${((rate - 1) * 100).toFixed(2)}%`);
      }
    }

    return {
      depositId: String(d.depositId),
      amount: formatToken(total, 2),
      remaining: formatToken(remaining, 2),
      locked: formatToken(outstanding, 2),
      accepting: dep.acceptingIntents,
      paymentMethods: methods,
      spreads: [...new Set(spreads)],
      intentCount: (dep.intentHashes || []).length,
    };
  });
}

/** Create a new USDC deposit on Peer escrow (Base) */
export async function createDeposit(params: {
  amount: string;
  platforms: string[];
  depositData: { [key: string]: string }[];
  spreadPct: number;
  minAmount?: string;
  maxAmount?: string;
}): Promise<{ hash: string; depositDetails: any[] }> {

  const client = await getPeerClient();
  const amountRaw = parseUsdc(params.amount);

  const min = params.minAmount ? parseUsdc(params.minAmount) : parseUsdc('10');
  const max = params.maxAmount ? parseUsdc(params.maxAmount) : amountRaw;

  // Build conversion rates per processor (each gets USD at the specified spread)
  const conversionRates = params.platforms.map(() => [{
    currency: 'USD',
    conversionRate: spreadToRate(params.spreadPct),
  }]);

  // Ensure USDC approval for escrow
  console.log('  Checking USDC approval...');
  const { hadAllowance, hash: approvalHash } = await client.ensureAllowance({
    token: BASE_USDC,
    amount: amountRaw,
  });
  if (!hadAllowance && approvalHash) {
    console.log(`  Approved USDC: ${approvalHash}`);
  }

  console.log('  Creating deposit...');
  const result = await client.createDeposit({
    token: BASE_USDC,
    amount: amountRaw,
    intentAmountRange: { min, max },
    processorNames: params.platforms,
    depositData: params.depositData,
    conversionRates,
  });

  return { hash: result.hash, depositDetails: result.depositDetails };
}

/** Add funds to an existing deposit */
export async function addFunds(depositId: string, amount: string): Promise<string> {

  const client = await getPeerClient();
  const amountRaw = parseUsdc(amount);

  const { hadAllowance, hash: approvalHash } = await client.ensureAllowance({
    token: BASE_USDC,
    amount: amountRaw,
  });
  if (!hadAllowance && approvalHash) {
    console.log(`  Approved USDC: ${approvalHash}`);
  }

  const hash = await client.addFunds({ depositId: BigInt(depositId), amount: amountRaw });
  return hash;
}

/** Remove funds from a deposit */
export async function removeFunds(depositId: string, amount: string): Promise<string> {

  const client = await getPeerClient();
  const hash = await client.removeFunds({ depositId: BigInt(depositId), amount: parseUsdc(amount) });
  return hash;
}

/** Fully withdraw a deposit */
export async function withdrawDeposit(depositId: string): Promise<string> {

  const client = await getPeerClient();
  const hash = await client.withdrawDeposit({ depositId: BigInt(depositId) });
  return hash;
}

/** Enable/disable accepting intents on a deposit */
export async function setAcceptingIntents(depositId: string, accepting: boolean): Promise<string> {

  const client = await getPeerClient();
  const hash = await client.setAcceptingIntents({ depositId: BigInt(depositId), accepting });
  return hash;
}

/** Get liquidity quotes (orderbook preview) */
export async function getLiquidity(params: {
  amount: string;
  platforms: string[];
  address: string;
}): Promise<any> {
  const client = await getPeerClient();
  const quote = await client.getQuote({
    paymentPlatforms: params.platforms,
    fiatCurrency: 'USD',
    user: params.address,
    recipient: params.address,
    destinationChainId: 8453,
    destinationToken: BASE_USDC,
    amount: params.amount,
    isExactFiat: true,
    includeNearbyQuotes: true,
    nearbySearchRange: 10,
    quotesToReturn: 10,
  });
  return quote;
}

/** Get intent history for the connected wallet */
export async function getIntentHistory(): Promise<OfframpOrderSummary[]> {
  try {
    const client = await getPeerClient();
    const signer = await resolveSigner();
    const account = await signer.getEvmAccount();
    const intents = await client.indexer.getOwnerIntents(account.address);

    if (!Array.isArray(intents)) return [];

    return intents.slice(0, 10).map((intent: any) => ({
      id: intent.intentHash || intent.id || '?',
      amount: intent.amount ? formatToken(Number(intent.amount) / 1e6, 2) : '?',
      status: intent.status || 'unknown',
      createdAt: intent.signalTimestamp ? new Date(intent.signalTimestamp).toISOString() : new Date().toISOString(),
      provider: 'peer',
    }));
  } catch {
    return [];
  }
}

// ── OfframpProvider implementation ──

const peerOfframpProvider: OfframpProvider = {
  id: 'peer',
  displayName: 'Peer',

  isConfigured(): boolean {
    // Peer needs an EVM signer (env key, WalletConnect, or browser).
    // Check all possible EVM signer sources:
    return !!(process.env.EVM_PRIVATE_KEY || process.env.WC_PROJECT_ID);
  },

  async listAccounts(): Promise<OfframpBankAccount[]> {
    // Peer doesn't have "bank accounts" — deposits are the equivalent
    // Return active deposits as "accounts" for compatibility
    const deposits = await listDeposits();
    return deposits
      .filter(d => d.accepting)
      .map(d => ({
        id: d.depositId,
        label: `Deposit #${d.depositId}`,
        institution: 'Peer',
        accountNumber: d.remaining,
        type: d.paymentMethods.join(', '),
      }));
  },

  async getQuote({ amount, bankAccountId }): Promise<OfframpQuote> {
    // For Peer, "quote" means creating a deposit — return tx params stub
    // The actual deposit is created via createDeposit() directly
    return {
      provider: 'peer',
      amount,
      amountRaw: parseUsdc(amount).toString(),
      bankAccountId,
      bankAccountLabel: `Deposit #${bankAccountId}`,
      fee: '0% protocol fee',
      estimatedTime: 'P2P — depends on buyer demand',
      txParams: { to: '', data: '' }, // not used — SDK handles tx
      _raw: null,
    };
  },

  async getHistory(): Promise<OfframpOrderSummary[]> {
    return getIntentHistory();
  },
};

registerOfframpProvider(peerOfframpProvider);
export { peerOfframpProvider };

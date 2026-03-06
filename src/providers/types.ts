import type { Network } from '../config.js';

// ── Swap Provider ────────────────────────────────────

export interface SwapQuote {
  provider: string;           // 'cow' | 'uniswap'
  sellToken: string;          // contract address
  buyToken: string;           // contract address
  sellAmount: string;         // raw amount string (post-fee)
  buyAmount: string;          // raw amount string
  feeAmount: string;          // raw amount string (fee in sell token, '0' if gas-based)
  gasFeeUSD?: string;         // estimated gas cost in USD (Uniswap Classic)
  validTo: number;            // unix timestamp
  kind: 'sell' | 'buy';
  gasless: boolean;
  appData: string;
  _raw: unknown;              // opaque provider data for signAndSubmit()
}

export interface SwapResult {
  orderId: string;
  status: 'fulfilled' | 'pending' | 'cancelled' | 'expired';
  executedBuyAmount?: string;
  executedSellAmount?: string;
}

export interface SwapOrderSummary {
  orderId: string;
  sellToken: string;          // address
  buyToken: string;           // address
  sellAmount: string;         // raw
  buyAmount: string;          // raw
  executedSellAmount: string;
  executedBuyAmount: string;
  feeAmount: string;
  executedFeeAmount: string;
  gasCostETH?: string;        // gas cost in ETH (on-chain swaps)
  status: string;
  createdAt: string;          // ISO date string
  kind: string;
  validTo: number;
}

export interface SwapProvider {
  id: string;
  displayName: string;

  /** Get a swap quote. amount is raw bigint string (sellAmountBeforeFee for sell, buyAmountAfterFee for buy) */
  getQuote(params: {
    sellToken: string;
    buyToken: string;
    amount: string;
    kind: 'sell' | 'buy';
    from: string;
    network: Network;
  }): Promise<SwapQuote>;

  /** Address that needs ERC-20 approval (e.g. CoW vault relayer) */
  getApprovalAddress(network: Network): string;

  /** Sign and submit the order. Returns the order UID/ID. */
  signAndSubmit(quote: SwapQuote, network: Network): Promise<string>;

  /** Poll until the order reaches a terminal state */
  pollUntilDone(orderId: string, network: Network): Promise<SwapResult>;

  /** Get recent order history */
  getHistory(network: Network): Promise<SwapOrderSummary[]>;

  /** Get a single order's details */
  getOrderStatus(orderId: string, network: Network): Promise<SwapOrderSummary>;
}

// ── Bridge Provider ──────────────────────────────────

export interface BridgeQuote {
  provider: string;           // 'debridge' | 'lifi'
  srcChainId: string;
  dstChainId: string;
  srcAmount: string;          // raw amount string (what user sends)
  dstAmount: string;          // raw amount string (recommended, what user receives)
  dstDecimals: number;
  estimatedTime: number;      // seconds
  protocolFeeRaw: string;     // tx.value for EVM source (includes protocol fee)
  orderId: string;
  contractAddress: string | null; // EVM: target contract address
  _raw: unknown;              // opaque provider data for execute
}

export interface BridgeResult {
  orderId: string;
  status: 'fulfilled' | 'pending' | 'failed';
  dstTxHash?: string;
}

export interface BridgeOrderSummary {
  orderId: string;
  srcChainId: number;
  dstChainId: number;
  srcToken: string;
  dstToken: string;
  srcAmount: string;
  srcDecimals: number;
  dstAmount: string;
  dstDecimals: number;
  status: string;
  createdAt: number;          // unix timestamp
  srcTxHash?: string;
  dstTxHash?: string;
}

export type BridgeDirection = 'evm-to-solana' | 'solana-to-evm';

export interface BridgeProvider {
  id: string;
  displayName: string;

  /** Known contract addresses for source-chain validation */
  knownContracts: Set<string>;

  /** Get a bridge quote + transaction data */
  getQuote(params: {
    srcChainId: string;
    dstChainId: string;
    srcToken: string;
    dstToken: string;
    amount: string;
    srcAddress: string;
    dstAddress: string;
  }): Promise<BridgeQuote>;

  /** Get the contract address from the quote that needs ERC-20 approval (null if none) */
  getApprovalAddress(quote: BridgeQuote): string | null;

  /** Get the raw transaction data from a quote (for command to send) */
  getTxData(quote: BridgeQuote): { data: string; to?: string; value?: string };

  /** Poll for destination chain fulfillment */
  pollFulfillment(orderId: string): Promise<BridgeResult>;

  /** Get recent bridge order history */
  getHistory(makerAddress: string, solanaAddress?: string): Promise<BridgeOrderSummary[]>;

  /** Get a single order's details */
  getOrderStatus(orderId: string): Promise<BridgeOrderSummary & {
    makerSrc?: string;
    receiverDst?: string;
    srcTxHash?: string;
    dstTxHash?: string;
  }>;
}

// ── Offramp Provider ────────────────────────────────

export interface OfframpBankAccount {
  id: string;
  label: string;        // display name (institution + last 4)
  institution?: string;
  accountNumber?: string;
  type?: string;         // checking, savings, etc.
}

export interface OfframpQuote {
  provider: string;
  amount: string;              // USDC amount (human-readable)
  amountRaw: string;           // raw amount (wei/smallest unit)
  bankAccountId: string;
  bankAccountLabel: string;
  fee?: string;                // fee description
  estimatedTime?: string;      // e.g. "1 business day"
  txParams: {                  // on-chain tx parameters
    to: string;
    data: string;
    value?: string;
    gasLimit?: string;
  };
  _raw: unknown;
}

export interface OfframpOrderSummary {
  id: string;
  amount: string;         // human-readable
  status: string;
  createdAt: string;      // ISO date
  provider: string;
}

export interface OfframpProvider {
  id: string;
  displayName: string;

  /** Check if provider is configured (API keys set, etc.) */
  isConfigured(): boolean;

  /** List linked bank accounts / payout destinations */
  listAccounts(): Promise<OfframpBankAccount[]>;

  /** Get a quote / build transaction for withdrawal */
  getQuote(params: {
    amount: string;
    bankAccountId: string;
    tokenAddress: string;
    network: string;
  }): Promise<OfframpQuote>;

  /** Get recent withdrawal history */
  getHistory(): Promise<OfframpOrderSummary[]>;
}

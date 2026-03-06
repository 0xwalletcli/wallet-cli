import { LIFI_CONFIG, ETHERSCAN_API, ETHERSCAN_CHAIN_ID, HISTORY_LIMIT } from '../../config.js';
import type { BridgeProvider, BridgeQuote, BridgeResult, BridgeOrderSummary } from '../types.js';
import { registerBridgeProvider } from '../registry.js';

// ── LI.FI API types ─────────────────────────────────

interface LifiQuoteResponse {
  id: string;
  type: string;
  tool: string;
  action: {
    fromToken: { address: string; symbol: string; decimals: number; chainId: number };
    toToken: { address: string; symbol: string; decimals: number; chainId: number };
    fromAmount: string;
    slippage: number;
    fromChainId: number;
    toChainId: number;
  };
  estimate: {
    fromAmount: string;
    toAmount: string;
    toAmountMin: string;
    approvalAddress: string;
    executionDuration: number;
    gasCosts: { amountUSD: string }[];
    feeCosts: { amountUSD: string; percentage: string }[];
  };
  transactionRequest: {
    to: string;
    data: string;
    value: string;
    gasLimit?: string;
    from: string;
  };
}

interface LifiStatusResponse {
  status: 'NOT_FOUND' | 'INVALID' | 'PENDING' | 'DONE' | 'FAILED';
  substatus?: string;
  sending?: {
    txHash?: string;
    token?: { symbol: string; decimals: number; chainId: number };
    chainId?: number;
    amount?: string;
    timestamp?: number;
  };
  receiving?: {
    txHash?: string;
    token?: { symbol: string; decimals: number; chainId: number };
    chainId?: number;
    amount?: string;
    timestamp?: number;
  };
  fromAddress?: string;
  toAddress?: string;
  tool?: string;
}

const LIFI_DIAMOND = '0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae';

// ── Helpers ──────────────────────────────────────────

function getApiHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  const key = process.env.LIFI_API_KEY;
  if (key) headers['x-lifi-api-key'] = key;
  return headers;
}

// LI.FI chain IDs
function lifiChainId(chainId: string): string {
  // deBridge uses '7565164' for Solana, LI.FI uses '1151111081099710'
  if (chainId === '7565164') return String(LIFI_CONFIG.solanaChainId);
  return chainId;
}

/** Convert LI.FI chain ID back to our standard chain ID */
function fromLifiChainId(chainId: number): number {
  if (chainId === LIFI_CONFIG.solanaChainId) return 7565164;
  return chainId;
}

// LI.FI uses 0xEeee...EEeE for native ETH; deBridge uses 0x0000...0000
const NATIVE_ETH_ZERO = '0x0000000000000000000000000000000000000000';
const NATIVE_ETH_LIFI = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';

/** Translate deBridge native ETH address to LI.FI format */
function toLifiNativeToken(token: string, chainId: string): string {
  if ((chainId === '1' || chainId === '8453') && token.toLowerCase() === NATIVE_ETH_ZERO.toLowerCase()) {
    return NATIVE_ETH_LIFI;
  }
  return token;
}

/** Query LI.FI /status by txHash */
async function fetchLifiStatus(txHash: string): Promise<LifiStatusResponse> {
  const params = new URLSearchParams({ txHash });
  const res = await fetch(`${LIFI_CONFIG.api}/status?${params}`, {
    headers: getApiHeaders(),
  });
  if (!res.ok) throw new Error(`LI.FI status failed: ${res.status}`);
  return (await res.json()) as LifiStatusResponse;
}

function lifiStatusToString(s: LifiStatusResponse): string {
  if (s.status === 'DONE') return 'fulfilled';
  if (s.status === 'FAILED') return 'failed';
  return 'pending';
}

// ── LI.FI Bridge Provider ────────────────────────────

const lifiBridgeProvider: BridgeProvider = {
  id: 'lifi',
  displayName: 'LI.FI',

  knownContracts: new Set([LIFI_DIAMOND]),

  async getQuote({ srcChainId, dstChainId, srcToken, dstToken, amount, srcAddress, dstAddress }) {
    const fromChain = lifiChainId(srcChainId);
    const toChain = lifiChainId(dstChainId);

    const params = new URLSearchParams({
      fromChain,
      toChain,
      fromToken: toLifiNativeToken(srcToken, srcChainId),
      toToken: toLifiNativeToken(dstToken, dstChainId),
      fromAmount: amount,
      fromAddress: srcAddress,
      toAddress: dstAddress,
      integrator: 'wallet-cli',
      slippage: '0.01',            // 1%
      maxPriceImpact: '0.02',     // 2% — filter unreliable high-impact routes
    });

    const res = await fetch(`${LIFI_CONFIG.api}/quote?${params}`, {
      headers: getApiHeaders(),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`LI.FI bridge quote failed: ${err}`);
    }

    const data = (await res.json()) as LifiQuoteResponse;
    const out = data.estimate;

    return {
      provider: 'lifi',
      srcChainId,
      dstChainId,
      srcAmount: amount,
      dstAmount: out.toAmount,
      dstDecimals: data.action.toToken.decimals,
      estimatedTime: out.executionDuration,
      protocolFeeRaw: data.transactionRequest.value || '0',
      orderId: data.id || '',
      contractAddress: data.transactionRequest.to || null,
      _raw: data,
    };
  },

  getApprovalAddress(quote: BridgeQuote): string | null {
    const data = quote._raw as LifiQuoteResponse;
    return data.estimate.approvalAddress || null;
  },

  getTxData(quote: BridgeQuote): { data: string; to?: string; value?: string } {
    const raw = quote._raw as LifiQuoteResponse;
    return {
      data: raw.transactionRequest.data,
      to: raw.transactionRequest.to,
      value: raw.transactionRequest.value,
    };
  },

  async pollFulfillment(txHash: string): Promise<BridgeResult> {
    // txHash is the source chain tx hash passed by the bridge command
    for (let i = 0; i < 120; i++) {
      await new Promise(r => setTimeout(r, 5000));
      try {
        const data = await fetchLifiStatus(txHash);
        if (data.status === 'DONE') {
          return {
            orderId: txHash,
            status: 'fulfilled',
            dstTxHash: data.receiving?.txHash,
          };
        }
        if (data.status === 'FAILED') {
          return { orderId: txHash, status: 'failed' };
        }
      } catch {
        // continue polling
      }
      process.stdout.write('.');
    }

    return { orderId: txHash, status: 'pending' };
  },

  async getHistory(makerAddress: string, _solanaAddress?: string): Promise<BridgeOrderSummary[]> {
    // Find LI.FI bridge txs via Etherscan (txs to the LI.FI Diamond proxy)
    const apiKey = process.env.ETHERSCAN_API_KEY;
    if (!apiKey) return [];

    const params = new URLSearchParams({
      chainid: ETHERSCAN_CHAIN_ID.mainnet,
      module: 'account',
      action: 'txlist',
      address: makerAddress,
      startblock: '0',
      endblock: '99999999',
      page: '1',
      offset: '50',
      sort: 'desc',
      apikey: apiKey,
    });

    const res = await fetch(`${ETHERSCAN_API}?${params}`);
    if (!res.ok) return [];

    const data = (await res.json()) as { status: string; result: { hash: string; to: string; isError: string }[] | string };
    if (data.status !== '1' || !Array.isArray(data.result)) return [];

    // Filter for successful txs to the LI.FI Diamond proxy
    const lifiTxs = data.result.filter(
      tx => tx.to?.toLowerCase() === LIFI_DIAMOND && tx.isError === '0',
    );

    if (lifiTxs.length === 0) return [];

    // Query LI.FI /status for each tx (cap to HISTORY_LIMIT to avoid rate limits)
    const recent = lifiTxs.slice(0, HISTORY_LIMIT);
    const statusResults = await Promise.allSettled(
      recent.map(tx => fetchLifiStatus(tx.hash)),
    );

    const orders: BridgeOrderSummary[] = [];
    for (let i = 0; i < statusResults.length; i++) {
      if (statusResults[i].status !== 'fulfilled') continue;
      const s = (statusResults[i] as PromiseFulfilledResult<LifiStatusResponse>).value;
      if (s.status === 'NOT_FOUND' || s.status === 'INVALID') continue;

      const srcChainId = fromLifiChainId(s.sending?.chainId || 1);
      const dstChainId = fromLifiChainId(s.receiving?.chainId || 1);

      orders.push({
        orderId: recent[i].hash,
        srcChainId,
        dstChainId,
        srcToken: s.sending?.token?.symbol || '?',
        dstToken: s.receiving?.token?.symbol || '?',
        srcAmount: s.sending?.amount || '0',
        srcDecimals: s.sending?.token?.decimals || 0,
        dstAmount: s.receiving?.amount || '0',
        dstDecimals: s.receiving?.token?.decimals || 0,
        status: lifiStatusToString(s),
        createdAt: s.sending?.timestamp || 0,
        srcTxHash: s.sending?.txHash,
        dstTxHash: s.receiving?.txHash,
      });
    }

    return orders;
  },

  async getOrderStatus(txHash: string) {
    // txHash can be the source tx hash or LI.FI step ID
    const s = await fetchLifiStatus(txHash);
    if (s.status === 'NOT_FOUND' || s.status === 'INVALID') {
      throw new Error(`Order not found: ${txHash}`);
    }

    const srcChainId = fromLifiChainId(s.sending?.chainId || 1);
    const dstChainId = fromLifiChainId(s.receiving?.chainId || 1);

    return {
      orderId: txHash,
      srcChainId,
      dstChainId,
      srcToken: s.sending?.token?.symbol || '?',
      dstToken: s.receiving?.token?.symbol || '?',
      srcAmount: s.sending?.amount || '0',
      srcDecimals: s.sending?.token?.decimals || 0,
      dstAmount: s.receiving?.amount || '0',
      dstDecimals: s.receiving?.token?.decimals || 0,
      status: lifiStatusToString(s),
      createdAt: s.sending?.timestamp || 0,
      srcTxHash: s.sending?.txHash,
      dstTxHash: s.receiving?.txHash,
      makerSrc: s.fromAddress,
      receiverDst: s.toAddress,
    };
  },
};

// Auto-register
registerBridgeProvider(lifiBridgeProvider);

export { lifiBridgeProvider };

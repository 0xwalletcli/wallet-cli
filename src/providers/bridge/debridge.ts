import { DEBRIDGE_CONFIG } from '../../config.js';
import type { BridgeProvider, BridgeQuote, BridgeResult, BridgeOrderSummary } from '../types.js';
import { registerBridgeProvider } from '../registry.js';

// ── deBridge API types ───────────────────────────────

interface CreateTxResponse {
  estimation: {
    srcChainTokenIn: { amount: string; decimals: number; symbol: string };
    srcChainTokenOut: { amount: string; decimals: number; symbol: string };
    dstChainTokenOut: { amount: string; decimals: number; symbol: string; recommendedAmount: string };
    costsDetails: unknown[];
  };
  tx: {
    data: string;
    to?: string;    // EVM source only
    value?: string; // EVM source only
  };
  orderId: string;
  order: {
    approximateFulfillmentDelay: number;
  };
}

/** deBridge wraps large values as objects with multiple representations */
type DbValue = number | string | { bigIntegerValue?: number; stringValue?: string };

/** Extract a numeric value from a deBridge wrapped field */
function dbNum(v: DbValue): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') return Number(v);
  if (v && typeof v === 'object') return v.bigIntegerValue ?? Number(v.stringValue ?? 0);
  return 0;
}

/** Extract a string value from a deBridge wrapped field */
function dbStr(v: DbValue): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (v && typeof v === 'object') return v.stringValue ?? String(v.bigIntegerValue ?? '');
  return '';
}

interface DeBridgeOrderResponse {
  orderId: { stringValue?: string };
  state: string;
  creationTimestamp?: number; // deprecated, may be absent
  giveOfferWithMetadata: { chainId: DbValue; amount: DbValue; decimals: number; symbol: string };
  takeOfferWithMetadata: { chainId: DbValue; amount: DbValue; decimals: number; symbol: string };
  createEventTransactionHash?: DbValue; // wrapped object in list, absent in single
  createdSrcEventMetadata?: { transactionHash?: DbValue; blockTimeStamp?: number };
  fulfilledDstEventMetadata?: { transactionHash?: DbValue };
  makerSrc?: string;
  receiverDst?: string;
}

// ── Known DLN contract addresses (source chain) ─────

const KNOWN_DLN_CONTRACTS: Set<string> = new Set([
  '0xeF4fB24aD0916217251F553c0596F8Edc630EB66'.toLowerCase(), // DlnSource v1
  '0xe7351Fd770A37282b91D153Ee690B63579D6dd7f'.toLowerCase(), // DlnSource v1.1
  '0xD8255B22ef02B1BcA0e4D86E2D0FE84FA0199e28'.toLowerCase(), // DlnSource v1.2
]);

// ── deBridge Bridge Provider ─────────────────────────

const debridgeProvider: BridgeProvider = {
  id: 'debridge',
  displayName: 'deBridge',

  knownContracts: KNOWN_DLN_CONTRACTS,

  async getQuote({ srcChainId, dstChainId, srcToken, dstToken, amount, srcAddress, dstAddress }) {
    const db = DEBRIDGE_CONFIG;
    const params = new URLSearchParams({
      srcChainId,
      srcChainTokenIn: srcToken,
      srcChainTokenInAmount: amount,
      dstChainId,
      dstChainTokenOut: dstToken,
      dstChainTokenOutAmount: 'auto',
      dstChainTokenOutRecipient: dstAddress,
      senderAddress: srcAddress,
      srcChainOrderAuthorityAddress: srcAddress,
      dstChainOrderAuthorityAddress: dstAddress,
      enableEstimate: 'false',
    });

    const res = await fetch(`${db.api}/dln/order/create-tx?${params}`);
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`deBridge quote failed: ${err}`);
    }

    const data = (await res.json()) as CreateTxResponse;
    const out = data.estimation.dstChainTokenOut;
    const dstAmount = out.recommendedAmount || out.amount;

    return {
      provider: 'debridge',
      srcChainId,
      dstChainId,
      srcAmount: amount,
      dstAmount,
      dstDecimals: out.decimals,
      estimatedTime: data.order.approximateFulfillmentDelay,
      protocolFeeRaw: data.tx.value || '0',
      orderId: data.orderId,
      contractAddress: data.tx.to || null,
      _raw: data,
    };
  },

  getApprovalAddress(quote: BridgeQuote): string | null {
    const data = quote._raw as CreateTxResponse;
    return data.tx.to || null;
  },

  getTxData(quote: BridgeQuote): { data: string; to?: string; value?: string } {
    const raw = quote._raw as CreateTxResponse;
    return {
      data: raw.tx.data,
      to: raw.tx.to,
      value: raw.tx.value,
    };
  },

  async pollFulfillment(orderId: string): Promise<BridgeResult> {
    const db = DEBRIDGE_CONFIG;

    for (let i = 0; i < 60; i++) {
      await new Promise(r => setTimeout(r, 5000));
      try {
        const res = await fetch(`${db.statusApi}/Orders/${orderId}`);
        if (!res.ok) continue;
        const order = (await res.json()) as { status: string; fulfillTx?: { txHash?: string } };
        if (['Fulfilled', 'SentUnlock', 'ClaimedUnlock'].includes(order.status)) {
          return {
            orderId,
            status: 'fulfilled',
            dstTxHash: order.fulfillTx?.txHash,
          };
        }
      } catch {
        // continue polling
      }
      process.stdout.write('.');
    }

    return { orderId, status: 'pending' };
  },

  async getHistory(makerAddress: string, solanaAddress?: string): Promise<BridgeOrderSummary[]> {
    const db = DEBRIDGE_CONFIG;

    const res = await fetch(`${db.statusApi}/Orders/filteredList`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ maker: makerAddress, skip: 0, take: 10 }),
    });

    if (!res.ok) throw new Error(`Failed to fetch orders: ${await res.text()}`);

    const data = (await res.json()) as { orders?: DeBridgeOrderResponse[] };
    const orders = data.orders || [];

    // Also query by Solana address if available
    if (solanaAddress) {
      try {
        const solRes = await fetch(`${db.statusApi}/Orders/filteredList`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ maker: solanaAddress, skip: 0, take: 10 }),
        });
        if (solRes.ok) {
          const solData = (await solRes.json()) as { orders?: DeBridgeOrderResponse[] };
          if (solData.orders) {
            const existing = new Set(orders.map(o => o.orderId.stringValue));
            for (const o of solData.orders) {
              if (!existing.has(o.orderId.stringValue)) {
                orders.push(o);
              }
            }
          }
        }
      } catch { /* ignore */ }
    }

    orders.sort((a, b) => (b.createdSrcEventMetadata?.blockTimeStamp ?? b.creationTimestamp ?? 0) - (a.createdSrcEventMetadata?.blockTimeStamp ?? a.creationTimestamp ?? 0));

    return orders.map(o => ({
      orderId: o.orderId.stringValue || '',
      srcChainId: dbNum(o.giveOfferWithMetadata.chainId),
      dstChainId: dbNum(o.takeOfferWithMetadata.chainId),
      srcToken: o.giveOfferWithMetadata.symbol,
      dstToken: o.takeOfferWithMetadata.symbol,
      srcAmount: dbStr(o.giveOfferWithMetadata.amount),
      srcDecimals: o.giveOfferWithMetadata.decimals,
      dstAmount: dbStr(o.takeOfferWithMetadata.amount),
      dstDecimals: o.takeOfferWithMetadata.decimals,
      status: o.state,
      createdAt: o.createdSrcEventMetadata?.blockTimeStamp ?? o.creationTimestamp ?? 0,
      srcTxHash: o.createdSrcEventMetadata?.transactionHash ? dbStr(o.createdSrcEventMetadata.transactionHash) : (o.createEventTransactionHash ? dbStr(o.createEventTransactionHash) : undefined),
      dstTxHash: o.fulfilledDstEventMetadata?.transactionHash ? dbStr(o.fulfilledDstEventMetadata.transactionHash) : undefined,
    }));
  },

  async getOrderStatus(orderId: string) {
    const db = DEBRIDGE_CONFIG;

    const res = await fetch(`${db.statusApi}/Orders/${orderId}`);
    if (!res.ok) throw new Error(`Order not found: ${await res.text()}`);

    const o = (await res.json()) as DeBridgeOrderResponse;

    return {
      orderId: o.orderId.stringValue || orderId,
      srcChainId: dbNum(o.giveOfferWithMetadata.chainId),
      dstChainId: dbNum(o.takeOfferWithMetadata.chainId),
      srcToken: o.giveOfferWithMetadata.symbol,
      dstToken: o.takeOfferWithMetadata.symbol,
      srcAmount: dbStr(o.giveOfferWithMetadata.amount),
      srcDecimals: o.giveOfferWithMetadata.decimals,
      dstAmount: dbStr(o.takeOfferWithMetadata.amount),
      dstDecimals: o.takeOfferWithMetadata.decimals,
      status: o.state,
      createdAt: o.createdSrcEventMetadata?.blockTimeStamp ?? o.creationTimestamp ?? 0,
      srcTxHash: o.createdSrcEventMetadata?.transactionHash ? dbStr(o.createdSrcEventMetadata.transactionHash) : (o.createEventTransactionHash ? dbStr(o.createEventTransactionHash) : undefined),
      dstTxHash: o.fulfilledDstEventMetadata?.transactionHash ? dbStr(o.fulfilledDstEventMetadata.transactionHash) : undefined,
      makerSrc: o.makerSrc,
      receiverDst: o.receiverDst,
    };
  },
};

// Auto-register
registerBridgeProvider(debridgeProvider);

export { debridgeProvider };

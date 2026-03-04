import type { Network } from '../../config.js';
import { COW_CONFIG } from '../../config.js';
import { resolveSigner } from '../../signers/index.js';
import type { SwapProvider, SwapQuote, SwapResult, SwapOrderSummary } from '../types.js';
import { registerSwapProvider } from '../registry.js';

// ── CoW API types ────────────────────────────────────

interface CowQuoteResponse {
  quote: {
    sellToken: string;
    buyToken: string;
    sellAmount: string;
    buyAmount: string;
    feeAmount: string;
    validTo: number;
    kind: string;
    partiallyFillable: boolean;
    appData: string;
  };
  id: number;
}

interface CowOrderResponse {
  uid: string;
  sellToken: string;
  buyToken: string;
  sellAmount: string;
  buyAmount: string;
  executedSellAmount: string;
  executedBuyAmount: string;
  feeAmount: string;
  executedFeeAmount: string;
  status: string;
  creationDate: string;
  kind: string;
  validTo: number;
}

// ── EIP-712 types (shared across all CoW operations) ─

const COW_EIP712_TYPES = {
  Order: [
    { name: 'sellToken', type: 'address' },
    { name: 'buyToken', type: 'address' },
    { name: 'receiver', type: 'address' },
    { name: 'sellAmount', type: 'uint256' },
    { name: 'buyAmount', type: 'uint256' },
    { name: 'validTo', type: 'uint32' },
    { name: 'appData', type: 'bytes32' },
    { name: 'feeAmount', type: 'uint256' },
    { name: 'kind', type: 'string' },
    { name: 'partiallyFillable', type: 'bool' },
    { name: 'sellTokenBalance', type: 'string' },
    { name: 'buyTokenBalance', type: 'string' },
  ],
} as const;

function getCowDomain(network: Network) {
  const cow = COW_CONFIG[network];
  return {
    name: 'Gnosis Protocol',
    version: 'v2',
    chainId: cow.chainId,
    verifyingContract: cow.settlement,
  } as const;
}

// ── CoW Swap Provider ────────────────────────────────

const cowSwapProvider: SwapProvider = {
  id: 'cow',
  displayName: 'CoW Swap',

  async getQuote({ sellToken, buyToken, amount, kind, from, network }) {
    const cow = COW_CONFIG[network];

    const body: Record<string, unknown> = {
      sellToken,
      buyToken,
      from,
      kind,
      validFor: 300,
      appData: '0x0000000000000000000000000000000000000000000000000000000000000000',
    };

    if (kind === 'sell') {
      body.sellAmountBeforeFee = amount;
    } else {
      body.buyAmountAfterFee = amount;
    }

    const res = await fetch(`${cow.api}/api/v1/quote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`CoW quote failed: ${err}`);
    }

    const data = (await res.json()) as CowQuoteResponse;
    const q = data.quote;

    return {
      provider: 'cow',
      sellToken: q.sellToken,
      buyToken: q.buyToken,
      sellAmount: q.sellAmount,
      buyAmount: q.buyAmount,
      feeAmount: q.feeAmount,
      validTo: q.validTo,
      kind: kind,
      gasless: true,
      appData: q.appData,
      _raw: data,
    };
  },

  getApprovalAddress(network: Network): string {
    return COW_CONFIG[network].vaultRelayer;
  },

  async signAndSubmit(quote: SwapQuote, network: Network): Promise<string> {
    const signer = await resolveSigner();
    const account = await signer.getEvmAccount();
    const cow = COW_CONFIG[network];
    const domain = getCowDomain(network);

    const orderData = {
      sellToken: quote.sellToken as `0x${string}`,
      buyToken: quote.buyToken as `0x${string}`,
      receiver: account.address,
      sellAmount: BigInt(quote.sellAmount),
      buyAmount: BigInt(quote.buyAmount),
      validTo: quote.validTo,
      appData: quote.appData as `0x${string}`,
      feeAmount: BigInt(0),
      kind: quote.kind,
      partiallyFillable: false,
      sellTokenBalance: 'erc20',
      buyTokenBalance: 'erc20',
    } as const;

    console.log('  Signing CoW Swap order...');
    const signature = await account.signTypedData({
      domain,
      types: COW_EIP712_TYPES,
      primaryType: 'Order',
      message: orderData,
    });

    console.log('  Submitting to CoW Swap...');
    const orderBody = {
      sellToken: quote.sellToken,
      buyToken: quote.buyToken,
      receiver: account.address,
      sellAmount: quote.sellAmount,
      buyAmount: quote.buyAmount,
      validTo: quote.validTo,
      appData: quote.appData,
      feeAmount: '0',
      kind: quote.kind,
      partiallyFillable: false,
      sellTokenBalance: 'erc20',
      buyTokenBalance: 'erc20',
      signingScheme: 'eip712',
      signature,
      from: account.address,
    };

    const orderRes = await fetch(`${cow.api}/api/v1/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(orderBody),
    });

    if (!orderRes.ok) {
      const err = await orderRes.text();
      throw new Error(`CoW order submission failed: ${err}`);
    }

    return (await orderRes.json()) as string;
  },

  async pollUntilDone(orderId: string, network: Network): Promise<SwapResult> {
    const cow = COW_CONFIG[network];

    for (let i = 0; i < 60; i++) {
      await new Promise(r => setTimeout(r, 5000));
      try {
        const res = await fetch(`${cow.api}/api/v1/orders/${orderId}`);
        if (!res.ok) continue;
        const order = (await res.json()) as CowOrderResponse;
        if (order.status === 'fulfilled') {
          return {
            orderId,
            status: 'fulfilled',
            executedBuyAmount: order.executedBuyAmount,
            executedSellAmount: order.executedSellAmount,
          };
        }
        if (order.status === 'cancelled') return { orderId, status: 'cancelled' };
        if (order.status === 'expired') return { orderId, status: 'expired' };
      } catch {
        // continue polling
      }
      process.stdout.write('.');
    }

    return { orderId, status: 'pending' };
  },

  async getHistory(network: Network): Promise<SwapOrderSummary[]> {
    const signer = await resolveSigner();
    const account = await signer.getEvmAccount();
    const cow = COW_CONFIG[network];

    const res = await fetch(`${cow.api}/api/v1/account/${account.address}/orders?limit=10`);
    if (!res.ok) throw new Error(`Failed to fetch orders: ${await res.text()}`);

    const orders = (await res.json()) as CowOrderResponse[];
    return orders.map(o => ({
      orderId: o.uid,
      sellToken: o.sellToken,
      buyToken: o.buyToken,
      sellAmount: o.sellAmount,
      buyAmount: o.buyAmount,
      executedSellAmount: o.executedSellAmount,
      executedBuyAmount: o.executedBuyAmount,
      feeAmount: o.feeAmount,
      executedFeeAmount: o.executedFeeAmount,
      status: o.status,
      createdAt: o.creationDate,
      kind: o.kind,
      validTo: o.validTo,
    }));
  },

  async getOrderStatus(orderId: string, network: Network): Promise<SwapOrderSummary> {
    const cow = COW_CONFIG[network];

    const res = await fetch(`${cow.api}/api/v1/orders/${orderId}`);
    if (!res.ok) throw new Error(`Order not found: ${await res.text()}`);

    const o = (await res.json()) as CowOrderResponse;
    return {
      orderId: o.uid,
      sellToken: o.sellToken,
      buyToken: o.buyToken,
      sellAmount: o.sellAmount,
      buyAmount: o.buyAmount,
      executedSellAmount: o.executedSellAmount,
      executedBuyAmount: o.executedBuyAmount,
      feeAmount: o.feeAmount,
      executedFeeAmount: o.executedFeeAmount,
      status: o.status,
      createdAt: o.creationDate,
      kind: o.kind,
      validTo: o.validTo,
    };
  },
};

// ── Cancel ────────────────────────────────────────────

const COW_CANCEL_TYPES = {
  OrderCancellation: [
    { name: 'orderUid', type: 'bytes' },
  ],
} as const;

export async function cancelCowOrder(orderId: string, network: Network): Promise<void> {
  const signer = await resolveSigner();
  const account = await signer.getEvmAccount();
  const domain = getCowDomain(network);
  const cow = COW_CONFIG[network];

  const signature = await account.signTypedData({
    domain,
    types: COW_CANCEL_TYPES,
    primaryType: 'OrderCancellation',
    message: { orderUid: orderId as `0x${string}` },
  });

  const res = await fetch(`${cow.api}/api/v1/orders/${orderId}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      signature,
      signingScheme: 'eip712',
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Cancel failed: ${err}`);
  }
}

// Auto-register
registerSwapProvider(cowSwapProvider);

export { cowSwapProvider };

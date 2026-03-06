import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type { Network } from '../../config.js';
import { TOKENS, UNISWAP_CONFIG, EXPLORERS, DEBRIDGE_CONFIG } from '../../config.js';

const NATIVE_ETH = DEBRIDGE_CONFIG.tokens.nativeETH;

/** Uniswap API expects 0x0000...0000 for native ETH, not WETH address */
function toUniswapToken(token: string, network: Network): string {
  return token.toLowerCase() === TOKENS[network].WETH.toLowerCase() ? NATIVE_ETH : token;
}
import { resolveSigner } from '../../signers/index.js';
import { getPublicClient, getWalletClient, getERC20Allowance, approveERC20, waitForReceipt, simulateTx } from '../../lib/evm.js';
import type { SwapProvider, SwapQuote, SwapResult, SwapOrderSummary } from '../types.js';
import { registerSwapProvider } from '../registry.js';

const STORAGE_DIR = join(homedir(), '.wallet-cli');
const ORDERS_FILE = 'uniswap-orders.json';

// ── Uniswap API types ────────────────────────────────

interface UniswapQuoteResponse {
  routing: 'CLASSIC' | 'DUTCH_V2' | 'DUTCH_V3' | 'DUTCH_LIMIT' | 'PRIORITY';
  quote: {
    // Classic format
    input?: { token: string; amount: string; chainId: number };
    output?: { token: string; amount: string; chainId: number };
    swapper?: string;
    slippage?: { tolerance: number };
    tradeType?: 'EXACT_INPUT' | 'EXACT_OUTPUT';
    gasFee?: string;
    gasFeeUSD?: string;
    routeString?: string;
    // UniswapX format
    encodedOrder?: string;
    orderId?: string;
    orderInfo?: {
      input: { token: string; startAmount: string; endAmount: string };
      outputs: { token: string; startAmount: string; endAmount: string; recipient: string }[];
    };
  };
  permitData?: {
    domain: Record<string, unknown>;
    types: Record<string, unknown[]>;
    values: Record<string, unknown>;
  };
  requestId?: string;
}

interface UniswapSwapResponse {
  swap: {
    to: string;
    data: string;
    value: string;
    gasLimit?: string;
  };
  gasFee?: string;
}

interface StoredOrder {
  orderId: string;
  sellToken: string;
  buyToken: string;
  sellAmount: string;
  buyAmount: string;
  status: string;
  kind: string;
  routing: string;
  createdAt: string;
  network: string;
  txHash?: string;
  gasCostETH?: string;
}

// ── Local order storage ──────────────────────────────

function loadOrders(): StoredOrder[] {
  try {
    return JSON.parse(readFileSync(join(STORAGE_DIR, ORDERS_FILE), 'utf-8'));
  } catch { return []; }
}

function saveOrder(order: StoredOrder) {
  mkdirSync(STORAGE_DIR, { recursive: true });
  const orders = loadOrders();
  orders.unshift(order);
  if (orders.length > 50) orders.length = 50;
  writeFileSync(join(STORAGE_DIR, ORDERS_FILE), JSON.stringify(orders, null, 2));
}

// ── Helpers ──────────────────────────────────────────

function getApiKey(): string {
  const key = process.env.UNISWAP_API_KEY;
  if (!key) throw new Error('UNISWAP_API_KEY not set in .env (get a free key at developers.uniswap.org)');
  return key;
}

function chainId(network: Network): number {
  return network === 'mainnet' ? 1 : 11155111;
}

// ── Uniswap Swap Provider ────────────────────────────

const uniswapSwapProvider: SwapProvider = {
  id: 'uniswap',
  displayName: 'Uniswap',

  async getQuote({ sellToken, buyToken, amount, kind, from, network }) {
    const apiKey = getApiKey();
    const chain = chainId(network);

    const body: Record<string, unknown> = {
      tokenIn: toUniswapToken(sellToken, network),
      tokenOut: toUniswapToken(buyToken, network),
      tokenInChainId: chain,
      tokenOutChainId: chain,
      swapper: from,
      slippageTolerance: 0.5,
      routingPreference: 'BEST_PRICE',
    };

    if (kind === 'sell') {
      body.type = 'EXACT_INPUT';
      body.amount = amount;
    } else {
      body.type = 'EXACT_OUTPUT';
      body.amount = amount;
    }

    const res = await fetch(`${UNISWAP_CONFIG.api}/quote`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Uniswap quote failed: ${err}`);
    }

    const data = (await res.json()) as UniswapQuoteResponse;
    const isClassic = data.routing === 'CLASSIC';

    let quoteSellToken: string, quoteBuyToken: string;
    let quoteSellAmount: string, quoteBuyAmount: string;
    let quoteFeeAmount: string;

    if (isClassic && data.quote.input && data.quote.output) {
      // Classic format: quote.input / quote.output
      // Note: gasFee is in wei (ETH), not sell token — gas is paid separately
      quoteSellToken = data.quote.input.token;
      quoteBuyToken = data.quote.output.token;
      quoteSellAmount = data.quote.input.amount;
      quoteBuyAmount = data.quote.output.amount;
      quoteFeeAmount = '0';
    } else {
      // UniswapX format: amounts in orderInfo
      const orderInfo = data.quote.orderInfo;
      quoteSellToken = sellToken;
      quoteBuyToken = buyToken;
      quoteSellAmount = orderInfo?.input?.startAmount || amount;
      quoteBuyAmount = orderInfo?.outputs?.[0]?.startAmount || '0';
      quoteFeeAmount = '0'; // UniswapX is gasless
    }

    return {
      provider: 'uniswap',
      sellToken: quoteSellToken,
      buyToken: quoteBuyToken,
      sellAmount: quoteSellAmount,
      buyAmount: quoteBuyAmount,
      feeAmount: quoteFeeAmount,
      gasFeeUSD: isClassic ? data.quote.gasFeeUSD : undefined,
      validTo: Math.floor(Date.now() / 1000) + 1800,
      kind,
      gasless: !isClassic,
      appData: data.routing,
      _raw: data,
    };
  },

  getApprovalAddress(_network: Network): string {
    // Uniswap uses Permit2 for all token approvals
    return UNISWAP_CONFIG.permit2;
  },

  async signAndSubmit(quote: SwapQuote, network: Network): Promise<string> {
    const apiKey = getApiKey();
    const signer = await resolveSigner();
    const account = await signer.getEvmAccount();
    const raw = quote._raw as UniswapQuoteResponse;

    if (raw.routing === 'CLASSIC') {
      // Classic: sign Permit2 data (if present), get swap calldata, simulate, send
      let currentQuote = raw.quote;
      let permitData = raw.permitData;
      let signature: string | undefined;

      if (permitData) {
        console.log('  Signing Permit2 approval...');
        signature = await account.signTypedData({
          domain: permitData.domain as any,
          types: permitData.types as any,
          primaryType: Object.keys(permitData.types).find(k => k !== 'EIP712Domain') || 'PermitSingle',
          message: permitData.values as any,
        });
      }

      const wallet = await getWalletClient(network);
      const explorer = EXPLORERS[network];
      const MAX_ATTEMPTS = 3;
      let lastError = '';

      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        if (attempt > 1) {
          // Fetch a fresh quote + re-sign permit on retry
          console.log(`  Retry ${attempt}/${MAX_ATTEMPTS}: fetching fresh quote...`);
          try {
            const freshRes = await fetch(`${UNISWAP_CONFIG.api}/quote`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
              body: JSON.stringify({
                tokenIn: toUniswapToken(quote.sellToken, network),
                tokenOut: toUniswapToken(quote.buyToken, network),
                tokenInChainId: chainId(network),
                tokenOutChainId: chainId(network),
                amount: quote.sellAmount,
                type: quote.kind === 'sell' ? 'EXACT_INPUT' : 'EXACT_OUTPUT',
                swapper: account.address,
                slippageTolerance: 0.5,
                routingPreference: 'BEST_PRICE',
              }),
            });
            if (freshRes.ok) {
              const freshData = (await freshRes.json()) as UniswapQuoteResponse;
              if (freshData.routing === 'CLASSIC') {
                currentQuote = freshData.quote;
                if (freshData.permitData) {
                  permitData = freshData.permitData;
                  signature = await account.signTypedData({
                    domain: permitData.domain as any,
                    types: permitData.types as any,
                    primaryType: Object.keys(permitData.types).find(k => k !== 'EIP712Domain') || 'PermitSingle',
                    message: permitData.values as any,
                  });
                }
              }
            }
          } catch { /* fall through with existing quote */ }
        } else {
          console.log('  Fetching swap calldata...');
        }

        const swapBody: Record<string, unknown> = {
          quote: currentQuote,
          simulateTransaction: false,
          deadline: Math.floor(Date.now() / 1000) + 600, // 10 min deadline
        };
        if (permitData && signature) {
          swapBody.permitData = permitData;
          swapBody.signature = signature;
        }

        const swapRes = await fetch(`${UNISWAP_CONFIG.api}/swap`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
          },
          body: JSON.stringify(swapBody),
        });

        if (!swapRes.ok) {
          const err = await swapRes.text();
          if (attempt < MAX_ATTEMPTS) {
            console.log(`  Swap API failed, retrying...`);
            lastError = err;
            continue;
          }
          throw new Error(`Uniswap swap failed: ${err}`);
        }

        const swapData = (await swapRes.json()) as UniswapSwapResponse;

        // Simulate — if it fails, retry with fresh quote
        try {
          await simulateTx(network, {
            account: account.address,
            to: swapData.swap.to as `0x${string}`,
            data: swapData.swap.data as `0x${string}`,
            value: BigInt(swapData.swap.value || '0'),
          });
        } catch (simErr: any) {
          lastError = simErr.message || 'simulation failed';
          if (attempt < MAX_ATTEMPTS) {
            console.log(`  Simulation failed, will retry with fresh quote...`);
            continue;
          }
          throw simErr;
        }

        // Simulation passed — send immediately
        console.log('  Sending transaction...');
        const { trackTx, clearTx } = await import('../../lib/txtracker.js');
        const hash = await wallet.sendTransaction({
          account,
          to: swapData.swap.to as `0x${string}`,
          data: swapData.swap.data as `0x${string}`,
          value: BigInt(swapData.swap.value || '0'),
        });

        trackTx(hash, 'evm', network);
        console.log(`  TX:  ${hash}`);
        console.log(`  URL: ${explorer.evm}/tx/${hash}`);
        console.log('  Waiting for confirmation...');
        const receipt = await waitForReceipt(network, hash);
        clearTx();

        const gasCostWei = receipt.gasUsed * receipt.effectiveGasPrice;
        const gasCostETH = (Number(gasCostWei) / 1e18).toFixed(8);

        saveOrder({
          orderId: hash,
          sellToken: quote.sellToken,
          buyToken: quote.buyToken,
          sellAmount: quote.sellAmount,
          buyAmount: quote.buyAmount,
          status: 'fulfilled',
          kind: quote.kind,
          routing: 'CLASSIC',
          createdAt: new Date().toISOString(),
          network,
          txHash: hash,
          gasCostETH,
        });

        return hash;
      }

      // Should never reach here (final attempt throws in the loop)
      throw new Error(`All ${MAX_ATTEMPTS} attempts failed: ${lastError}`);
    } else {
      // UniswapX: sign EIP-712 permit data, submit to filler network
      if (!raw.permitData) {
        throw new Error('UniswapX order missing permitData');
      }

      console.log('  Signing UniswapX order...');
      const signature = await account.signTypedData({
        domain: raw.permitData.domain as any,
        types: raw.permitData.types as any,
        primaryType: 'PermitWitnessTransferFrom',
        message: raw.permitData.values as any,
      });

      console.log('  Submitting to UniswapX filler network...');
      const orderBody: Record<string, unknown> = {
        signature,
        quote: raw.quote,
        routing: raw.routing,
      };

      const orderHeaders: Record<string, string> = {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
      };

      // Native ETH input requires this header
      const inputToken = raw.quote?.input?.token || raw.quote?.orderInfo?.input?.token || '';
      if (inputToken === '0x0000000000000000000000000000000000000000') {
        orderHeaders['x-erc20eth-enabled'] = 'true';
      }

      const orderRes = await fetch(`${UNISWAP_CONFIG.api}/order`, {
        method: 'POST',
        headers: orderHeaders,
        body: JSON.stringify(orderBody),
      });

      if (!orderRes.ok) {
        const err = await orderRes.text();
        throw new Error(`Uniswap order submission failed: ${err}`);
      }

      const { orderId } = (await orderRes.json()) as { orderId: string };

      saveOrder({
        orderId,
        sellToken: quote.sellToken,
        buyToken: quote.buyToken,
        sellAmount: quote.sellAmount,
        buyAmount: quote.buyAmount,
        status: 'pending',
        kind: quote.kind,
        routing: raw.routing,
        createdAt: new Date().toISOString(),
        network,
      });

      return orderId;
    }
  },

  async pollUntilDone(orderId: string, network: Network): Promise<SwapResult> {
    // For Classic swaps, the tx is already confirmed by signAndSubmit
    const orders = loadOrders();
    const stored = orders.find(o => o.orderId === orderId);
    if (stored?.routing === 'CLASSIC') {
      return { orderId, status: 'fulfilled' };
    }

    // For UniswapX, poll the order status
    // UniswapX orders fill quickly (Dutch auction), check for ~120 seconds
    const apiKey = getApiKey();
    for (let i = 0; i < 48; i++) {
      await new Promise(r => setTimeout(r, 2500));
      try {
        const res = await fetch(`${UNISWAP_CONFIG.api}/orders?orderId=${orderId}`, {
          headers: { 'x-api-key': apiKey },
        });
        if (!res.ok) continue;
        const data = (await res.json()) as {
          orders?: { orderStatus: string; settledAmounts?: { tokenIn: string; amountIn: string; tokenOut: string; amountOut: string }[] }[];
        };
        const order = data.orders?.[0];
        if (!order) continue;

        if (order.orderStatus === 'filled') {
          // Update local storage
          const orders = loadOrders();
          const idx = orders.findIndex(o => o.orderId === orderId);
          if (idx >= 0) {
            orders[idx].status = 'fulfilled';
            mkdirSync(STORAGE_DIR, { recursive: true });
            writeFileSync(join(STORAGE_DIR, ORDERS_FILE), JSON.stringify(orders, null, 2));
          }
          return {
            orderId,
            status: 'fulfilled',
            executedBuyAmount: order.settledAmounts?.[0]?.amountOut,
            executedSellAmount: order.settledAmounts?.[0]?.amountIn,
          };
        }
        if (order.orderStatus === 'expired') return { orderId, status: 'expired' };
        if (order.orderStatus === 'cancelled') return { orderId, status: 'cancelled' };
        if (order.orderStatus === 'error' || order.orderStatus === 'insufficient-funds') {
          return { orderId, status: 'cancelled' };
        }
      } catch {
        // continue
      }
      process.stdout.write('.');
    }

    return { orderId, status: 'pending' };
  },

  async getHistory(network: Network): Promise<SwapOrderSummary[]> {
    const orders = loadOrders().filter(o => o.network === network);

    // Refresh pending UniswapX orders against the API
    const pending = orders.filter(o => o.status === 'pending' && o.routing !== 'CLASSIC');
    if (pending.length > 0) {
      try {
        const apiKey = getApiKey();
        const allOrders = loadOrders();
        let changed = false;
        for (const p of pending) {
          try {
            const res = await fetch(`${UNISWAP_CONFIG.api}/orders?orderId=${p.orderId}`, {
              headers: { 'x-api-key': apiKey },
            });
            if (!res.ok) continue;
            const data = (await res.json()) as {
              orders?: { orderStatus: string }[];
            };
            const apiOrder = data.orders?.[0];
            if (!apiOrder) continue;
            const newStatus = apiOrder.orderStatus === 'filled' ? 'fulfilled'
              : apiOrder.orderStatus === 'expired' ? 'expired'
              : apiOrder.orderStatus === 'cancelled' ? 'cancelled'
              : apiOrder.orderStatus === 'error' || apiOrder.orderStatus === 'insufficient-funds' ? 'cancelled'
              : null;
            if (newStatus) {
              const idx = allOrders.findIndex(o => o.orderId === p.orderId);
              if (idx >= 0) {
                allOrders[idx].status = newStatus;
                p.status = newStatus;
                changed = true;
              }
            }
          } catch { /* skip individual failures */ }
        }
        if (changed) {
          mkdirSync(STORAGE_DIR, { recursive: true });
          writeFileSync(join(STORAGE_DIR, ORDERS_FILE), JSON.stringify(allOrders, null, 2));
        }
      } catch { /* don't fail history if refresh fails */ }
    }

    return orders.map(o => ({
      orderId: o.orderId,
      sellToken: o.sellToken,
      buyToken: o.buyToken,
      sellAmount: o.sellAmount,
      buyAmount: o.buyAmount,
      executedSellAmount: o.status === 'fulfilled' ? o.sellAmount : '0',
      executedBuyAmount: o.status === 'fulfilled' ? o.buyAmount : '0',
      feeAmount: '0',
      executedFeeAmount: '0',
      gasCostETH: o.gasCostETH,
      status: o.status,
      createdAt: o.createdAt,
      kind: o.kind,
      validTo: 0,
    }));
  },

  async getOrderStatus(orderId: string, _network: Network): Promise<SwapOrderSummary> {
    let orders = loadOrders();
    let o = orders.find(o => o.orderId === orderId);
    if (!o) throw new Error(`Order not found: ${orderId}`);

    // Refresh pending UniswapX orders from the API
    if (o.status === 'pending' && o.routing !== 'CLASSIC') {
      try {
        const apiKey = getApiKey();
        const res = await fetch(`${UNISWAP_CONFIG.api}/orders?orderId=${orderId}`, {
          headers: { 'x-api-key': apiKey },
        });
        if (res.ok) {
          const data = (await res.json()) as {
            orders?: { orderStatus: string; settledAmounts?: { tokenIn: string; amountIn: string; tokenOut: string; amountOut: string }[] }[];
          };
          const apiOrder = data.orders?.[0];
          if (apiOrder) {
            const newStatus = apiOrder.orderStatus === 'filled' ? 'fulfilled'
              : apiOrder.orderStatus === 'expired' ? 'expired'
              : apiOrder.orderStatus === 'cancelled' ? 'cancelled'
              : apiOrder.orderStatus === 'error' || apiOrder.orderStatus === 'insufficient-funds' ? 'cancelled'
              : null;
            if (newStatus) {
              orders = loadOrders();
              const idx = orders.findIndex(x => x.orderId === orderId);
              if (idx >= 0) {
                orders[idx].status = newStatus;
                mkdirSync(STORAGE_DIR, { recursive: true });
                writeFileSync(join(STORAGE_DIR, ORDERS_FILE), JSON.stringify(orders, null, 2));
                o = orders[idx];
              }
            }
          }
        }
      } catch { /* don't fail status check if API refresh fails */ }
    }

    return {
      orderId: o.orderId,
      sellToken: o.sellToken,
      buyToken: o.buyToken,
      sellAmount: o.sellAmount,
      buyAmount: o.buyAmount,
      executedSellAmount: o.status === 'fulfilled' ? o.sellAmount : '0',
      executedBuyAmount: o.status === 'fulfilled' ? o.buyAmount : '0',
      feeAmount: '0',
      executedFeeAmount: '0',
      gasCostETH: o.gasCostETH,
      status: o.status,
      createdAt: o.createdAt,
      kind: o.kind,
      validTo: 0,
    };
  },
};

// Auto-register
registerSwapProvider(uniswapSwapProvider);

export { uniswapSwapProvider };

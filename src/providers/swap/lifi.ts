import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type { Network } from '../../config.js';
import { LIFI_CONFIG, TOKENS, EXPLORERS, getEvmAccount } from '../../config.js';
import { getWalletClient, getERC20Allowance, approveERC20, waitForReceipt, simulateTx } from '../../lib/evm.js';
import type { SwapProvider, SwapQuote, SwapResult, SwapOrderSummary } from '../types.js';
import { registerSwapProvider } from '../registry.js';

const STORAGE_DIR = join(homedir(), '.wallet-cli');
const ORDERS_FILE = 'lifi-swap-orders.json';

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

interface StoredOrder {
  orderId: string;
  sellToken: string;
  buyToken: string;
  sellAmount: string;
  buyAmount: string;
  status: string;
  kind: string;
  tool: string;
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

function getApiHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  const key = process.env.LIFI_API_KEY;
  if (key) headers['x-lifi-api-key'] = key;
  return headers;
}

function chainId(network: Network): number {
  return network === 'mainnet' ? 1 : 11155111;
}

const NATIVE_ETH = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';

/** Replace WETH address with native ETH for LI.FI API calls */
function toNativeIfWeth(token: string, network: Network): string {
  return token.toLowerCase() === TOKENS[network].WETH.toLowerCase() ? NATIVE_ETH : token;
}

/** LI.FI SDK adds 300K gas buffer on top of estimates */
const GAS_BUFFER = 300_000n;

/** Max attempts to find a working route */
const MAX_ROUTE_ATTEMPTS = 4;

// ── LI.FI Swap Provider ─────────────────────────────

const lifiSwapProvider: SwapProvider = {
  id: 'lifi',
  displayName: 'LI.FI',

  async getQuote({ sellToken, buyToken, amount, kind, from, network }) {
    if (kind === 'buy') {
      throw new Error('LI.FI does not support ExactOutput (buy) orders — only sell orders are supported');
    }

    const chain = chainId(network);
    const params = new URLSearchParams({
      fromChain: String(chain),
      toChain: String(chain),
      fromToken: toNativeIfWeth(sellToken, network),
      toToken: toNativeIfWeth(buyToken, network),
      fromAmount: amount,
      fromAddress: from,
      toAddress: from,
      integrator: 'wallet-cli',
      slippage: '0.005',
    });

    const res = await fetch(`${LIFI_CONFIG.api}/quote?${params}`, {
      headers: getApiHeaders(),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`LI.FI quote failed: ${err}`);
    }

    const data = (await res.json()) as LifiQuoteResponse;
    const gasCostUsd = data.estimate.gasCosts?.reduce((s, c) => s + parseFloat(c.amountUSD || '0'), 0) || 0;

    return {
      provider: 'lifi',
      sellToken: data.action.fromToken.address,
      buyToken: data.action.toToken.address,
      sellAmount: data.estimate.fromAmount,
      buyAmount: data.estimate.toAmount,
      feeAmount: '0',
      gasFeeUSD: gasCostUsd > 0 ? String(gasCostUsd) : undefined,
      validTo: Math.floor(Date.now() / 1000) + 1800,
      kind,
      gasless: false,
      appData: data.tool,
      _raw: data,
    };
  },

  getApprovalAddress(network: Network): string {
    return '0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE';
  },

  async signAndSubmit(quote: SwapQuote, network: Network): Promise<string> {
    const account = getEvmAccount();
    const wallet = getWalletClient(network);
    const explorer = EXPLORERS[network];
    const origRaw = quote._raw as LifiQuoteResponse;
    const chain = chainId(network);

    // ── Smart route selection: simulate → deny failed exchanges → find working route ──
    //
    // Strategy:
    //   1. Fetch quote → simulate (free eth_call, no gas cost)
    //   2. If simulation fails → add that exchange to denyExchanges → try next route
    //   3. Once simulation passes → send immediately (Jumper-style, no delay)
    //
    // This finds a working route without wasting gas on reverts.
    // The LI.FI /quote endpoint always returns the "best output" route, which may
    // route through thin-liquidity pools (e.g., SushiSwap with 3.52% price impact).
    // Simulation catches these bad routes; denyExchanges forces LI.FI to pick alternatives
    // (e.g., KyberSwap with 0.08% impact).

    const deniedExchanges: string[] = [];
    let approvalDone = false;
    const slippage = origRaw.action.slippage || 0.005;

    for (let attempt = 0; attempt < MAX_ROUTE_ATTEMPTS; attempt++) {
      // Fetch fresh quote, denying exchanges that failed simulation
      if (attempt === 0) {
        console.log('  Fetching fresh quote...');
      } else {
        console.log(`  Trying alternative route (denied: ${deniedExchanges.join(', ')})...`);
      }

      const params = new URLSearchParams({
        fromChain: String(chain),
        toChain: String(chain),
        fromToken: toNativeIfWeth(origRaw.action.fromToken.address, network),
        toToken: toNativeIfWeth(origRaw.action.toToken.address, network),
        fromAmount: origRaw.action.fromAmount,
        fromAddress: account.address,
        toAddress: account.address,
        integrator: 'wallet-cli',
        slippage: String(slippage),
      });
      if (deniedExchanges.length > 0) {
        params.set('denyExchanges', deniedExchanges.join(','));
      }

      const refreshRes = await fetch(`${LIFI_CONFIG.api}/quote?${params}`, {
        headers: getApiHeaders(),
      });

      let raw: LifiQuoteResponse;
      if (refreshRes.ok) {
        raw = (await refreshRes.json()) as LifiQuoteResponse;
      } else if (attempt === 0) {
        console.log('  Could not refresh, using original quote.');
        raw = origRaw;
      } else {
        // No more routes available
        const err = await refreshRes.text();
        throw new Error(`No working route found (tried ${deniedExchanges.join(', ')}): ${err}`);
      }

      // Approve using this quote's approval address (once)
      if (!approvalDone) {
        const approvalAddr = raw.estimate.approvalAddress;
        const isNativeSell = raw.action.fromToken.address.toLowerCase() === NATIVE_ETH.toLowerCase()
          || quote.sellToken === '0x0000000000000000000000000000000000000000';
        if (approvalAddr && !isNativeSell) {
          const allowance = await getERC20Allowance(
            network,
            quote.sellToken as `0x${string}`,
            account.address,
            approvalAddr as `0x${string}`,
          );
          if (allowance < BigInt(raw.estimate.fromAmount)) {
            console.log(`  Approving ${approvalAddr} to spend tokens...`);
            await approveERC20(
              network,
              quote.sellToken as `0x${string}`,
              approvalAddr as `0x${string}`,
              BigInt(raw.estimate.fromAmount),
            );
          }
        }
        approvalDone = true;
      }

      // Build tx params with 300K gas buffer (matches LI.FI SDK)
      const txTo = raw.transactionRequest.to as `0x${string}`;
      const txData = raw.transactionRequest.data as `0x${string}`;
      const txValue = BigInt(raw.transactionRequest.value || '0');
      const txGas = raw.transactionRequest.gasLimit
        ? BigInt(raw.transactionRequest.gasLimit) + GAS_BUFFER
        : undefined;

      // Simulate FIRST (free eth_call — catches bad routes without spending gas)
      try {
        await simulateTx(network, {
          account: account.address,
          to: txTo,
          data: txData,
          value: txValue,
        });
      } catch (simErr: any) {
        // Simulation failed — this route doesn't work. Deny this exchange and try another.
        console.log(`  Route ${raw.tool} failed simulation — trying next route...`);
        if (!deniedExchanges.includes(raw.tool)) {
          deniedExchanges.push(raw.tool);
        }
        continue;
      }

      // Simulation passed — send immediately (no delay between sim and send)
      console.log(`  Sending transaction (route: ${raw.tool})...`);
      const { trackTx, clearTx } = await import('../../lib/txtracker.js');
      const txParams: Record<string, unknown> = {
        account,
        to: txTo,
        data: txData,
        value: txValue,
      };
      if (txGas) txParams.gas = txGas;

      const hash = await wallet.sendTransaction(txParams as any);

      trackTx(hash, 'evm', network);
      console.log(`  TX:  ${hash}`);
      console.log(`  URL: ${explorer.evm}/tx/${hash}`);
      console.log('  Waiting for confirmation...');

      try {
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
          tool: raw.tool,
          createdAt: new Date().toISOString(),
          network,
          txHash: hash,
          gasCostETH,
        });

        return hash;
      } catch (err: any) {
        clearTx();
        saveOrder({
          orderId: hash,
          sellToken: quote.sellToken,
          buyToken: quote.buyToken,
          sellAmount: quote.sellAmount,
          buyAmount: quote.buyAmount,
          status: 'reverted',
          kind: quote.kind,
          tool: raw.tool,
          createdAt: new Date().toISOString(),
          network,
          txHash: hash,
        });
        throw err;
      }
    }

    throw new Error(`No working route found after ${MAX_ROUTE_ATTEMPTS} attempts (denied: ${deniedExchanges.join(', ')})`);
  },

  async pollUntilDone(orderId: string, _network: Network): Promise<SwapResult> {
    return { orderId, status: 'fulfilled' };
  },

  async getHistory(network: Network): Promise<SwapOrderSummary[]> {
    const orders = loadOrders().filter(o => o.network === network);
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
    const orders = loadOrders();
    const o = orders.find(o => o.orderId === orderId);
    if (!o) throw new Error(`Order not found: ${orderId}`);
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
registerSwapProvider(lifiSwapProvider);

export { lifiSwapProvider };

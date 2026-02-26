import type { SwapProvider, BridgeProvider } from './types.js';

// ── Swap Providers ───────────────────────────────────

const swapProviders = new Map<string, SwapProvider>();

export function registerSwapProvider(provider: SwapProvider): void {
  swapProviders.set(provider.id, provider);
}

export function getSwapProvider(id: string): SwapProvider {
  const p = swapProviders.get(id);
  if (!p) throw new Error(`Unknown swap provider: ${id}. Available: ${[...swapProviders.keys()].join(', ')}`);
  return p;
}

export function listSwapProviders(): SwapProvider[] {
  return [...swapProviders.values()];
}

// ── Bridge Providers ─────────────────────────────────

const bridgeProviders = new Map<string, BridgeProvider>();

export function registerBridgeProvider(provider: BridgeProvider): void {
  bridgeProviders.set(provider.id, provider);
}

export function getBridgeProvider(id: string): BridgeProvider {
  const p = bridgeProviders.get(id);
  if (!p) throw new Error(`Unknown bridge provider: ${id}. Available: ${[...bridgeProviders.keys()].join(', ')}`);
  return p;
}

export function listBridgeProviders(): BridgeProvider[] {
  return [...bridgeProviders.values()];
}

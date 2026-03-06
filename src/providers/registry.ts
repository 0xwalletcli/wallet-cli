import type { SwapProvider, BridgeProvider, OfframpProvider } from './types.js';

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

// ── Offramp Providers ───────────────────────────────

const offrampProviders = new Map<string, OfframpProvider>();

export function registerOfframpProvider(provider: OfframpProvider): void {
  offrampProviders.set(provider.id, provider);
}

export function getOfframpProvider(id: string): OfframpProvider {
  const p = offrampProviders.get(id);
  if (!p) throw new Error(`Unknown offramp provider: ${id}. Available: ${[...offrampProviders.keys()].join(', ')}`);
  return p;
}

export function listOfframpProviders(): OfframpProvider[] {
  return [...offrampProviders.values()];
}

/** List only configured offramp providers (API keys set) */
export function listConfiguredOfframpProviders(): OfframpProvider[] {
  return [...offrampProviders.values()].filter(p => p.isConfigured());
}

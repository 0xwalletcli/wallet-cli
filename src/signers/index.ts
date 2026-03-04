import type { Signer } from './types.js';
import { EnvSigner } from './env.js';
import { loadConfig } from '../lib/config.js';

let _activeSigner: Signer | null = null;

/**
 * Resolve the active signer for this session.
 * Priority: explicit override > config.json > env (default).
 * Caches the result for the session lifetime.
 */
export async function resolveSigner(override?: string): Promise<Signer> {
  if (_activeSigner) return _activeSigner;

  const mode = override || loadConfig().signer || 'env';

  if (mode === 'walletconnect' || mode === 'wc') {
    const { loadWalletConnectSigner } = await import('./walletconnect.js');
    _activeSigner = await loadWalletConnectSigner();
  } else {
    _activeSigner = new EnvSigner();
  }

  return _activeSigner!;
}

/** Reset cached signer (used after connect/disconnect) */
export function resetSigner(): void {
  _activeSigner = null;
}

export type { Signer } from './types.js';

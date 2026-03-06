import type { Signer } from './types.js';
import type { LocalAccount, WalletClient, Chain, HttpTransport } from 'viem';
import type { Connection, VersionedTransaction, Transaction } from '@solana/web3.js';
import { EnvSigner } from './env.js';
import { loadConfig, getSignerConfig } from '../lib/config.js';

let _activeSigner: Signer | null = null;

/**
 * Per-chain signer: delegates EVM and Solana to independently configured signers.
 */
class PerChainSigner implements Signer {
  readonly type = 'perchain' as const;
  readonly label: string;

  constructor(private evmSigner: Signer, private solSigner: Signer) {
    if (evmSigner === solSigner) {
      this.label = evmSigner.label;
    } else {
      this.label = `EVM: ${evmSigner.label} | Solana: ${solSigner.label}`;
    }
  }

  getEvmAddress() { return this.evmSigner.getEvmAddress(); }
  getEvmAccount() { return this.evmSigner.getEvmAccount(); }
  getEvmWalletClient(chain: Chain, transport: HttpTransport) { return this.evmSigner.getEvmWalletClient(chain, transport); }

  getSolanaAddress() { return this.solSigner.getSolanaAddress(); }
  signSolanaVersionedTransaction(tx: VersionedTransaction) { return this.solSigner.signSolanaVersionedTransaction(tx); }
  signAndSendSolanaTransaction(conn: Connection, tx: Transaction) { return this.solSigner.signAndSendSolanaTransaction(conn, tx); }
}

/**
 * Resolve the active signer for this session.
 * Reads per-chain config from config.json. If not set, defaults to env.
 * Caches the result for the session lifetime.
 */
export async function resolveSigner(override?: string): Promise<Signer> {
  if (_activeSigner) return _activeSigner;

  const config = loadConfig();
  const sc = getSignerConfig(config);

  // Override applies to both chains (legacy CLI flag)
  const evmMode = override || sc.evm;
  const solMode = override || sc.solana;

  const envSigner = new EnvSigner();

  const resolveOne = async (mode: string, chain: 'evm' | 'solana'): Promise<Signer> => {
    if (mode === 'walletconnect' || mode === 'wc') {
      const { loadWalletConnectSigner } = await import('./walletconnect.js');
      return loadWalletConnectSigner();
    }
    if (mode === 'browser') {
      const { loadBrowserSession, loadEvmBrowserSession, BrowserSigner } = await import('./browser.js');
      const evmSession = loadEvmBrowserSession();
      const solSession = loadBrowserSession();
      if (chain === 'evm' && !evmSession) {
        console.error('  No EVM browser session. Run "wallet connect evm browser" first.\n');
        process.exit(1);
      }
      if (chain === 'solana' && !solSession) {
        console.error('  No Solana browser session. Run "wallet connect solana" first.\n');
        process.exit(1);
      }
      return new BrowserSigner(evmSession, solSession);
    }
    return envSigner;
  };

  const evmSigner = await resolveOne(evmMode, 'evm');
  const solSigner = evmMode === solMode ? evmSigner : await resolveOne(solMode, 'solana');

  if (evmSigner === solSigner) {
    _activeSigner = evmSigner;
  } else {
    _activeSigner = new PerChainSigner(evmSigner, solSigner);
  }

  return _activeSigner!;
}

/** Reset cached signer (used after connect/disconnect) */
export function resetSigner(): void {
  _activeSigner = null;
}

export type { Signer } from './types.js';

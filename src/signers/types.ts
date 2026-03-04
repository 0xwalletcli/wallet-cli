import type { LocalAccount, WalletClient, Chain, HttpTransport } from 'viem';
import type { Connection, VersionedTransaction, Transaction } from '@solana/web3.js';

export type SignerType = 'env' | 'walletconnect';

export interface Signer {
  readonly type: SignerType;
  readonly label: string;

  // ── Address access (no signing needed) ──
  getEvmAddress(): Promise<`0x${string}` | null>;
  getSolanaAddress(): Promise<string | null>;

  // ── EVM signing ──
  /** Returns a viem LocalAccount with signing methods (signTypedData, signMessage, etc.) */
  getEvmAccount(): Promise<LocalAccount>;
  /** Returns a WalletClient wired to this signer's account + chain */
  getEvmWalletClient(chain: Chain, transport: HttpTransport): Promise<WalletClient<HttpTransport, Chain, LocalAccount>>;

  // ── Solana signing ──
  /** Sign a VersionedTransaction (Jupiter, bridge) and return it ready to send */
  signSolanaVersionedTransaction(tx: VersionedTransaction): Promise<VersionedTransaction>;
  /** Sign and send a legacy Transaction, return the signature */
  signAndSendSolanaTransaction(conn: Connection, tx: Transaction): Promise<string>;
}

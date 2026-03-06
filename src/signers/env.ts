import { privateKeyToAccount } from 'viem/accounts';
import { createWalletClient, type LocalAccount, type Chain, type HttpTransport, type WalletClient } from 'viem';
import { Keypair, sendAndConfirmTransaction, type Connection, type VersionedTransaction, type Transaction } from '@solana/web3.js';
import bs58 from 'bs58';
import type { Signer } from './types.js';

export class EnvSigner implements Signer {
  readonly type = 'env' as const;
  readonly label = 'Environment Keys (.env)';

  async getEvmAddress(): Promise<`0x${string}` | null> {
    const key = process.env.EVM_PRIVATE_KEY;
    if (!key) return null;
    return privateKeyToAccount(key as `0x${string}`).address;
  }

  async getSolanaAddress(): Promise<string | null> {
    const key = process.env.SOLANA_PRIVATE_KEY;
    if (!key) return null;
    return Keypair.fromSecretKey(bs58.decode(key)).publicKey.toBase58();
  }

  async getEvmAccount(): Promise<LocalAccount> {
    const key = process.env.EVM_PRIVATE_KEY;
    if (!key) throw new Error('EVM_PRIVATE_KEY not set in .env — or use WalletConnect: wallet connect evm && wallet config set signer wc');
    return privateKeyToAccount(key as `0x${string}`);
  }

  async getEvmWalletClient(chain: Chain, transport: HttpTransport): Promise<WalletClient<HttpTransport, Chain, LocalAccount>> {
    const account = await this.getEvmAccount();
    return createWalletClient({ account, chain, transport });
  }

  async signSolanaVersionedTransaction(tx: VersionedTransaction): Promise<VersionedTransaction> {
    const keypair = this._getKeypair();
    tx.sign([keypair]);
    return tx;
  }

  async signAndSendSolanaTransaction(conn: Connection, tx: Transaction): Promise<string> {
    const keypair = this._getKeypair();
    return sendAndConfirmTransaction(conn, tx, [keypair]);
  }

  /** Get raw Solana Keypair (only available for EnvSigner) */
  getKeypair(): Keypair {
    return this._getKeypair();
  }

  private _getKeypair(): Keypair {
    const key = process.env.SOLANA_PRIVATE_KEY;
    if (!key) throw new Error('SOLANA_PRIVATE_KEY not set in .env — or use WalletConnect: wallet connect solana && wallet config set signer wc');
    return Keypair.fromSecretKey(bs58.decode(key));
  }
}

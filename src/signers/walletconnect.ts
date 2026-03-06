import { join } from 'path';
import { homedir } from 'os';
import { mkdirSync, writeFileSync, readFileSync, readdirSync, unlinkSync, existsSync } from 'fs';
import type { SignClient } from '@walletconnect/sign-client';
import qrcode from 'qrcode-terminal';
import { toAccount } from 'viem/accounts';
import { createWalletClient, type LocalAccount, type Chain, type HttpTransport, type WalletClient } from 'viem';
import { VersionedTransaction, Transaction, PublicKey, type Connection } from '@solana/web3.js';
import type { Signer } from './types.js';

// ── Constants ──

const SESSION_DIR = join(homedir(), '.wallet-cli', 'wc-sessions');
const RELAY_URL = 'wss://relay.walletconnect.com';

const EVM_CHAINS = ['eip155:1', 'eip155:11155111'] as const;
const SOL_CHAINS = [
  'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',   // mainnet
  'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',   // devnet
] as const;

// ── Session persistence ──

interface PersistedSession {
  topic: string;
  expiry: number;
  pairingTopic: string;
  evmAccounts: string[];
  solanaAccounts: string[];
  peerName: string;
}

export interface WcSessionInfo {
  peerName: string;
  evmAddress: string | null;
  solAddress: string | null;
  expiry: number;
}

function ensureSessionDir(): void {
  mkdirSync(SESSION_DIR, { recursive: true });
}

function saveSession(session: any): void {
  ensureSessionDir();
  const evm = session.namespaces?.eip155?.accounts ?? [];
  const sol = session.namespaces?.solana?.accounts ?? [];
  const data: PersistedSession = {
    topic: session.topic,
    expiry: session.expiry,
    pairingTopic: session.pairingTopic,
    evmAccounts: evm,
    solanaAccounts: sol,
    peerName: session.peer?.metadata?.name ?? 'Unknown Wallet',
  };
  writeFileSync(join(SESSION_DIR, `${session.topic}.json`), JSON.stringify(data, null, 2));
}

function loadSessions(): PersistedSession[] {
  ensureSessionDir();
  const files = readdirSync(SESSION_DIR).filter(f => f.endsWith('.json'));
  const sessions: PersistedSession[] = [];
  const now = Date.now() / 1000;
  for (const file of files) {
    try {
      const data = JSON.parse(readFileSync(join(SESSION_DIR, file), 'utf-8')) as PersistedSession;
      if (data.expiry > now) {
        sessions.push(data);
      } else {
        try { unlinkSync(join(SESSION_DIR, file)); } catch { /* ignore */ }
      }
    } catch { /* ignore malformed */ }
  }
  return sessions;
}

function deleteSession(topic: string): void {
  const path = join(SESSION_DIR, `${topic}.json`);
  if (existsSync(path)) {
    try { unlinkSync(path); } catch { /* ignore */ }
  }
}

// ── SignClient singleton ──

let _client: SignClient | null = null;

async function getClient(): Promise<SignClient> {
  if (_client) return _client;

  const projectId = process.env.WC_PROJECT_ID;
  if (!projectId) {
    throw new Error('WC_PROJECT_ID not set in .env — get a free ID at https://cloud.reown.com');
  }

  // Polyfill globalThis.crypto for Node 18 — WalletConnect's bundled @noble/hashes
  // checks crypto.getRandomValues at module evaluation time (before any user code runs).
  // Must be set before the dynamic import below.
  if (!globalThis.crypto || !(globalThis.crypto as any).getRandomValues) {
    const { webcrypto } = await import('node:crypto');
    (globalThis as any).crypto = webcrypto;
  }

  const { SignClient: SC } = await import('@walletconnect/sign-client');
  _client = await SC.init({
    projectId,
    relayUrl: RELAY_URL,
    logger: 'silent',
    metadata: {
      name: 'wallet-cli',
      description: 'DeFi wallet CLI',
      url: 'https://github.com/0xwalletcli/wallet-cli',
      icons: [],
    },
  });

  _client.on('session_delete', ({ topic }) => {
    deleteSession(topic);
  });

  _client.on('session_expire', ({ topic }) => {
    deleteSession(topic);
  });

  // Suppress unhandled errors from stale relay messages (e.g. session_update
  // for a topic that was deleted locally but still echoes on the relay).
  // Without this, the process crashes on "No matching key" errors.
  process.on('uncaughtException', (err: Error) => {
    if (err.message?.includes('No matching key')) return;
    throw err;
  });

  return _client;
}

// ── Connect / Disconnect ──

export async function connectWallet(chain?: string): Promise<void> {
  const projectId = process.env.WC_PROJECT_ID;
  if (!projectId) {
    console.error('  WC_PROJECT_ID not set in .env');
    console.error('  Get a free project ID at https://cloud.reown.com\n');
    process.exit(1);
  }

  // Solana is handled via browser bridge in connect.ts — this is EVM only
  const sessions = loadSessions();
  const hasEvm = sessions.some(s => s.evmAccounts.length > 0);

  if (chain === 'evm' || chain === 'ethereum' || chain === 'eth' || !chain) {
    if (hasEvm) {
      const evmSession = sessions.find(s => s.evmAccounts.length > 0)!;
      console.log(`  EVM already connected via ${evmSession.peerName}.`);
      console.log('  Run "wallet disconnect evm" first to reconnect.\n');
      return;
    }
  }

  console.log('  Connecting EVM via WalletConnect...\n');

  const optionalNamespaces = {
    eip155: {
      methods: ['eth_sendTransaction', 'personal_sign', 'eth_signTypedData_v4'],
      chains: [...EVM_CHAINS],
      events: ['chainChanged', 'accountsChanged'],
    },
  };

  const client = await getClient();

  const { uri, approval } = await client.connect({
    optionalNamespaces,
  });

  if (uri) {
    qrcode.generate(uri, { small: true }, (code: string) => {
      console.log(code);
    });
    console.log(`  URI: ${uri}\n`);

    const encoded = encodeURIComponent(uri);
    console.log('  Open directly:');
    console.log(`    MetaMask:  metamask://wc?uri=${encoded}`);
    console.log('');
    console.log('  Or scan the QR code with any WalletConnect-compatible wallet.');
    console.log('  Waiting for approval...\n');
  }

  let session: any;
  try {
    session = await Promise.race([
      approval(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Connection timed out (5 minutes)')), 5 * 60 * 1000)
      ),
    ]);
  } catch (err: any) {
    console.error(`  Connection failed: ${err.message}\n`);
    process.exit(1);
  }

  const evmAccts = session.namespaces?.eip155?.accounts ?? [];
  const evmAddr = evmAccts.length > 0 ? evmAccts[0].split(':').pop() : null;

  if (!evmAddr) {
    console.log('  Warning: wallet did not provide EVM accounts. Session not saved.\n');
    return;
  }

  saveSession(session);

  console.log('  Connected!\n');
  console.log(`  EVM:    ${evmAddr}`);
  console.log(`  Wallet: ${session.peer?.metadata?.name ?? 'Unknown'}`);
  console.log(`  Expiry: ${new Date(session.expiry * 1000).toLocaleDateString()}\n`);
  console.log('  Tip: run "wallet connect solana" to connect a Solana wallet via browser.\n');
}

export async function disconnectWallet(target?: string): Promise<void> {
  const sessions = loadSessions();
  if (sessions.length === 0) {
    console.log('  No active WalletConnect sessions.\n');
    return;
  }

  // Check if target is a chain filter
  const isChainFilter = target && ['evm', 'ethereum', 'eth', 'solana', 'sol'].includes(target.toLowerCase());
  const isEvmChain = target && ['evm', 'ethereum', 'eth'].includes(target.toLowerCase());

  let toDisconnect: PersistedSession[];

  if (isChainFilter) {
    // Filter sessions that have accounts on the target chain
    toDisconnect = isEvmChain
      ? sessions.filter(s => s.evmAccounts.length > 0)
      : sessions.filter(s => s.solanaAccounts.length > 0);
  } else if (target) {
    // Match by peer/wallet name
    toDisconnect = sessions.filter(s => s.peerName.toLowerCase().includes(target.toLowerCase()));
  } else {
    // No target — disconnect all
    toDisconnect = sessions;
  }

  if (target && toDisconnect.length === 0) {
    if (isChainFilter) {
      console.log(`  No ${isEvmChain ? 'EVM' : 'Solana'} sessions found.\n`);
    } else {
      console.log(`  No session matching "${target}".`);
      console.log(`  Active sessions: ${sessions.map(s => s.peerName).join(', ')}\n`);
    }
    return;
  }

  const client = await getClient();

  for (const session of toDisconnect) {
    try {
      await client.disconnect({
        topic: session.topic,
        reason: { code: 6000, message: 'User disconnected' },
      });
    } catch { /* session may already be dead */ }
    deleteSession(session.topic);
    console.log(`  Disconnected from ${session.peerName}.`);
  }
  console.log('');

  const { resetSigner } = await import('./index.js');
  resetSigner();
}

export function listWcSessions(): WcSessionInfo[] {
  return loadSessions().map(s => ({
    peerName: s.peerName,
    evmAddress: s.evmAccounts.length > 0 ? (s.evmAccounts[0].split(':').pop() ?? null) : null,
    solAddress: s.solanaAccounts.length > 0 ? (s.solanaAccounts[0].split(':').pop() ?? null) : null,
    expiry: s.expiry,
  }));
}

// ── WalletConnectSigner (merges multiple sessions) ──

export class WalletConnectSigner implements Signer {
  readonly type = 'walletconnect' as const;
  readonly label: string;

  private client: SignClient;
  private evmSession: PersistedSession | null;
  private solSession: PersistedSession | null;

  constructor(client: SignClient, sessions: PersistedSession[]) {
    this.client = client;
    this.evmSession = sessions.find(s => s.evmAccounts.length > 0) ?? null;
    this.solSession = sessions.find(s => s.solanaAccounts.length > 0) ?? null;

    const names = [...new Set(sessions.map(s => s.peerName))];
    this.label = `WalletConnect (${names.join(' + ')})`;
  }

  // ── Addresses ──

  async getEvmAddress(): Promise<`0x${string}` | null> {
    if (!this.evmSession) return null;
    const acct = this.evmSession.evmAccounts[0];
    if (!acct) return null;
    return acct.split(':').pop() as `0x${string}`;
  }

  async getSolanaAddress(): Promise<string | null> {
    if (!this.solSession) return null;
    const acct = this.solSession.solanaAccounts[0];
    if (!acct) return null;
    return acct.split(':').pop()!;
  }

  // ── EVM signing ──

  async getEvmAccount(): Promise<LocalAccount> {
    if (!this.evmSession) throw new Error('No EVM wallet connected. Run "wallet connect evm".');
    const address = (await this.getEvmAddress())!;

    const chainId = this.evmSession.evmAccounts[0].split(':').slice(0, 2).join(':');
    const client = this.client;
    const topic = this.evmSession.topic;

    return toAccount({
      address,

      async signMessage({ message }) {
        const msgHex = typeof message === 'string'
          ? `0x${Buffer.from(message).toString('hex')}`
          : typeof message === 'object' && 'raw' in message
            ? (typeof message.raw === 'string' ? message.raw : `0x${Buffer.from(message.raw).toString('hex')}`)
            : `0x${Buffer.from(message as any).toString('hex')}`;

        const result = await client.request<string>({
          topic,
          chainId,
          request: { method: 'personal_sign', params: [msgHex, address] },
        });
        return result as `0x${string}`;
      },

      async signTransaction(transaction) {
        const result = await client.request<string>({
          topic,
          chainId,
          request: { method: 'eth_signTransaction', params: [transaction] },
        });
        return result as `0x${string}`;
      },

      async signTypedData(typedData) {
        const result = await client.request<string>({
          topic,
          chainId,
          request: {
            method: 'eth_signTypedData_v4',
            params: [
              address,
              JSON.stringify({
                types: typedData.types,
                primaryType: typedData.primaryType,
                domain: typedData.domain,
                message: typedData.message,
              }),
            ],
          },
        });
        return result as `0x${string}`;
      },
    });
  }

  async getEvmWalletClient(chain: Chain, transport: HttpTransport): Promise<WalletClient<HttpTransport, Chain, LocalAccount>> {
    if (!this.evmSession) throw new Error('No EVM wallet connected. Run "wallet connect evm".');
    const account = await this.getEvmAccount();
    const walletClient = createWalletClient({ account, chain, transport });

    // Monkey-patch sendTransaction to use eth_sendTransaction via WC relay.
    // MetaMask doesn't support eth_signTransaction — it only supports
    // eth_sendTransaction which signs AND broadcasts from the wallet side.
    const address = account.address;
    const client = this.client;
    const topic = this.evmSession.topic;
    const chainId = this.evmSession.evmAccounts[0].split(':').slice(0, 2).join(':');

    const originalSendTransaction = walletClient.sendTransaction;
    walletClient.sendTransaction = (async (args: any) => {
      const txParams: Record<string, string | undefined> = {
        from: address,
        to: args.to,
        data: args.data || '0x',
        value: args.value ? `0x${args.value.toString(16)}` : '0x0',
      };
      if (args.gas) txParams.gas = `0x${args.gas.toString(16)}`;

      const hash = await client.request<string>({
        topic,
        chainId,
        request: { method: 'eth_sendTransaction', params: [txParams] },
      });
      return hash as `0x${string}`;
    }) as typeof originalSendTransaction;

    return walletClient;
  }

  // ── Solana signing ──

  async signSolanaVersionedTransaction(tx: VersionedTransaction): Promise<VersionedTransaction> {
    if (!this.solSession) throw new Error('No Solana wallet connected. Run "wallet connect solana".');
    const solAddr = (await this.getSolanaAddress())!;

    const serialized = Buffer.from(tx.serialize()).toString('base64');
    const chainId = this.solSession.solanaAccounts[0].split(':').slice(0, 2).join(':');

    const result = await this.client.request<{ signature: string } | string>({
      topic: this.solSession.topic,
      chainId,
      request: {
        method: 'solana_signTransaction',
        params: { transaction: serialized },
      },
    });

    if (typeof result === 'string') {
      return VersionedTransaction.deserialize(Buffer.from(result, 'base64'));
    }
    if (typeof result === 'object' && result.signature) {
      const sigBytes = Buffer.from(result.signature, 'base64');
      tx.signatures[0] = new Uint8Array(sigBytes);
      return tx;
    }
    throw new Error('Unexpected response format from wallet for solana_signTransaction');
  }

  async signAndSendSolanaTransaction(conn: Connection, tx: Transaction): Promise<string> {
    if (!this.solSession) throw new Error('No Solana wallet connected. Run "wallet connect solana".');
    const solAddr = (await this.getSolanaAddress())!;

    const feePayer = new PublicKey(solAddr);
    if (!tx.recentBlockhash) {
      const { blockhash } = await conn.getLatestBlockhash();
      tx.recentBlockhash = blockhash;
    }
    if (!tx.feePayer) {
      tx.feePayer = feePayer;
    }

    const serialized = tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64');
    const chainId = this.solSession.solanaAccounts[0].split(':').slice(0, 2).join(':');

    const result = await this.client.request<{ signature: string } | string>({
      topic: this.solSession.topic,
      chainId,
      request: {
        method: 'solana_signTransaction',
        params: { transaction: serialized },
      },
    });

    let signedTx: Transaction;
    if (typeof result === 'string') {
      signedTx = Transaction.from(Buffer.from(result, 'base64'));
    } else if (typeof result === 'object' && result.signature) {
      const sigBytes = Buffer.from(result.signature, 'base64');
      tx.addSignature(feePayer, Buffer.from(sigBytes));
      signedTx = tx;
    } else {
      throw new Error('Unexpected response format from wallet');
    }

    const signature = await conn.sendRawTransaction(signedTx.serialize());
    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash();
    await conn.confirmTransaction({ signature, blockhash, lastValidBlockHeight });
    return signature;
  }
}

// ── Factory (called by resolveSigner) ──

export async function loadWalletConnectSigner(): Promise<WalletConnectSigner> {
  const sessions = loadSessions();
  if (sessions.length === 0) {
    console.error('  No active WalletConnect sessions.');
    console.error('  Run "wallet connect" to pair a wallet.\n');
    process.exit(1);
  }

  const client = await getClient();

  // Auto-extend sessions so they don't expire (WC v2 max is 7 days per extend)
  for (const s of sessions) {
    try { await client.extend({ topic: s.topic }); } catch {}
  }

  return new WalletConnectSigner(client, sessions);
}

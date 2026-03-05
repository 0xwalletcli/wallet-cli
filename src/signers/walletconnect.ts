import { join } from 'path';
import { homedir } from 'os';
import { mkdirSync, writeFileSync, readFileSync, readdirSync, unlinkSync, existsSync } from 'fs';
import SignClient from '@walletconnect/sign-client';
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

  _client = await SignClient.init({
    projectId,
    relayUrl: RELAY_URL,
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

  // Determine what to connect based on chain arg and existing sessions
  const sessions = loadSessions();
  const hasEvm = sessions.some(s => s.evmAccounts.length > 0);
  const hasSol = sessions.some(s => s.solanaAccounts.length > 0);

  let connectEvm = false;
  let connectSol = false;

  if (chain === 'evm' || chain === 'ethereum' || chain === 'eth') {
    if (hasEvm) {
      const evmSession = sessions.find(s => s.evmAccounts.length > 0)!;
      console.log(`  EVM already connected via ${evmSession.peerName}.`);
      console.log('  Run "wallet disconnect" first to reconnect.\n');
      return;
    }
    connectEvm = true;
  } else if (chain === 'solana' || chain === 'sol') {
    if (hasSol) {
      const solSession = sessions.find(s => s.solanaAccounts.length > 0)!;
      console.log(`  Solana already connected via ${solSession.peerName}.`);
      console.log('  Run "wallet disconnect" first to reconnect.\n');
      return;
    }
    connectSol = true;
  } else {
    // No chain specified — connect whatever is missing
    if (hasEvm && hasSol) {
      const evmSession = sessions.find(s => s.evmAccounts.length > 0)!;
      const solSession = sessions.find(s => s.solanaAccounts.length > 0)!;
      console.log(`  EVM:    connected via ${evmSession.peerName}`);
      console.log(`  Solana: connected via ${solSession.peerName}`);
      console.log('\n  Both chains connected. Run "wallet disconnect" to reconnect.\n');
      return;
    }
    connectEvm = !hasEvm;
    connectSol = !hasSol;
  }

  // Build namespaces based on what we're connecting
  const requiredNamespaces: Record<string, any> = {};
  const optionalNamespaces: Record<string, any> = {};

  if (connectEvm && connectSol) {
    // Connecting both — EVM required, Solana optional (MetaMask won't support Solana)
    requiredNamespaces.eip155 = {
      methods: ['eth_sendTransaction', 'personal_sign', 'eth_signTypedData_v4'],
      chains: [...EVM_CHAINS],
      events: ['chainChanged', 'accountsChanged'],
    };
    optionalNamespaces.solana = {
      methods: ['solana_signTransaction', 'solana_signMessage'],
      chains: [...SOL_CHAINS],
      events: [],
    };
    console.log('  Connecting EVM + Solana via WalletConnect...\n');
  } else if (connectEvm) {
    requiredNamespaces.eip155 = {
      methods: ['eth_sendTransaction', 'personal_sign', 'eth_signTypedData_v4'],
      chains: [...EVM_CHAINS],
      events: ['chainChanged', 'accountsChanged'],
    };
    console.log('  Connecting EVM via WalletConnect...\n');
  } else if (connectSol) {
    requiredNamespaces.solana = {
      methods: ['solana_signTransaction', 'solana_signMessage'],
      chains: [...SOL_CHAINS],
      events: [],
    };
    console.log('  Connecting Solana via WalletConnect...\n');
  }

  const client = await getClient();

  const { uri, approval } = await client.connect({
    requiredNamespaces,
    optionalNamespaces,
  });

  if (uri) {
    qrcode.generate(uri, { small: true }, (code: string) => {
      console.log(code);
    });
    console.log(`  URI: ${uri}\n`);
    console.log('  Scan with MetaMask, Phantom, or any WalletConnect-compatible wallet.');
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

  saveSession(session);

  const evmAccts = session.namespaces?.eip155?.accounts ?? [];
  const solAccts = session.namespaces?.solana?.accounts ?? [];
  const evmAddr = evmAccts.length > 0 ? evmAccts[0].split(':').pop() : null;
  const solAddr = solAccts.length > 0 ? solAccts[0].split(':').pop() : null;

  console.log('  Connected!\n');
  if (evmAddr) console.log(`  EVM:    ${evmAddr}`);
  if (solAddr) console.log(`  Solana: ${solAddr}`);
  console.log(`  Wallet: ${session.peer?.metadata?.name ?? 'Unknown'}`);
  console.log(`  Expiry: ${new Date(session.expiry * 1000).toLocaleDateString()}\n`);

  // Hint next steps
  if (connectEvm && !hasSol && !solAddr) {
    console.log('  Tip: run "wallet connect solana" to also connect Phantom.\n');
  } else if (connectSol && !hasEvm && !evmAddr) {
    console.log('  Tip: run "wallet connect evm" to also connect MetaMask.\n');
  } else {
    console.log('  Set as default signer: wallet config set signer wc\n');
  }
}

export async function disconnectWallet(target?: string): Promise<void> {
  const sessions = loadSessions();
  if (sessions.length === 0) {
    console.log('  No active WalletConnect sessions.\n');
    return;
  }

  // If target specified, find matching session by peer name
  const toDisconnect = target
    ? sessions.filter(s => s.peerName.toLowerCase().includes(target.toLowerCase()))
    : sessions;

  if (target && toDisconnect.length === 0) {
    console.log(`  No session matching "${target}".`);
    console.log(`  Active sessions: ${sessions.map(s => s.peerName).join(', ')}\n`);
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

  // Verify at least one session is still active on the relay
  const relaySessions = client.session.getAll();
  const liveSessions = sessions.filter(s =>
    relaySessions.some(rs => rs.topic === s.topic)
  );

  if (liveSessions.length === 0) {
    console.error('  WalletConnect sessions no longer active on relay.');
    console.error('  Run "wallet connect" to pair a new wallet.\n');
    for (const s of sessions) deleteSession(s.topic);
    process.exit(1);
  }

  // Clean up dead sessions
  for (const s of sessions) {
    if (!liveSessions.includes(s)) deleteSession(s.topic);
  }

  return new WalletConnectSigner(client, liveSessions);
}

/**
 * Network Egress Guard
 *
 * Intercepts all outbound TCP/TLS connections and blocks any that aren't
 * to known, whitelisted hosts. This prevents compromised npm dependencies
 * from exfiltrating private keys to attacker-controlled servers.
 *
 * MUST be imported before any other module in the entry point.
 */

import net from 'net';
import tls from 'tls';
import child_process from 'child_process';
import dgram from 'dgram';

// Known-good hosts that the CLI needs to connect to
const ALLOWED_HOSTS = new Set([
  // EVM RPCs (publicnode)
  'ethereum-rpc.publicnode.com',
  'ethereum-sepolia-rpc.publicnode.com',
  'eth.llamarpc.com',
  'rpc.sepolia.org',
  // Base RPCs (publicnode)
  'base-rpc.publicnode.com',
  'base-sepolia-rpc.publicnode.com',
  'mainnet.base.org',
  // Solana RPCs
  'solana-rpc.publicnode.com',
  'api.mainnet-beta.solana.com',
  'api.devnet.solana.com',
  // CoW Swap
  'api.cow.fi',
  // deBridge
  'dln.debridge.finance',
  'stats-api.dln.trade',
  // Jupiter (Solana swap)
  'api.jup.ag',
  'lite-api.jup.ag',
  // Etherscan (transaction history — V2 API, single endpoint for all chains)
  'api.etherscan.io',
  'api.basescan.org',
  'basescan.org',
  'sepolia.basescan.org',
  // Uniswap Trading API
  'trade-api.gateway.uniswap.org',
  // LI.FI / Jumper
  'li.quest',
  // CoinGecko (price data)
  'api.coingecko.com',
  // DeFi Llama (fallback price data)
  'coins.llama.fi',
  // Lido (staking APR)
  'eth-api.lido.fi',
  // Jito (staking APY)
  'kobe.mainnet.jito.network',
  // Spritz Finance (off-ramp)
  'api.spritz.finance',
  'platform.spritz.finance',
  // WalletConnect relay
  'relay.walletconnect.com',
  // localhost (for dev/testing)
  'localhost',
  '127.0.0.1',
  '::1',
]);

// Add custom RPC hosts from environment (parsed at import time, after dotenv)
for (const envVar of ['EVM_RPC_URL', 'BASE_RPC_URL', 'SOLANA_RPC_URL']) {
  const url = process.env[envVar];
  if (url) {
    try { ALLOWED_HOSTS.add(new URL(url).hostname); } catch { /* config.ts will handle */ }
  }
}

// Track blocked attempts for reporting
const blockedAttempts: { host: string; port: number; timestamp: Date }[] = [];

function isAllowed(host: string | undefined): boolean {
  if (!host) return true; // local socket / IPC
  return ALLOWED_HOSTS.has(host);
}

// Parse the various arg formats for net.connect / tls.connect
function normalizeConnectArgs(args: unknown[]): { host?: string; port?: number; servername?: string } {
  if (typeof args[0] === 'object' && args[0] !== null && !Array.isArray(args[0])) {
    return args[0] as { host?: string; port?: number; servername?: string };
  }
  if (typeof args[0] === 'number') {
    return { port: args[0], host: typeof args[1] === 'string' ? args[1] : undefined };
  }
  if (typeof args[0] === 'string' && !args[0].startsWith('/')) {
    return { host: args[0] };
  }
  return {};
}

function blockSocket(host: string, port: number): net.Socket {
  blockedAttempts.push({ host, port, timestamp: new Date() });
  console.error(`  [BLOCKED] Outbound connection to ${host}:${port || '?'} denied by network guard`);
  const sock = new net.Socket();
  process.nextTick(() => sock.destroy(new Error(`Connection to ${host} blocked by network guard`)));
  return sock;
}

// Patch net.connect / net.createConnection
const origNetConnect = net.connect.bind(net);
const patchedConnect = (...args: unknown[]): net.Socket => {
  const opts = normalizeConnectArgs(args);
  if (!isAllowed(opts.host)) {
    return blockSocket(opts.host!, opts.port ?? 0);
  }
  return origNetConnect(...(args as Parameters<typeof net.connect>));
};
net.connect = patchedConnect as typeof net.connect;
net.createConnection = patchedConnect as typeof net.createConnection;

// Patch tls.connect
const origTlsConnect = tls.connect.bind(tls);
(tls as any).connect = (...args: unknown[]): tls.TLSSocket => {
  const opts = normalizeConnectArgs(args);
  const host = opts.host || opts.servername;
  if (!isAllowed(host)) {
    blockedAttempts.push({ host: host!, port: opts.port ?? 0, timestamp: new Date() });
    console.error(`  [BLOCKED] Outbound TLS connection to ${host}:${opts.port ?? '?'} denied by network guard`);
    const sock = new tls.TLSSocket(new net.Socket());
    process.nextTick(() => sock.destroy(new Error(`TLS connection to ${host} blocked by network guard`)));
    return sock;
  }
  return origTlsConnect(...(args as Parameters<typeof tls.connect>));
};

// Block child_process — prevents `curl`/`wget` bypass
const blockChild = () => {
  throw new Error('child_process is disabled by network guard');
};
child_process.exec = blockChild as any;
child_process.execSync = blockChild as any;
child_process.spawn = blockChild as any;
child_process.spawnSync = blockChild as any;
child_process.execFile = blockChild as any;
child_process.execFileSync = blockChild as any;
child_process.fork = blockChild as any;

// Block UDP sockets — prevents DNS-based exfiltration
const origCreateSocket = dgram.createSocket.bind(dgram);
(dgram as any).createSocket = (...args: unknown[]) => {
  // Allow only if it looks like a standard DNS lookup (Node uses c-ares, not dgram, so this is safe)
  console.error('  [BLOCKED] UDP socket creation denied by network guard');
  throw new Error('UDP sockets are disabled by network guard');
};

/** Returns list of blocked connection attempts (for diagnostics) */
export function getBlockedAttempts() {
  return [...blockedAttempts];
}

/** Add a host to the allowlist at runtime */
export function allowHost(host: string) {
  ALLOWED_HOSTS.add(host);
}

/** Get current allowlist (for debugging) */
export function getAllowedHosts(): string[] {
  return [...ALLOWED_HOSTS];
}

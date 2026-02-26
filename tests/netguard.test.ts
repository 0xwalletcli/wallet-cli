import { describe, it, expect } from 'vitest';

// ═══════════════════════════════════════════════════════════════
//  Netguard allowlist completeness
//  Every external host the CLI connects to MUST be in the allowlist.
//  If we add a new API and forget netguard, it silently fails.
// ═══════════════════════════════════════════════════════════════

// Hardcode the expected hosts — if someone adds a new API they must
// also update this test, which serves as a forcing function.
const EXPECTED_HOSTS = [
  // EVM RPCs
  'ethereum-rpc.publicnode.com',
  'ethereum-sepolia-rpc.publicnode.com',
  'eth.llamarpc.com',
  'rpc.sepolia.org',
  // Solana RPCs
  'solana-rpc.publicnode.com',
  'api.mainnet-beta.solana.com',
  'api.devnet.solana.com',
  // CoW Swap
  'api.cow.fi',
  // deBridge
  'dln.debridge.finance',
  'stats-api.dln.trade',
  // Jupiter
  'api.jup.ag',
  'lite-api.jup.ag',
  // Etherscan (V2 API — single endpoint for all chains)
  'api.etherscan.io',
  // Uniswap Trading API
  'trade-api.gateway.uniswap.org',
  // LI.FI / Jumper
  'li.quest',
  // CoinGecko
  'api.coingecko.com',
  // localhost
  'localhost',
  '127.0.0.1',
  '::1',
];

// Read the actual netguard source to verify
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const netguardSource = readFileSync(join(__dirname, '..', 'src', 'lib', 'netguard.ts'), 'utf-8');

describe('netguard allowlist', () => {
  for (const host of EXPECTED_HOSTS) {
    it(`includes ${host}`, () => {
      expect(netguardSource).toContain(`'${host}'`);
    });
  }

  it('blocks child_process methods', () => {
    for (const method of ['exec', 'execSync', 'spawn', 'spawnSync', 'execFile', 'execFileSync', 'fork']) {
      expect(netguardSource).toContain(`child_process.${method}`);
    }
  });

  it('blocks UDP sockets', () => {
    expect(netguardSource).toContain('dgram.createSocket');
  });
});

// ═══════════════════════════════════════════════════════════════
//  Config URLs must match netguard hosts
//  If config.ts references a host that's not in netguard,
//  that API will silently fail.
// ═══════════════════════════════════════════════════════════════

const configSource = readFileSync(join(__dirname, '..', 'src', 'config.ts'), 'utf-8');

describe('config URLs are covered by netguard', () => {
  // Extract all https:// URLs from config.ts
  const urlRegex = /https?:\/\/([a-zA-Z0-9.-]+)/g;
  const configHosts = new Set<string>();
  let match;
  while ((match = urlRegex.exec(configSource)) !== null) {
    configHosts.add(match[1]);
  }

  for (const host of configHosts) {
    // Skip documentation URLs (etherscan.io, stake.lido.fi, etc.)
    // These are just printed as links, not fetched by the CLI
    const docHosts = ['etherscan.io', 'sepolia.etherscan.io', 'solscan.io', 'explorer.solana.com',
      'stake.lido.fi', 'www.jito.network', 'cloud.google.com', 'faucet.circle.com'];
    if (docHosts.includes(host)) continue;

    it(`config host "${host}" is in netguard allowlist`, () => {
      expect(netguardSource).toContain(`'${host}'`);
    });
  }
});

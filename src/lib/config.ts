import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const CONFIG_DIR = join(homedir(), '.wallet-cli');
const CONFIG_FILE = join(CONFIG_DIR, 'config.json');

export interface SignerConfig {
  evm: string;    // 'env' | 'wc' | 'browser'
  solana: string; // 'env' | 'browser'
}

export interface PaymentHandles {
  venmo?: string;
  zelle?: string;
  cashapp?: string;
  revolut?: string;
}

export interface WalletConfig {
  swapProvider: string;    // 'auto' | 'cow' | 'uniswap' | 'lifi'
  bridgeProvider: string;  // 'auto' | 'debridge' | 'lifi'
  offrampProvider: string; // 'auto' | 'spritz'
  signer: string | SignerConfig; // legacy string or per-chain object
  handles?: PaymentHandles; // saved payment handles for Peer off-ramp
}

const DEFAULTS: WalletConfig = {
  swapProvider: 'auto',
  bridgeProvider: 'auto',
  offrampProvider: 'auto',
  signer: 'env',
};

const VALID_SWAP_PROVIDERS = ['auto', 'cow', 'uniswap', 'lifi'];
const VALID_BRIDGE_PROVIDERS = ['auto', 'debridge', 'lifi'];
const VALID_OFFRAMP_PROVIDERS = ['auto', 'spritz', 'peer'];
const VALID_SIGNERS = ['env', 'wc', 'browser'];
const VALID_PLATFORMS = ['venmo', 'zelle', 'cashapp', 'revolut'];

/** Normalize signer config — migrates legacy string to per-chain object */
export function getSignerConfig(config: WalletConfig): SignerConfig {
  if (typeof config.signer === 'object') return config.signer;
  // Legacy: single string applies to both chains
  const val = config.signer || 'env';
  return { evm: val, solana: val };
}

export function loadConfig(): WalletConfig {
  try {
    const raw = readFileSync(CONFIG_FILE, 'utf-8');
    const data = JSON.parse(raw);
    return { ...DEFAULTS, ...data };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveConfig(config: WalletConfig): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + '\n');
}

export function getConfigPath(): string {
  return CONFIG_FILE;
}

export function validateConfigKey(key: string): key is 'swap' | 'bridge' | 'offramp' | 'signer' | 'handle' {
  return key === 'swap' || key === 'bridge' || key === 'offramp' || key === 'signer' || key === 'handle';
}

export function getPaymentHandles(config?: WalletConfig): PaymentHandles {
  const c = config || loadConfig();
  return c.handles || {};
}

export function validateConfigValue(key: string, value: string): string | null {
  if (key === 'swap') {
    if (!VALID_SWAP_PROVIDERS.includes(value)) {
      return `Invalid swap provider: "${value}". Valid: ${VALID_SWAP_PROVIDERS.join(', ')}`;
    }
  } else if (key === 'bridge') {
    if (!VALID_BRIDGE_PROVIDERS.includes(value)) {
      return `Invalid bridge provider: "${value}". Valid: ${VALID_BRIDGE_PROVIDERS.join(', ')}`;
    }
  } else if (key === 'offramp') {
    if (!VALID_OFFRAMP_PROVIDERS.includes(value)) {
      return `Invalid offramp provider: "${value}". Valid: ${VALID_OFFRAMP_PROVIDERS.join(', ')}`;
    }
  } else if (key === 'signer') {
    if (!VALID_SIGNERS.includes(value)) {
      return `Invalid signer: "${value}". Valid: ${VALID_SIGNERS.join(', ')}`;
    }
  }
  return null;
}

/** Resolve which provider to use: --route flag > config > 'auto' */
export function resolveSwapProvider(flagValue?: string): string {
  if (flagValue) return flagValue;
  return loadConfig().swapProvider;
}

export function resolveBridgeProvider(flagValue?: string): string {
  if (flagValue) return flagValue;
  return loadConfig().bridgeProvider;
}

export function resolveOfframpProvider(flagValue?: string): string {
  if (flagValue) return flagValue;
  return loadConfig().offrampProvider;
}

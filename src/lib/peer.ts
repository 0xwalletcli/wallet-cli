/**
 * Peer SDK wrapper
 *
 * Provides USDC off-ramp via decentralized P2P on Base chain.
 * Non-custodial, no KYC/KYB — user deposits USDC as LP, buyers pay fiat.
 */

import { createPublicClient, http, type WalletClient } from 'viem';
import { base } from 'viem/chains';
import { getEvmRpcUrl } from '../config.js';
import { resolveSigner } from '../signers/index.js';

// Base USDC
export const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as const;
export const USDC_DECIMALS = 6;

// Supported payment platforms for off-ramp
export const SUPPORTED_PLATFORMS = ['venmo', 'zelle', 'cashapp', 'revolut'] as const;
export type PaymentPlatform = typeof SUPPORTED_PLATFORMS[number];

const PLATFORM_LABELS: Record<string, string> = {
  venmo: 'Venmo',
  zelle: 'Zelle',
  cashapp: 'Cash App',
  revolut: 'Revolut',
};

export function getPlatformLabel(platform: string): string {
  return PLATFORM_LABELS[platform] || platform;
}

export function isValidPlatform(platform: string): platform is PaymentPlatform {
  return SUPPORTED_PLATFORMS.includes(platform as PaymentPlatform);
}

let _client: any = null;

/** Get or create a Peer client (singleton per session) */
export async function getPeerClient(): Promise<any> {
  if (_client) return _client;

  const { Zkp2pClient } = await import('@zkp2p/offramp-sdk');

  const signer = await resolveSigner();
  const rpcUrl = getEvmRpcUrl('mainnet', 'base');
  const walletClient = await signer.getEvmWalletClient(base, http(rpcUrl));

  _client = new Zkp2pClient({
    walletClient: walletClient as WalletClient,
    chainId: 8453,
    apiKey: 'wallet-cli',
    runtimeEnv: 'production',
  });

  return _client;
}

/** Get a read-only public client for Base */
export function getBasePublicClient() {
  return createPublicClient({
    chain: base,
    transport: http(getEvmRpcUrl('mainnet', 'base')),
  });
}

/** Get USDC balance on Base for an address */
export async function getBaseUsdcBalance(address: string): Promise<bigint> {
  const client = getBasePublicClient();
  const balance = await client.readContract({
    address: BASE_USDC,
    abi: [{ name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ name: 'account', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] }],
    functionName: 'balanceOf',
    args: [address as `0x${string}`],
  });
  return balance as bigint;
}

/** Format USDC amount from raw bigint (6 decimals) */
export function formatUsdc(raw: bigint): string {
  const num = Number(raw) / 1e6;
  return num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Parse human-readable USDC amount to raw bigint */
export function parseUsdc(amount: string): bigint {
  return BigInt(Math.round(Number(amount) * 1e6));
}

/** Conversion rate string: 1.02 = 2% spread, stored as 18-decimal string */
export function spreadToRate(spreadPct: number): string {
  const rate = 1 + spreadPct / 100;
  return (BigInt(Math.round(rate * 1e18))).toString();
}

/** Rate (18 decimals) back to spread percentage */
export function rateToSpread(rate: bigint | string): number {
  const r = Number(BigInt(rate)) / 1e18;
  return (r - 1) * 100;
}

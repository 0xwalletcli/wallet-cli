import { createPublicClient, createWalletClient, http, parseAbi, type PublicClient, type WalletClient } from 'viem';
import { type Network, EVM_CHAINS, TOKENS, getEvmAccount, getEvmRpcUrl } from '../config.js';

let _publicClient: PublicClient | null = null;
let _walletClient: WalletClient | null = null;
let _currentNetwork: Network | null = null;

export function getPublicClient(network: Network): PublicClient {
  if (_publicClient && _currentNetwork === network) return _publicClient;
  _currentNetwork = network;
  _publicClient = createPublicClient({
    chain: EVM_CHAINS[network],
    transport: http(getEvmRpcUrl(network)),
  });
  return _publicClient;
}

export function getWalletClient(network: Network): WalletClient {
  if (_walletClient && _currentNetwork === network) return _walletClient;
  const account = getEvmAccount();
  _walletClient = createWalletClient({
    account,
    chain: EVM_CHAINS[network],
    transport: http(getEvmRpcUrl(network)),
  });
  return _walletClient;
}

/** Force the wallet client to be recreated on next use (fresh nonce from RPC). */
export function resetWalletClient() {
  _walletClient = null;
}

/**
 * Simulate a transaction via eth_call before broadcasting.
 * Throws with a descriptive error if the simulation reverts (no gas spent).
 */
export async function simulateTx(
  network: Network,
  params: { account: `0x${string}`; to: `0x${string}`; data: `0x${string}`; value?: bigint },
) {
  const client = getPublicClient(network);
  console.log('  Simulating transaction...');
  try {
    await client.call({
      account: params.account,
      to: params.to,
      data: params.data,
      value: params.value ?? 0n,
    });
  } catch (simErr: any) {
    const reason = decodeRevertReason(simErr) || 'unknown';
    throw new Error(`Simulation reverted (no gas spent): ${reason}`);
  }
}

const ERC20_ABI = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
]);

export async function getERC20Balance(network: Network, token: `0x${string}`, address: `0x${string}`): Promise<bigint> {
  const client = getPublicClient(network);
  return client.readContract({
    address: token,
    abi: ERC20_ABI,
    functionName: 'balanceOf',
    args: [address],
  });
}

export async function getERC20Allowance(network: Network, token: `0x${string}`, owner: `0x${string}`, spender: `0x${string}`): Promise<bigint> {
  const client = getPublicClient(network);
  return client.readContract({
    address: token,
    abi: ERC20_ABI,
    functionName: 'allowance',
    args: [owner, spender],
  });
}

export async function approveERC20(network: Network, token: `0x${string}`, spender: `0x${string}`, amount: bigint): Promise<`0x${string}`> {
  const wallet = getWalletClient(network);
  const account = getEvmAccount();
  const hash = await wallet.writeContract({
    account,
    address: token,
    abi: ERC20_ABI,
    functionName: 'approve',
    args: [spender, amount],
  });
  console.log(`  Approval tx: ${hash}`);
  console.log('  Waiting for approval confirmation...');

  const { trackTx, clearTx } = await import('./txtracker.js');
  trackTx(hash, 'evm', network);

  await waitForReceipt(network, hash);
  clearTx();
  console.log('  Approval confirmed.');
  return hash;
}

// Known custom error selectors from DEX/bridge contracts (LI.FI, Uniswap, etc.)
const KNOWN_ERROR_SELECTORS: Record<string, string> = {
  '0x63ecb9f6': 'MinimalOutputBalanceViolation — swap output less than minimum (slippage)',
  '0x275c273c': 'CumulativeSlippageTooHigh — price moved between quote and execution',
  '0x76baadda': 'SlippageTooHigh — price slippage exceeded tolerance',
  '0x42e0f17d': 'TooMuchSlippage — price slippage exceeded tolerance',
  '0xcf479181': 'InsufficientBalance — not enough tokens to complete swap',
  '0xf49a253e': 'NativeAssetTransferFailed — ETH transfer failed',
  '0x29f745a7': 'ReentrancyError — contract reentrancy detected',
  '0x50dc905c': 'InformationMismatch — quote parameters changed',
  '0x2c5211c6': 'InvalidAmount — zero or invalid swap amount',
  '0x1e4ec46b': 'InvalidReceiver — invalid recipient address',
  '0x0503c3ed': 'NoSwapDataProvided — missing swap calldata',
  '0xe46e079c': 'NoSwapFromZeroBalance — no tokens to swap',
  '0x47aaf07a': 'SliceOverflow — data encoding error',
  '0x94539804': 'ContractCallNotAllowed — blocked contract interaction',
  '0x316cf0eb': 'V3InvalidSwap — Uniswap V3 swap failed',
  '0x39d35496': 'V3TooLittleReceived — Uniswap V3 output below minimum',
  '0x739dbe52': 'V3TooMuchRequested — Uniswap V3 input exceeded maximum',
  '0x11157667': 'InvalidSwap — swap route failed',
  '0xc9f52c71': 'TooLittleReceived — output amount below minimum',
  '0x24df576f': 'TooMuchRequested — input amount exceeded maximum',
};

/** Walk a viem error chain to find the raw revert data (hex bytes). */
function extractRevertData(err: any): string | null {
  let current = err;
  for (let i = 0; i < 10 && current; i++) {
    // viem puts revert data on .data as hex string
    if (typeof current.data === 'string' && current.data.startsWith('0x') && current.data.length >= 10) {
      return current.data;
    }
    current = current.cause;
  }
  return null;
}

/** Try to decode revert reason from raw data or error message. */
function decodeRevertReason(err: any): string {
  // First: try to extract raw revert data and decode
  const data = extractRevertData(err);
  if (data) {
    const selector = data.slice(0, 10).toLowerCase();

    // Error(string) — standard Solidity revert
    if (selector === '0x08c379a0' && data.length > 10) {
      try {
        // ABI-decode the string: skip selector (4 bytes) + offset (32 bytes) + length (32 bytes)
        const hex = data.slice(10);
        const offset = parseInt(hex.slice(0, 64), 16) * 2;
        const len = parseInt(hex.slice(offset, offset + 64), 16);
        const strHex = hex.slice(offset + 64, offset + 64 + len * 2);
        const reason = Buffer.from(strHex, 'hex').toString('utf-8');
        if (reason.length > 0) return reason;
      } catch { /* fall through */ }
    }

    // Known custom error selectors
    const known = KNOWN_ERROR_SELECTORS[selector];
    if (known) return known;

    // Unknown selector — show it for debugging
    return `Custom error ${selector}`;
  }

  // Fallback: parse viem's error message
  const msg = err.shortMessage || err.message || '';
  const match = msg.match(/reverted with the following reason:\s*(.+)/i)
    || msg.match(/reason:\s*(.+)/i);
  if (match) return match[1].trim();

  // Last resort: if the message is just "unknown reason", return empty
  if (msg.includes('unknown reason')) return '';
  return msg.slice(0, 200);
}

/**
 * Wait for a transaction receipt and throw if it reverted.
 * On revert, attempts to extract the revert reason via simulation.
 * Returns the receipt on success.
 */
export async function waitForReceipt(network: Network, hash: `0x${string}`) {
  const client = getPublicClient(network);
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (receipt.status === 'reverted') {
    // Try to extract the revert reason by simulating the tx at the block it was mined
    let reason = '';
    try {
      const tx = await client.getTransaction({ hash });
      await client.call({
        to: tx.to!,
        data: tx.input,
        value: tx.value,
        account: tx.from,
        blockNumber: receipt.blockNumber,
      });
    } catch (simErr: any) {
      reason = decodeRevertReason(simErr);
    }
    const revertMsg = reason
      ? `Transaction reverted: ${reason}\n  TX: ${hash}`
      : `Transaction reverted on-chain: ${hash}`;
    throw new Error(revertMsg);
  }
  return receipt;
}

// ── WETH wrap/unwrap ──

const WETH_ABI = parseAbi([
  'function deposit() payable',
  'function withdraw(uint256 amount)',
  'function balanceOf(address) view returns (uint256)',
]);

export async function getWethBalance(network: Network, address: `0x${string}`): Promise<bigint> {
  const client = getPublicClient(network);
  return client.readContract({
    address: TOKENS[network].WETH,
    abi: WETH_ABI,
    functionName: 'balanceOf',
    args: [address],
  });
}

export async function wrapEth(network: Network, amount: bigint): Promise<`0x${string}`> {
  const wallet = getWalletClient(network);
  const account = getEvmAccount();
  return wallet.writeContract({
    account,
    address: TOKENS[network].WETH,
    abi: WETH_ABI,
    functionName: 'deposit',
    value: amount,
  });
}

export async function unwrapWeth(network: Network, amount: bigint): Promise<`0x${string}`> {
  const wallet = getWalletClient(network);
  const account = getEvmAccount();
  return wallet.writeContract({
    account,
    address: TOKENS[network].WETH,
    abi: WETH_ABI,
    functionName: 'withdraw',
    args: [amount],
  });
}

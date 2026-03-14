// dotenv loaded in index.ts before netguard
import { mainnet, sepolia, base, baseSepolia } from 'viem/chains';

export type Network = 'mainnet' | 'testnet';
export type EvmChain = 'ethereum' | 'base';

/** Max items returned by any history / txs command. Single source of truth. */
export const HISTORY_LIMIT = 10;

// EVM chains
export const EVM_CHAINS = {
  mainnet: mainnet,
  testnet: sepolia,
} as const;

export const BASE_CHAINS = {
  mainnet: base,
  testnet: baseSepolia,
} as const;

/** Get the viem chain object for any EVM chain + network. */
export function getEvmChain(network: Network, chain: EvmChain = 'ethereum') {
  return chain === 'base' ? BASE_CHAINS[network] : EVM_CHAINS[network];
}

// Token addresses
export const TOKENS = {
  mainnet: {
    USDC: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' as `0x${string}`,
    WETH: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2' as `0x${string}`,
    WSOL: '0xd31a59c85ae9d8edefec411d448f90841571b89c' as `0x${string}`, // Wormhole wrapped SOL
    USDC_DECIMALS: 6,
    WETH_DECIMALS: 18,
    WSOL_DECIMALS: 9,
  },
  testnet: {
    // Sepolia USDC (Circle)
    USDC: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238' as `0x${string}`,
    WETH: '0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14' as `0x${string}`,
    WSOL: '0xd31a59c85ae9d8edefec411d448f90841571b89c' as `0x${string}`, // no Wormhole on Sepolia, balance will be 0
    USDC_DECIMALS: 6,
    WETH_DECIMALS: 18,
    WSOL_DECIMALS: 9,
  },
} as const;

// Base token addresses
export const BASE_TOKENS = {
  mainnet: {
    USDC: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as `0x${string}`,
    WETH: '0x4200000000000000000000000000000000000006' as `0x${string}`,
    USDC_DECIMALS: 6,
    WETH_DECIMALS: 18,
  },
  testnet: {
    USDC: '0x036CbD53842c5426634e7929541eC2318f3dCF7e' as `0x${string}`, // Base Sepolia USDC
    WETH: '0x4200000000000000000000000000000000000006' as `0x${string}`,
    USDC_DECIMALS: 6,
    WETH_DECIMALS: 18,
  },
} as const;

// CoW Swap
export const COW_CONFIG = {
  mainnet: {
    api: 'https://api.cow.fi/mainnet',
    vaultRelayer: '0xC92E8bdf79f0507f65a392b0ab4667716BFE0110' as `0x${string}`,
    settlement: '0x9008D19f58AAbD9eD0D60971565AA8510560ab41' as `0x${string}`,
    chainId: 1,
  },
  testnet: {
    api: 'https://api.cow.fi/sepolia',
    vaultRelayer: '0xC92E8bdf79f0507f65a392b0ab4667716BFE0110' as `0x${string}`,
    settlement: '0x9008D19f58AAbD9eD0D60971565AA8510560ab41' as `0x${string}`,
    chainId: 11155111,
  },
} as const;

// deBridge DLN
export const DEBRIDGE_CONFIG = {
  api: 'https://dln.debridge.finance/v1.0',
  statusApi: 'https://stats-api.dln.trade/api',
  chains: {
    mainnet: { evmChainId: '1', solanaChainId: '7565164', baseChainId: '8453' },
    testnet: { evmChainId: '1', solanaChainId: '7565164', baseChainId: '8453' }, // deBridge is mainnet-only
  },
  tokens: {
    nativeETH: '0x0000000000000000000000000000000000000000',
    nativeSOL: '11111111111111111111111111111111',
    USDC_ETH: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    USDC_SOL: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    USDC_BASE: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  },
} as const;

// Lido stETH
export const LIDO_CONFIG = {
  mainnet: {
    stETH: '0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84' as `0x${string}`,
    withdrawalQueue: '0x889edC2eDab5f40e902b864aD4d7AdE8E412F9B1' as `0x${string}`,
  },
  testnet: {
    stETH: '0x3e3FE7dBc6B4C189E7128855dD526361c49b40Af' as `0x${string}`,
    withdrawalQueue: '0x1583C7b3f4C3B008720E6BcE5726336b0aB25fdd' as `0x${string}`,
  },
} as const;

// Wrapped SOL
export const WSOL_CONFIG = {
  mint: 'So11111111111111111111111111111111111111112',
  decimals: 9,
} as const;

// Jito JitoSOL
export const JITO_CONFIG = {
  stakePool: 'Jito4APyf642JPZPx3hGc6WWJ8zPKtRbRs4P815Awbb',
  jitoSolMint: 'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn',
} as const;

// Jupiter (Solana swap)
export const JUPITER_CONFIG = {
  api: 'https://lite-api.jup.ag/swap/v1',
} as const;

// Common Solana token mints (for Jupiter / cross-chain)
export const SOLANA_MINTS = {
  SOL: 'So11111111111111111111111111111111111111112',
  USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
} as const;

// Solana
export const SOLANA_CONFIG = {
  mainnet: {
    rpc: process.env.SOLANA_RPC_URL || 'https://solana-rpc.publicnode.com',
    usdcMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  },
  testnet: {
    rpc: process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com',
    usdcMint: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
  },
} as const;



// Uniswap Trading API (EVM swap)
export const UNISWAP_CONFIG = {
  api: 'https://trade-api.gateway.uniswap.org/v1',
  permit2: '0x000000000022D473030F116dDEE9F6B43aC78BA3' as `0x${string}`,
} as const;

// LI.FI / Jumper (swap + bridge aggregator)
export const LIFI_CONFIG = {
  api: 'https://li.quest/v1',
  evmChainId: 1,
  baseChainId: 8453,
  solanaChainId: 1151111081099710,
} as const;

// Block explorers
export const EXPLORERS = {
  mainnet: { evm: 'https://etherscan.io', base: 'https://basescan.org', solana: 'https://solscan.io' },
  testnet: { evm: 'https://sepolia.etherscan.io', base: 'https://sepolia.basescan.org', solana: 'https://explorer.solana.com' },
} as const;

// Staking platforms
export const STAKING_URLS = {
  lido: 'https://stake.lido.fi',
  jito: 'https://www.jito.network/staking/',
} as const;

// Testnet faucets
export const FAUCET_URLS = {
  eth: 'https://cloud.google.com/application/web3/faucet/ethereum/sepolia',
  usdc: 'https://faucet.circle.com/',
} as const;

// Etherscan API (for transaction history)
export const ETHERSCAN_API = 'https://api.etherscan.io/v2/api';
export const ETHERSCAN_CHAIN_ID = {
  mainnet: '1',
  testnet: '11155111',  // Sepolia
} as const;

export const BASESCAN_CHAIN_ID = {
  mainnet: '8453',
  testnet: '84532',  // Base Sepolia
} as const;

// Blockscout API for Base (free, Etherscan-compatible, no API key needed)
// Etherscan V2 requires a paid plan for Base — Blockscout is the free alternative
export const BLOCKSCOUT_BASE_API = 'https://base.blockscout.com/api';

export function getEvmRpcUrl(network: Network, chain: EvmChain = 'ethereum'): string {
  if (chain === 'base') {
    if (process.env.BASE_RPC_URL) return process.env.BASE_RPC_URL;
    return network === 'mainnet'
      ? 'https://base-rpc.publicnode.com'
      : 'https://base-sepolia-rpc.publicnode.com';
  }
  if (process.env.EVM_RPC_URL) return process.env.EVM_RPC_URL;
  return network === 'mainnet'
    ? 'https://ethereum-rpc.publicnode.com'
    : 'https://ethereum-sepolia-rpc.publicnode.com';
}

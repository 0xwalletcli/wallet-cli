import { type Network, TOKENS, COW_CONFIG, LIDO_CONFIG, getEvmAccount } from '../config.js';
import { getERC20Allowance, approveERC20 } from '../lib/evm.js';
import { parseTokenAmount, formatToken } from '../lib/format.js';
import { confirm, validateAmount, warnMainnet, warnDryRun } from '../lib/prompt.js';

const MAX_UINT256 = 2n ** 256n - 1n;

// Token registry: name → (network) => { address, decimals }
const TOKEN_MAP: Record<string, (network: Network) => { address: `0x${string}`; decimals: number }> = {
  usdc: (network) => ({ address: TOKENS[network].USDC, decimals: TOKENS[network].USDC_DECIMALS }),
  steth: (network) => ({ address: LIDO_CONFIG[network].stETH, decimals: 18 }),
  weth: (network) => ({ address: TOKENS[network].WETH, decimals: 18 }),
};

// Spender registry: name → (network) => address
const SPENDER_MAP: Record<string, (network: Network) => `0x${string}`> = {
  cow: (network) => COW_CONFIG[network].vaultRelayer,
  'lido-withdrawal': (network) => LIDO_CONFIG[network].withdrawalQueue,
  lifi: () => '0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE' as `0x${string}`,
  debridge: () => '0xeF4fB24aD0916217251F553c0596F8Edc630EB66' as `0x${string}`,
};

export async function approveCommand(
  token: string,
  spender: string,
  amount: string,
  network: Network,
  dryRun: boolean,
) {
  const t = token.toLowerCase();
  const s = spender.toLowerCase();
  const isUnlimited = amount === 'unlimited' || amount === 'max';

  if (!isUnlimited) validateAmount(amount);

  const tokenEntry = TOKEN_MAP[t];
  if (!tokenEntry) {
    console.error(`  Supported tokens: ${Object.keys(TOKEN_MAP).join(', ')}`);
    process.exit(1);
  }

  const account = getEvmAccount();
  const { address: tokenAddress, decimals } = tokenEntry(network);
  const parsedAmount = isUnlimited ? MAX_UINT256 : parseTokenAmount(amount, decimals);

  let spenderAddress: `0x${string}`;
  let spenderLabel: string;
  if (s in SPENDER_MAP) {
    spenderAddress = SPENDER_MAP[s](network);
    spenderLabel = s;
  } else if (s.startsWith('0x') && s.length === 42) {
    spenderAddress = s as `0x${string}`;
    spenderLabel = 'custom address';
  } else {
    console.error(`  Unknown spender "${spender}". Use: ${Object.keys(SPENDER_MAP).join(', ')}, or a 0x address.`);
    process.exit(1);
  }

  console.log('');
  if (dryRun) warnDryRun();
  warnMainnet(network, dryRun);
  console.log('  Checking allowance...');

  const current = await getERC20Allowance(network, tokenAddress, account.address, spenderAddress);
  const currentFormatted = Number(current) / 10 ** decimals;
  const amountLabel = isUnlimited ? 'unlimited' : amount;

  console.log(`  Token:     ${t.toUpperCase()} (${tokenAddress})`);
  console.log(`  Spender:   ${spenderLabel} (${spenderAddress})`);
  console.log(`  Current:   ${current === MAX_UINT256 ? 'unlimited' : formatToken(currentFormatted, 2)}`);
  console.log(`  Requested: ${amountLabel}\n`);

  if (current >= parsedAmount) {
    console.log('  Allowance already sufficient. No approval needed.\n');
    return;
  }

  if (dryRun) {
    console.log('  [DRY RUN] Would approve. Skipping.\n');
    return;
  }

  if (!await confirm(`Approve ${amountLabel} ${t.toUpperCase()} to ${spenderLabel} (${spenderAddress})?`)) {
    console.log('  Cancelled.\n');
    return;
  }

  await approveERC20(network, tokenAddress, spenderAddress, parsedAmount);
  console.log('  Done.\n');
}

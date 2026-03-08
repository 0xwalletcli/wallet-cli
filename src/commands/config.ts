import {
  loadConfig, saveConfig, getConfigPath,
  validateConfigKey, validateConfigValue,
  getSignerConfig, getPaymentHandles,
  type WalletConfig,
} from '../lib/config.js';

const SEP = '──────────────────────────────────────────';

const PLATFORM_LABELS: Record<string, string> = {
  venmo: 'Venmo',
  zelle: 'Zelle',
  cashapp: 'Cash App',
  revolut: 'Revolut',
};

export function configShowCommand(): void {
  const config = loadConfig();
  const sc = getSignerConfig(config);
  const handles = getPaymentHandles(config);
  console.log(`\n  ── Configuration ${SEP}\n`);
  console.log(`  swap:           ${config.swapProvider}${config.swapProvider === 'auto' ? '  (default)' : ''}`);
  console.log(`  bridge:         ${config.bridgeProvider}${config.bridgeProvider === 'auto' ? '  (default)' : ''}`);
  console.log(`  offramp:        ${config.offrampProvider}${config.offrampProvider === 'auto' ? '  (default)' : ''}`);
  console.log(`  signer.evm:     ${sc.evm}`);
  console.log(`  signer.solana:  ${sc.solana}`);

  // Payment handles — always show all platforms
  console.log('');
  for (const platform of ['venmo', 'zelle', 'cashapp', 'revolut']) {
    const value = (handles as any)[platform] || '(not set)';
    console.log(`  handle.${platform.padEnd(12)} ${value}`);
  }

  console.log(`\n  File: ${getConfigPath()}`);
  console.log('  Run: wallet config --help  for available values and examples\n');
}

/**
 * Supports:
 *   wallet config set swap auto
 *   wallet config set signer wc          — sets both chains
 *   wallet config set signer evm wc      — sets only EVM
 *   wallet config set signer solana env   — sets only Solana
 *   wallet config set handle venmo @user  — save payment handle
 */
export function configSetCommand(key: string, value: string, chainOrUndefined?: string): void {
  if (!validateConfigKey(key)) {
    console.error(`  Unknown config key: "${key}".`);
    console.error('  Valid keys: swap, bridge, offramp, signer, handle');
    process.exit(1);
  }

  // Payment handles: `wallet config set handle venmo @username`
  if (key === 'handle') {
    const platform = value.toLowerCase();
    const handle = chainOrUndefined;
    const validPlatforms = ['venmo', 'zelle', 'cashapp', 'revolut'];

    if (!validPlatforms.includes(platform)) {
      console.error(`  Unknown platform: "${platform}". Valid: ${validPlatforms.join(', ')}`);
      process.exit(1);
    }
    if (!handle || !handle.trim()) {
      console.error(`  Usage: wallet config set handle ${platform} <your-handle>`);
      process.exit(1);
    }

    const config = loadConfig();
    if (!config.handles) config.handles = {};
    (config.handles as any)[platform] = handle.trim();
    saveConfig(config);

    const label = PLATFORM_LABELS[platform] || platform;
    console.log(`\n  Saved ${label} handle: ${handle.trim()}\n`);
    return;
  }

  // Per-chain signer: `wallet config set signer evm wc`
  if (key === 'signer' && chainOrUndefined) {
    const chain = value;
    const signerVal = chainOrUndefined;

    if (chain !== 'evm' && chain !== 'solana') {
      console.error(`  Unknown signer chain: "${chain}". Valid: evm, solana`);
      process.exit(1);
    }
    const err = validateConfigValue('signer', signerVal);
    if (err) {
      console.error(`  ${err}`);
      process.exit(1);
    }

    const config = loadConfig();
    const sc = getSignerConfig(config);
    sc[chain] = signerVal;
    config.signer = sc;
    saveConfig(config);

    console.log(`\n  Set signer.${chain} = ${signerVal}\n`);
    return;
  }

  const err = validateConfigValue(key, value);
  if (err) {
    console.error(`  ${err}`);
    process.exit(1);
  }

  const config = loadConfig();
  if (key === 'swap') config.swapProvider = value;
  if (key === 'bridge') config.bridgeProvider = value;
  if (key === 'offramp') config.offrampProvider = value;
  if (key === 'signer') {
    config.signer = { evm: value, solana: value };
  }
  saveConfig(config);

  if (key === 'signer') {
    console.log(`\n  Set signer.evm = ${value}`);
    console.log(`  Set signer.solana = ${value}\n`);
  } else {
    console.log(`\n  Set ${key} = ${value}\n`);
  }
}

export function configResetCommand(): void {
  const defaults: WalletConfig = { swapProvider: 'auto', bridgeProvider: 'auto', offrampProvider: 'auto', signer: 'env' };
  saveConfig(defaults);
  console.log('\n  Config reset to defaults (handles cleared).\n');
}

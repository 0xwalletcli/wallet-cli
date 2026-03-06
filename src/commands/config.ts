import {
  loadConfig, saveConfig, getConfigPath,
  validateConfigKey, validateConfigValue,
  getSignerConfig,
  type WalletConfig,
} from '../lib/config.js';

const SEP = '──────────────────────────────────────────';

export function configShowCommand(): void {
  const config = loadConfig();
  const sc = getSignerConfig(config);
  console.log(`\n  ── Configuration ${SEP}\n`);
  console.log(`  swap:           ${config.swapProvider}${config.swapProvider === 'auto' ? '  (default)' : ''}`);
  console.log(`  bridge:         ${config.bridgeProvider}${config.bridgeProvider === 'auto' ? '  (default)' : ''}`);
  console.log(`  signer.evm:     ${sc.evm}`);
  console.log(`  signer.solana:  ${sc.solana}`);
  console.log(`\n  File: ${getConfigPath()}\n`);
}

/**
 * Supports:
 *   wallet config set swap auto
 *   wallet config set signer wc          — sets both chains
 *   wallet config set signer evm wc      — sets only EVM
 *   wallet config set signer solana env   — sets only Solana
 */
export function configSetCommand(key: string, value: string, chainOrUndefined?: string): void {
  if (!validateConfigKey(key)) {
    console.error(`  Unknown config key: "${key}".`);
    console.error('  Valid keys: swap, bridge, signer');
    process.exit(1);
  }

  // Per-chain signer: `wallet config set signer evm wc`
  // In commander, args come as (key, value, ...rest), so:
  //   key='signer', value='evm', chainOrUndefined='wc'
  if (key === 'signer' && chainOrUndefined) {
    const chain = value;       // 'evm' or 'solana'
    const signerVal = chainOrUndefined; // 'env' or 'wc'

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
  if (key === 'signer') {
    // `wallet config set signer wc` — sets both chains
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
  const defaults: WalletConfig = { swapProvider: 'auto', bridgeProvider: 'auto', signer: 'env' };
  saveConfig(defaults);
  console.log('\n  Config reset to defaults.\n');
}

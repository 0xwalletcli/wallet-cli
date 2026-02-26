import {
  loadConfig, saveConfig, getConfigPath,
  validateConfigKey, validateConfigValue,
  type WalletConfig,
} from '../lib/config.js';

const SEP = '──────────────────────────────────────────';

const DEFAULTS: Record<string, string> = { swapProvider: 'auto', bridgeProvider: 'auto' };

export function configShowCommand(): void {
  const config = loadConfig();
  const tag = (key: keyof WalletConfig) => config[key] === DEFAULTS[key] ? '  (default)' : '';
  console.log(`\n  ── Configuration ${SEP}\n`);
  console.log(`  swap:     ${config.swapProvider}${tag('swapProvider')}`);
  console.log(`  bridge:   ${config.bridgeProvider}${tag('bridgeProvider')}`);
  console.log(`\n  File: ${getConfigPath()}\n`);
}

export function configSetCommand(key: string, value: string): void {
  if (!validateConfigKey(key)) {
    console.error(`  Unknown config key: "${key}".`);
    console.error('  Valid keys: swap, bridge');
    process.exit(1);
  }

  const err = validateConfigValue(key, value);
  if (err) {
    console.error(`  ${err}`);
    process.exit(1);
  }

  const config = loadConfig();
  if (key === 'swap') config.swapProvider = value;
  if (key === 'bridge') config.bridgeProvider = value;
  saveConfig(config);

  console.log(`\n  Set ${key} = ${value}\n`);
}

export function configResetCommand(): void {
  const defaults: WalletConfig = { swapProvider: 'auto', bridgeProvider: 'auto' };
  saveConfig(defaults);
  console.log('\n  Config reset to defaults (auto).\n');
}

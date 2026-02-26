import { createInterface } from 'readline';

export async function confirm(message: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`  ${message} [y/N] `, (answer) => {
      rl.close();
      resolve(answer.toLowerCase() === 'y');
    });
  });
}

export function validateAmount(amount: string): void {
  // Must be a plain decimal number — reject scientific notation, Infinity, hex, etc.
  if (!/^\d+(\.\d+)?$/.test(amount)) {
    console.error(`  Invalid amount: "${amount}". Must be a plain decimal number (e.g., "1.5").`);
    process.exit(1);
  }
  const num = Number(amount);
  if (num <= 0) {
    console.error(`  Invalid amount: "${amount}". Must be greater than zero.`);
    process.exit(1);
  }
}

export function validateNetwork(network: string): void {
  if (network !== 'mainnet' && network !== 'testnet') {
    console.error(`  Invalid network: "${network}". Must be "mainnet" or "testnet".`);
    process.exit(1);
  }
}

export function warnMainnet(network: string, dryRun?: boolean): void {
  if (dryRun) return; // dry-run banner is already shown
  if (network === 'mainnet') {
    console.log('  ⚠  MAINNET — real funds will be used\n');
  }
}

const DRY_RUN_BAR = '═'.repeat(44);

export async function select(message: string, max: number): Promise<number> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`  ${message} [1-${max}, 0 to cancel]: `, (answer) => {
      rl.close();
      const n = parseInt(answer.trim(), 10);
      resolve(n >= 1 && n <= max ? n : 0); // 0 = cancelled
    });
  });
}

export function warnDryRun(): void {
  console.log(`\n  ${DRY_RUN_BAR}`);
  console.log('  ║           DRY RUN — NO TX WILL SEND          ║');
  console.log(`  ${DRY_RUN_BAR}\n`);
}

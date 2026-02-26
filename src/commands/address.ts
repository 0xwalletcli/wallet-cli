import { listAddresses, addAddress, removeAddress } from '../lib/addressbook.js';
import { formatAddress } from '../lib/format.js';

export function addressListCommand() {
  const entries = listAddresses();
  if (entries.length === 0) {
    console.log('\n  Address book is empty. Use: wallet address add <name> --evm <addr> --solana <addr>\n');
    return;
  }

  console.log('\n  Address Book:\n');
  for (const e of entries) {
    console.log(`  ${e.name}`);
    if (e.evm) console.log(`    EVM:    ${e.evm}`);
    if (e.solana) console.log(`    Solana: ${e.solana}`);
  }
  console.log('');
}

export function addressAddCommand(name: string, opts: { evm?: string; solana?: string }) {
  if (!opts.evm && !opts.solana) {
    console.error('  Provide at least one of --evm or --solana');
    process.exit(1);
  }
  addAddress(name, opts.evm, opts.solana);
  console.log(`\n  Added "${name}" to address book.`);
  if (opts.evm) console.log(`    EVM:    ${opts.evm}`);
  if (opts.solana) console.log(`    Solana: ${opts.solana}`);
  console.log('');
}

export function addressRemoveCommand(name: string) {
  if (removeAddress(name)) {
    console.log(`\n  Removed "${name}" from address book.\n`);
  } else {
    console.log(`\n  "${name}" not found in address book.\n`);
  }
}

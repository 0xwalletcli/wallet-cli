import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const DATA_DIR = join(homedir(), '.wallet-cli');
const BOOK_PATH = join(DATA_DIR, 'addresses.json');

interface AddressEntry {
  name: string;
  evm?: string;
  solana?: string;
}

function load(): AddressEntry[] {
  if (!existsSync(BOOK_PATH)) return [];
  return JSON.parse(readFileSync(BOOK_PATH, 'utf-8'));
}

function save(entries: AddressEntry[]) {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(BOOK_PATH, JSON.stringify(entries, null, 2) + '\n');
}

export function listAddresses(): AddressEntry[] {
  return load();
}

export function addAddress(name: string, evm?: string, solana?: string) {
  const entries = load();
  const existing = entries.find(e => e.name.toLowerCase() === name.toLowerCase());
  if (existing) {
    if (evm) existing.evm = evm;
    if (solana) existing.solana = solana;
  } else {
    entries.push({ name, evm, solana });
  }
  save(entries);
}

export function removeAddress(name: string): boolean {
  const entries = load();
  const idx = entries.findIndex(e => e.name.toLowerCase() === name.toLowerCase());
  if (idx === -1) return false;
  entries.splice(idx, 1);
  save(entries);
  return true;
}

// Resolve a name or address — if it looks like an address, return as-is.
// Otherwise look up in the address book.
export function resolveAddress(nameOrAddress: string, chain: 'evm' | 'solana'): string {
  // Already an address
  if (chain === 'evm' && nameOrAddress.startsWith('0x')) return nameOrAddress;
  if (chain === 'solana' && nameOrAddress.length >= 32 && !nameOrAddress.includes(' ')) return nameOrAddress;

  const entries = load();
  const entry = entries.find(e => e.name.toLowerCase() === nameOrAddress.toLowerCase());
  if (!entry) throw new Error(`"${nameOrAddress}" not found in address book. Use 'wallet address add' first.`);

  const addr = chain === 'evm' ? entry.evm : entry.solana;
  if (!addr) throw new Error(`"${nameOrAddress}" has no ${chain} address registered.`);
  return addr;
}

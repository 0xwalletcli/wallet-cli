import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type { Network } from '../config.js';

const AUDIT_DIR = join(homedir(), '.wallet-cli');
const AUDIT_FILE = join(AUDIT_DIR, 'audit.json');
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export interface ServiceCheck {
  name: string;
  status: 'ok' | 'warn' | 'fail';
  details: string;
}

export interface AuditPrices {
  ethMarket: number | null;
  ethCow: number | null;
  solMarket: number | null;
  solJupiter: number | null;
  solDeBridge: number | null;
  wsolCow: number | null;
  stethRatio: number | null;
  usdcMarket: number | null;
}

export interface AuditRecord {
  timestamp: number;
  version: string;
  services: ServiceCheck[];
  prices: AuditPrices;
  passed: boolean;
}

export function loadAudit(): AuditRecord | null {
  try {
    if (!existsSync(AUDIT_FILE)) return null;
    const data = JSON.parse(readFileSync(AUDIT_FILE, 'utf-8'));
    if (!data.timestamp || !Array.isArray(data.services)) return null;
    // backward compat: old records may lack prices or new fields
    if (!data.prices) {
      data.prices = { ethMarket: null, ethCow: null, solMarket: null, solJupiter: null, solDeBridge: null, wsolCow: null, stethRatio: null, usdcMarket: null };
    } else {
      if (data.prices.wsolCow === undefined) data.prices.wsolCow = null;
      if (data.prices.stethRatio === undefined) data.prices.stethRatio = null;
      if (data.prices.usdcMarket === undefined) data.prices.usdcMarket = null;
    }
    return data as AuditRecord;
  } catch {
    return null;
  }
}

export function saveAudit(record: AuditRecord): void {
  if (!existsSync(AUDIT_DIR)) {
    mkdirSync(AUDIT_DIR, { recursive: true });
  }
  writeFileSync(AUDIT_FILE, JSON.stringify(record, null, 2));
}

export function checkAuditGate(network: Network, dryRun: boolean): void {
  if (network !== 'mainnet' || dryRun) return;

  const audit = loadAudit();

  if (!audit) {
    console.error('\n  MAINNET BLOCKED: No audit record found.');
    console.error('  Run \'wallet audit\' before using mainnet.\n');
    process.exit(1);
  }

  const ageMs = Date.now() - audit.timestamp;
  const ageDays = Math.floor(ageMs / (24 * 60 * 60 * 1000));

  if (ageMs > MAX_AGE_MS) {
    console.error(`\n  MAINNET BLOCKED: Last audit was ${ageDays} days ago (max 7).`);
    console.error('  Run \'wallet audit\' to refresh.\n');
    process.exit(1);
  }

  if (!audit.passed) {
    console.error('\n  MAINNET BLOCKED: Last audit had failures.');
    console.error('  Run \'wallet audit\' to review and fix.\n');
    process.exit(1);
  }
}

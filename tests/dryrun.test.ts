import { describe, it, expect } from 'vitest';

// ═══════════════════════════════════════════════════════════════
//  Dry-run default logic
//  Mainnet must default to dry-run (safe). Testnet defaults to live.
//  --run overrides mainnet default. --dry-run overrides testnet default.
// ═══════════════════════════════════════════════════════════════

// Replicate the getDryRun logic from index.ts
function getDryRun(args: string[], network: 'mainnet' | 'testnet'): boolean {
  if (args.includes('--dry-run')) return true;
  if (args.includes('--run')) return false;
  return network === 'mainnet';
}

describe('getDryRun', () => {
  describe('mainnet defaults', () => {
    it('defaults to dry-run on mainnet (no flags)', () => {
      expect(getDryRun([], 'mainnet')).toBe(true);
    });

    it('--run overrides mainnet default', () => {
      expect(getDryRun(['--run'], 'mainnet')).toBe(false);
    });

    it('--dry-run is explicit on mainnet (redundant but valid)', () => {
      expect(getDryRun(['--dry-run'], 'mainnet')).toBe(true);
    });
  });

  describe('testnet defaults', () => {
    it('defaults to live on testnet (no flags)', () => {
      expect(getDryRun([], 'testnet')).toBe(false);
    });

    it('--dry-run overrides testnet default', () => {
      expect(getDryRun(['--dry-run'], 'testnet')).toBe(true);
    });

    it('--run is explicit on testnet (redundant but valid)', () => {
      expect(getDryRun(['--run'], 'testnet')).toBe(false);
    });
  });

  describe('flag precedence', () => {
    it('--dry-run wins if both flags present', () => {
      // --dry-run is checked first in the code
      expect(getDryRun(['--dry-run', '--run'], 'mainnet')).toBe(true);
      expect(getDryRun(['--dry-run', '--run'], 'testnet')).toBe(true);
    });
  });
});

import { describe, it, expect } from 'vitest';
import { parseTokenAmount, formatToken, formatAddress, formatUSD } from '../src/lib/format.js';

// ═══════════════════════════════════════════════════════════════
//  parseTokenAmount — THE most critical function in the codebase.
//  Every swap, send, bridge, stake, unstake amount flows through it.
//  A single decimal-place bug = user sends wrong amount of money.
// ═══════════════════════════════════════════════════════════════

describe('parseTokenAmount', () => {
  // ── USDC (6 decimals) ──
  describe('USDC (6 decimals)', () => {
    it('parses whole numbers', () => {
      expect(parseTokenAmount('100', 6)).toBe(100_000_000n);
    });

    it('parses decimals up to full precision', () => {
      expect(parseTokenAmount('1.5', 6)).toBe(1_500_000n);
      expect(parseTokenAmount('100.123456', 6)).toBe(100_123_456n);
    });

    it('truncates excess decimals (does NOT round)', () => {
      // 1.1234569 → should truncate to 1.123456, NOT round to 1.123457
      expect(parseTokenAmount('1.1234569', 6)).toBe(1_123_456n);
    });

    it('parses the smallest unit', () => {
      expect(parseTokenAmount('0.000001', 6)).toBe(1n);
    });

    it('returns 0n for amounts below smallest unit', () => {
      expect(parseTokenAmount('0.0000001', 6)).toBe(0n);
    });

    it('parses zero', () => {
      expect(parseTokenAmount('0', 6)).toBe(0n);
      expect(parseTokenAmount('0.0', 6)).toBe(0n);
    });

    it('handles large amounts', () => {
      expect(parseTokenAmount('1000000', 6)).toBe(1_000_000_000_000n);
      expect(parseTokenAmount('999999.999999', 6)).toBe(999_999_999_999n);
    });
  });

  // ── ETH/WETH (18 decimals) ──
  describe('ETH (18 decimals)', () => {
    it('parses whole numbers', () => {
      expect(parseTokenAmount('1', 18)).toBe(1_000_000_000_000_000_000n);
    });

    it('parses common amounts', () => {
      expect(parseTokenAmount('0.5', 18)).toBe(500_000_000_000_000_000n);
      expect(parseTokenAmount('0.1', 18)).toBe(100_000_000_000_000_000n);
      expect(parseTokenAmount('0.01', 18)).toBe(10_000_000_000_000_000n);
      expect(parseTokenAmount('0.001', 18)).toBe(1_000_000_000_000_000n);
    });

    it('parses full 18-decimal precision', () => {
      expect(parseTokenAmount('0.000000000000000001', 18)).toBe(1n);
    });

    it('truncates excess decimals', () => {
      expect(parseTokenAmount('1.0000000000000000019', 18)).toBe(1_000_000_000_000_000_001n);
    });

    it('handles large ETH values', () => {
      expect(parseTokenAmount('100', 18)).toBe(100_000_000_000_000_000_000n);
    });
  });

  // ── SOL (9 decimals) ──
  describe('SOL (9 decimals)', () => {
    it('parses whole numbers', () => {
      expect(parseTokenAmount('1', 9)).toBe(1_000_000_000n);
    });

    it('parses common amounts', () => {
      expect(parseTokenAmount('0.5', 9)).toBe(500_000_000n);
      expect(parseTokenAmount('10.123456789', 9)).toBe(10_123_456_789n);
    });

    it('parses the smallest unit (1 lamport)', () => {
      expect(parseTokenAmount('0.000000001', 9)).toBe(1n);
    });
  });

  // ── Edge cases ──
  describe('edge cases', () => {
    it('handles no decimal part', () => {
      expect(parseTokenAmount('42', 6)).toBe(42_000_000n);
    });

    it('handles trailing dot', () => {
      // "42." → parts[1] is "" → padded to "000000"
      expect(parseTokenAmount('42.', 6)).toBe(42_000_000n);
    });

    it('handles leading zeros in whole part', () => {
      expect(parseTokenAmount('007', 6)).toBe(7_000_000n);
    });
  });
});

// ═══════════════════════════════════════════════════════════════
//  formatToken — display values to user
// ═══════════════════════════════════════════════════════════════

describe('formatToken', () => {
  it('formats with default 6 decimals', () => {
    const result = formatToken(1.123456789);
    expect(result).toContain('1.12345');
  });

  it('formats with 2 decimals for USDC', () => {
    const result = formatToken(100.5, 2);
    expect(result).toBe('100.50');
  });

  it('formats zero', () => {
    expect(formatToken(0, 2)).toBe('0.00');
    // minimumFractionDigits is 2, so formatToken(0, 6) gives '0.00' not '0.000000'
    expect(formatToken(0, 6)).toBe('0.00');
  });

  it('includes thousands separators', () => {
    const result = formatToken(1234567.89, 2);
    expect(result).toBe('1,234,567.89');
  });

  it('formats very small values', () => {
    const result = formatToken(0.000001, 6);
    expect(result).toBe('0.000001');
  });
});

// ═══════════════════════════════════════════════════════════════
//  formatAddress — truncate for display
// ═══════════════════════════════════════════════════════════════

describe('formatAddress', () => {
  it('truncates long EVM addresses', () => {
    const addr = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';
    const result = formatAddress(addr, 6);
    expect(result).toBe('0xd8dA6B...A96045');
    expect(result.length).toBeLessThan(addr.length);
  });

  it('returns short strings as-is', () => {
    expect(formatAddress('0xABCD', 6)).toBe('0xABCD');
  });

  it('truncates Solana addresses', () => {
    const addr = 'DRpbCBMxVnDK7maPM5tGv6MvB3v1sRMC86PZ8okm21hy';
    const result = formatAddress(addr, 4);
    // formatAddress uses chars+2 for prefix, chars for suffix (EVM-oriented with 0x)
    // For non-0x addresses: first 6 chars + ... + last 4 chars
    expect(result).toBe('DRpbCB...21hy');
  });
});

// ═══════════════════════════════════════════════════════════════
//  formatUSD
// ═══════════════════════════════════════════════════════════════

describe('formatUSD', () => {
  it('formats dollars', () => {
    expect(formatUSD(1234.5)).toBe('$1,234.50');
  });

  it('formats with custom decimals', () => {
    expect(formatUSD(1234.5678, 4)).toBe('$1,234.5678');
  });
});

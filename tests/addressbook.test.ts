import { describe, it, expect } from 'vitest';

// ═══════════════════════════════════════════════════════════════
//  Address detection logic from balance.ts
//  Used to determine if user input is an EVM address, Solana
//  address, or alias. Wrong detection = wrong chain = lost funds.
// ═══════════════════════════════════════════════════════════════

function isEvmAddress(s: string): boolean {
  return s.startsWith('0x') && s.length === 42;
}

function isSolanaAddress(s: string): boolean {
  return !s.startsWith('0x') && s.length >= 32 && s.length <= 44 && /^[1-9A-HJ-NP-Za-km-z]+$/.test(s);
}

describe('isEvmAddress', () => {
  it('recognizes valid EVM addresses', () => {
    expect(isEvmAddress('0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045')).toBe(true);
    expect(isEvmAddress('0x0000000000000000000000000000000000000001')).toBe(true);
  });

  it('rejects short hex strings', () => {
    expect(isEvmAddress('0xABCD')).toBe(false);
  });

  it('rejects addresses without 0x prefix', () => {
    expect(isEvmAddress('d8dA6BF26964aF9D7eEd9e03E53415D37aA96045')).toBe(false);
  });

  it('rejects Solana addresses', () => {
    expect(isEvmAddress('DRpbCBMxVnDK7maPM5tGv6MvB3v1sRMC86PZ8okm21hy')).toBe(false);
  });

  it('rejects plain names', () => {
    expect(isEvmAddress('alice')).toBe(false);
    expect(isEvmAddress('coinbase-eth')).toBe(false);
  });
});

describe('isSolanaAddress', () => {
  it('recognizes valid Solana addresses', () => {
    expect(isSolanaAddress('DRpbCBMxVnDK7maPM5tGv6MvB3v1sRMC86PZ8okm21hy')).toBe(true);
    expect(isSolanaAddress('11111111111111111111111111111111')).toBe(true); // system program
    expect(isSolanaAddress('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v')).toBe(true); // USDC mint
  });

  it('rejects EVM addresses', () => {
    expect(isSolanaAddress('0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045')).toBe(false);
  });

  it('rejects short strings (aliases)', () => {
    expect(isSolanaAddress('alice')).toBe(false);
    expect(isSolanaAddress('coinbase')).toBe(false);
  });

  it('rejects strings with invalid base58 characters', () => {
    // Base58 excludes 0, O, I, l
    expect(isSolanaAddress('0RpbCBMxVnDK7maPM5tGv6MvB3v1sRMC86PZ8okm21hy')).toBe(false);
    expect(isSolanaAddress('ORpbCBMxVnDK7maPM5tGv6MvB3v1sRMC86PZ8okm21hy')).toBe(false);
    expect(isSolanaAddress('IRpbCBMxVnDK7maPM5tGv6MvB3v1sRMC86PZ8okm21hy')).toBe(false);
    expect(isSolanaAddress('lRpbCBMxVnDK7maPM5tGv6MvB3v1sRMC86PZ8okm21hy')).toBe(false);
  });

  it('rejects strings with spaces or special characters', () => {
    expect(isSolanaAddress('DRpbCBMx VnDK7maPM5tGv6MvB3v1sRMC86PZ8okm21h')).toBe(false);
    expect(isSolanaAddress('DRpbCBMx-VnDK7maPM5tGv6MvB3v1sRMC86PZ8okm21h')).toBe(false);
  });
});

describe('address type detection priority', () => {
  // Simulate the detection logic from balance.ts
  function detectAddressType(s: string): 'evm' | 'solana' | 'alias' {
    if (isEvmAddress(s)) return 'evm';
    if (isSolanaAddress(s)) return 'solana';
    return 'alias';
  }

  it('correctly classifies all address types', () => {
    expect(detectAddressType('0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045')).toBe('evm');
    expect(detectAddressType('DRpbCBMxVnDK7maPM5tGv6MvB3v1sRMC86PZ8okm21hy')).toBe('solana');
    expect(detectAddressType('alice')).toBe('alias');
    expect(detectAddressType('coinbase-eth')).toBe('alias');
  });

  it('does not misclassify aliases as Solana addresses', () => {
    // Aliases could theoretically match Solana length if long enough
    // but should fail the base58 regex if they contain hyphens
    expect(detectAddressType('my-very-long-address-book-entry-name')).toBe('alias');
  });
});

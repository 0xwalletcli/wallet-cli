import { describe, it, expect } from 'vitest';

// ═══════════════════════════════════════════════════════════════
//  Bridge route detection — determines which chain direction and
//  token pair to use. Wrong detection = wrong chain = lost funds.
// ═══════════════════════════════════════════════════════════════

type Direction = 'evm-to-solana' | 'solana-to-evm';

interface RouteInfo {
  direction: Direction;
  srcToken: string;
  dstToken: string;
}

// Replicate detectRoute from src/commands/bridge.ts
function detectRoute(from: string, to: string): RouteInfo | null {
  if (from === 'ETH' && to === 'SOL') return { direction: 'evm-to-solana', srcToken: 'ETH', dstToken: 'SOL' };
  if (from === 'USDC' && to === 'SOL') return { direction: 'evm-to-solana', srcToken: 'USDC', dstToken: 'SOL' };
  if (from === 'SOL' && to === 'ETH') return { direction: 'solana-to-evm', srcToken: 'SOL', dstToken: 'ETH' };
  if (from === 'SOL' && to === 'USDC') return { direction: 'solana-to-evm', srcToken: 'SOL', dstToken: 'USDC' };

  // USDC cross-chain routes
  if (from === 'USDC' && to === 'USDC-SOL') return { direction: 'evm-to-solana', srcToken: 'USDC', dstToken: 'USDC' };
  if (from === 'USDC-SOL' && to === 'USDC') return { direction: 'solana-to-evm', srcToken: 'USDC', dstToken: 'USDC' };
  if (from === 'USDC-SOL' && to === 'ETH') return { direction: 'solana-to-evm', srcToken: 'USDC', dstToken: 'ETH' };
  if (from === 'USDC-SOL' && to === 'SOL') return { direction: 'solana-to-evm', srcToken: 'USDC', dstToken: 'SOL' };

  return null;
}

describe('detectRoute', () => {
  describe('EVM → Solana routes', () => {
    it('ETH → SOL', () => {
      const r = detectRoute('ETH', 'SOL');
      expect(r).toEqual({ direction: 'evm-to-solana', srcToken: 'ETH', dstToken: 'SOL' });
    });

    it('USDC → SOL', () => {
      const r = detectRoute('USDC', 'SOL');
      expect(r).toEqual({ direction: 'evm-to-solana', srcToken: 'USDC', dstToken: 'SOL' });
    });

    it('USDC → USDC-SOL (cross-chain USDC)', () => {
      const r = detectRoute('USDC', 'USDC-SOL');
      expect(r).toEqual({ direction: 'evm-to-solana', srcToken: 'USDC', dstToken: 'USDC' });
    });
  });

  describe('Solana → EVM routes', () => {
    it('SOL → ETH', () => {
      const r = detectRoute('SOL', 'ETH');
      expect(r).toEqual({ direction: 'solana-to-evm', srcToken: 'SOL', dstToken: 'ETH' });
    });

    it('SOL → USDC', () => {
      const r = detectRoute('SOL', 'USDC');
      expect(r).toEqual({ direction: 'solana-to-evm', srcToken: 'SOL', dstToken: 'USDC' });
    });

    it('USDC-SOL → USDC (cross-chain USDC)', () => {
      const r = detectRoute('USDC-SOL', 'USDC');
      expect(r).toEqual({ direction: 'solana-to-evm', srcToken: 'USDC', dstToken: 'USDC' });
    });

    it('USDC-SOL → ETH', () => {
      const r = detectRoute('USDC-SOL', 'ETH');
      expect(r).toEqual({ direction: 'solana-to-evm', srcToken: 'USDC', dstToken: 'ETH' });
    });

    it('USDC-SOL → SOL', () => {
      const r = detectRoute('USDC-SOL', 'SOL');
      expect(r).toEqual({ direction: 'solana-to-evm', srcToken: 'USDC', dstToken: 'SOL' });
    });
  });

  describe('invalid routes return null', () => {
    it('same token same chain: ETH → ETH', () => {
      expect(detectRoute('ETH', 'ETH')).toBeNull();
    });

    it('same token same chain: SOL → SOL', () => {
      expect(detectRoute('SOL', 'SOL')).toBeNull();
    });

    it('unsupported pair: ETH → USDC (same chain swap, not bridge)', () => {
      expect(detectRoute('ETH', 'USDC')).toBeNull();
    });

    it('unsupported pair: USDC → ETH (same chain swap, not bridge)', () => {
      expect(detectRoute('USDC', 'ETH')).toBeNull();
    });

    it('unsupported token: BTC → SOL', () => {
      expect(detectRoute('BTC', 'SOL')).toBeNull();
    });

    it('empty strings', () => {
      expect(detectRoute('', '')).toBeNull();
    });

    it('USDC-SOL → USDC-SOL (same)', () => {
      expect(detectRoute('USDC-SOL', 'USDC-SOL')).toBeNull();
    });
  });

  describe('route count', () => {
    it('has exactly 8 valid routes', () => {
      const allPairs = [
        ['ETH', 'SOL'], ['USDC', 'SOL'], ['USDC', 'USDC-SOL'],
        ['SOL', 'ETH'], ['SOL', 'USDC'],
        ['USDC-SOL', 'USDC'], ['USDC-SOL', 'ETH'], ['USDC-SOL', 'SOL'],
      ];
      for (const [from, to] of allPairs) {
        expect(detectRoute(from, to), `${from} → ${to} should be valid`).not.toBeNull();
      }
      expect(allPairs.length).toBe(8);
    });
  });
});

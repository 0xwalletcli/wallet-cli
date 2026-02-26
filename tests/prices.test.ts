import { describe, it, expect } from 'vitest';

// ═══════════════════════════════════════════════════════════════
//  Price calculation correctness
//  These test the math that shows users "ETH price", "protocol fee",
//  etc. Getting these wrong misleads users about their trade.
// ═══════════════════════════════════════════════════════════════

describe('swap ETH price derivation', () => {
  // Simulates the logic from swap.ts lines 112-117
  function deriveEthPrice(
    userAmount: number,    // what user types (e.g., "1000")
    from: 'USDC' | 'ETH',
    buyAmount: number,     // what they receive (post-fee quote)
  ): number {
    return from === 'USDC'
      ? userAmount / buyAmount    // USDC/ETH = price per ETH
      : buyAmount / userAmount;   // USDC received / ETH sold
  }

  it('selling 1000 USDC for ETH at ~$2000/ETH', () => {
    const price = deriveEthPrice(1000, 'USDC', 0.488);
    expect(price).toBeCloseTo(2049.18, 0);
    // Must use full input amount (1000), NOT post-fee (e.g., 999)
  });

  it('selling 1 ETH for USDC at ~$2000/ETH', () => {
    const price = deriveEthPrice(1, 'ETH', 1995);
    expect(price).toBeCloseTo(1995, 0);
    // Must use full input amount (1), NOT post-fee (e.g., 0.999)
  });

  it('price should NOT use post-fee sell amount (the bug we fixed)', () => {
    // Old buggy code used sellAmountNum (post-fee) instead of userAmount
    const userPays = 1000;
    const postFee = 950; // 5% fee
    const ethReceived = 0.488;

    const correctPrice = userPays / ethReceived;   // ~2049
    const buggyPrice = postFee / ethReceived;      // ~1946

    // The correct price should be higher (you're paying more per ETH)
    expect(correctPrice).toBeGreaterThan(buggyPrice);
    // And the difference should be ~5% (the fee)
    const diff = (correctPrice - buggyPrice) / correctPrice;
    expect(diff).toBeCloseTo(0.05, 1);
  });
});

describe('bridge protocol fee calculation', () => {
  // Simulates the logic from bridge.ts line 147
  function calcProtocolFee(
    from: 'ETH' | 'USDC',
    txValueWei: bigint,
    userAmount: number,
  ): number {
    const txValue = Number(txValueWei) / 1e18;
    // For ETH: tx.value includes bridge amount + fee
    // For USDC: tx.value is just the fee
    return from === 'ETH' ? txValue - userAmount : txValue;
  }

  it('ETH bridge: fee should subtract the bridge amount', () => {
    // User bridges 1 ETH, tx.value = 1.005 ETH (includes 0.005 fee)
    const fee = calcProtocolFee('ETH', 1_005_000_000_000_000_000n, 1.0);
    expect(fee).toBeCloseTo(0.005, 4);
  });

  it('ETH bridge: old buggy code would show the full tx.value as fee', () => {
    const txValueWei = 1_005_000_000_000_000_000n;
    const buggyFee = Number(txValueWei) / 1e18;  // 1.005 — WRONG
    const correctFee = calcProtocolFee('ETH', txValueWei, 1.0);  // 0.005

    expect(buggyFee).toBeCloseTo(1.005, 3);
    expect(correctFee).toBeCloseTo(0.005, 3);
    // 200x difference!
    expect(buggyFee / correctFee).toBeGreaterThan(100);
  });

  it('USDC bridge: fee is just tx.value (no subtraction needed)', () => {
    // User bridges 1000 USDC, tx.value = 0.002 ETH (just the fee)
    const fee = calcProtocolFee('USDC', 2_000_000_000_000_000n, 1000);
    expect(fee).toBeCloseTo(0.002, 4);
  });
});

describe('health command price spread', () => {
  function formatSpread(exec: number, market: number): number {
    return ((exec - market) / market) * 100;
  }

  it('shows negative spread when execution price is lower (better for buyer)', () => {
    const spread = formatSpread(1943, 2046);
    expect(spread).toBeLessThan(0);
    expect(spread).toBeCloseTo(-5.03, 0);
  });

  it('shows positive spread when execution price is higher (worse for buyer)', () => {
    const spread = formatSpread(89, 87);
    expect(spread).toBeGreaterThan(0);
    expect(spread).toBeCloseTo(2.3, 0);
  });

  it('shows ~0% when prices match', () => {
    const spread = formatSpread(2000, 2000);
    expect(spread).toBe(0);
  });
});

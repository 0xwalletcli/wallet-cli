import { describe, it, expect } from 'vitest';

// ═══════════════════════════════════════════════════════════════
//  Audit price sanity — evaluateSpread is the core function
//  that decides if execution prices are safe vs dangerous.
//  Wrong thresholds = either false confidence or false lockout.
// ═══════════════════════════════════════════════════════════════

// Replicate from src/commands/audit.ts
const SPREAD_WARN = 5;
const SPREAD_FAIL = 10;

function evaluateSpread(exec: number | null, market: number | null): 'ok' | 'warn' | 'fail' {
  if (exec == null || market == null || market === 0) return 'fail';
  const spread = Math.abs((exec - market) / market) * 100;
  if (spread > SPREAD_FAIL) return 'fail';
  if (spread > SPREAD_WARN) return 'warn';
  return 'ok';
}

describe('evaluateSpread', () => {
  describe('null/missing data', () => {
    it('fails when exec price is null', () => {
      expect(evaluateSpread(null, 2000)).toBe('fail');
    });

    it('fails when market price is null', () => {
      expect(evaluateSpread(2000, null)).toBe('fail');
    });

    it('fails when both are null', () => {
      expect(evaluateSpread(null, null)).toBe('fail');
    });

    it('fails when market is zero (division by zero)', () => {
      expect(evaluateSpread(2000, 0)).toBe('fail');
    });
  });

  describe('ok range (< 5%)', () => {
    it('passes when prices match exactly', () => {
      expect(evaluateSpread(2000, 2000)).toBe('ok');
    });

    it('passes at 1% over market', () => {
      expect(evaluateSpread(2020, 2000)).toBe('ok');
    });

    it('passes at 1% under market', () => {
      expect(evaluateSpread(1980, 2000)).toBe('ok');
    });

    it('passes at 4.9% spread', () => {
      expect(evaluateSpread(2098, 2000)).toBe('ok');
    });
  });

  describe('warn range (5-10%)', () => {
    it('warns at exactly 5.1% over', () => {
      expect(evaluateSpread(2102, 2000)).toBe('warn');
    });

    it('warns at 7% spread', () => {
      expect(evaluateSpread(2140, 2000)).toBe('warn');
    });

    it('warns at 9.9% spread', () => {
      expect(evaluateSpread(2198, 2000)).toBe('warn');
    });

    it('warns for negative spread (exec below market)', () => {
      // exec = 1890, market = 2000 → 5.5% under
      expect(evaluateSpread(1890, 2000)).toBe('warn');
    });
  });

  describe('fail range (> 10%)', () => {
    it('fails at 10.1% over', () => {
      expect(evaluateSpread(2202, 2000)).toBe('fail');
    });

    it('fails at 20% spread', () => {
      expect(evaluateSpread(2400, 2000)).toBe('fail');
    });

    it('fails at 50% under market (execution way too cheap = suspicious)', () => {
      expect(evaluateSpread(1000, 2000)).toBe('fail');
    });
  });

  describe('real-world scenarios', () => {
    it('ETH: CoW Swap $2548 vs CoinGecko $2543 → ok (0.2%)', () => {
      expect(evaluateSpread(2548, 2543)).toBe('ok');
    });

    it('SOL: Jupiter $188 vs CoinGecko $187 → ok (0.5%)', () => {
      expect(evaluateSpread(188, 187)).toBe('ok');
    });

    it('SOL: deBridge $200 vs CoinGecko $187 → warn (7%)', () => {
      expect(evaluateSpread(200, 187)).toBe('warn');
    });

    it('ETH: stale oracle $1800 vs market $2500 → fail (28%)', () => {
      expect(evaluateSpread(1800, 2500)).toBe('fail');
    });
  });
});

// ═══════════════════════════════════════════════════════════════
//  Pool health thresholds
// ═══════════════════════════════════════════════════════════════

const MIN_LIDO_SUPPLY = 1_000_000;
const MIN_JITO_POOL = 100_000;
const JITO_RATE_MIN = 1.0;
const JITO_RATE_MAX = 2.0;

function evaluateLidoHealth(supplyEth: number): 'ok' | 'fail' {
  return supplyEth >= MIN_LIDO_SUPPLY ? 'ok' : 'fail';
}

function evaluateJitoHealth(poolSol: number, rate: number): 'ok' | 'fail' {
  if (poolSol < MIN_JITO_POOL) return 'fail';
  if (rate < JITO_RATE_MIN || rate > JITO_RATE_MAX) return 'fail';
  return 'ok';
}

describe('evaluateLidoHealth', () => {
  it('passes with 9.4M stETH (current real value)', () => {
    expect(evaluateLidoHealth(9_427_190)).toBe('ok');
  });

  it('passes at exactly 1M threshold', () => {
    expect(evaluateLidoHealth(1_000_000)).toBe('ok');
  });

  it('fails below 1M stETH', () => {
    expect(evaluateLidoHealth(999_999)).toBe('fail');
  });

  it('fails at zero (contract broken)', () => {
    expect(evaluateLidoHealth(0)).toBe('fail');
  });
});

describe('evaluateJitoHealth', () => {
  it('passes with 12.7M SOL and rate 1.18 (current real values)', () => {
    expect(evaluateJitoHealth(12_766_229, 1.1823)).toBe('ok');
  });

  it('passes at minimum threshold', () => {
    expect(evaluateJitoHealth(100_000, 1.0)).toBe('ok');
  });

  it('fails when pool is too small', () => {
    expect(evaluateJitoHealth(99_999, 1.1)).toBe('fail');
  });

  it('fails when rate is below 1.0 (JitoSOL worth less than SOL — broken)', () => {
    expect(evaluateJitoHealth(1_000_000, 0.95)).toBe('fail');
  });

  it('fails when rate is above 2.0 (suspiciously high)', () => {
    expect(evaluateJitoHealth(1_000_000, 2.1)).toBe('fail');
  });

  it('passes at rate boundary max', () => {
    expect(evaluateJitoHealth(1_000_000, 2.0)).toBe('ok');
  });
});

// ═══════════════════════════════════════════════════════════════
//  stETH/ETH ratio evaluation
// ═══════════════════════════════════════════════════════════════

function evaluateStethRatio(ratio: number): 'ok' | 'warn' | 'fail' {
  if (ratio < 1.0) return 'fail';
  if (ratio > 1.5) return 'warn';
  return 'ok';
}

describe('evaluateStethRatio', () => {
  it('passes at exactly 1.0 (launch value)', () => {
    expect(evaluateStethRatio(1.0)).toBe('ok');
  });

  it('passes at 1.228 (current real value ~2026)', () => {
    expect(evaluateStethRatio(1.228)).toBe('ok');
  });

  it('passes at 1.1 (normal accrual)', () => {
    expect(evaluateStethRatio(1.1)).toBe('ok');
  });

  it('passes at 1.5 (upper boundary)', () => {
    expect(evaluateStethRatio(1.5)).toBe('ok');
  });

  it('warns at 1.51 (unexpectedly high)', () => {
    expect(evaluateStethRatio(1.51)).toBe('warn');
  });

  it('fails at 0.99 (below 1.0 — slashing event)', () => {
    expect(evaluateStethRatio(0.99)).toBe('fail');
  });

  it('fails at 0.5 (catastrophic — half the ETH gone)', () => {
    expect(evaluateStethRatio(0.5)).toBe('fail');
  });

  it('fails at 0.0 (completely broken)', () => {
    expect(evaluateStethRatio(0.0)).toBe('fail');
  });
});

// ═══════════════════════════════════════════════════════════════
//  USDC peg evaluation
// ═══════════════════════════════════════════════════════════════

function evaluateUsdcPeg(price: number): 'ok' | 'warn' | 'fail' {
  const deviation = Math.abs(price - 1.0);
  if (deviation > 0.02) return 'fail';
  if (deviation > 0.01) return 'warn';
  return 'ok';
}

describe('evaluateUsdcPeg', () => {
  it('passes at exactly $1.00', () => {
    expect(evaluateUsdcPeg(1.0)).toBe('ok');
  });

  it('passes at $1.001 (normal)', () => {
    expect(evaluateUsdcPeg(1.001)).toBe('ok');
  });

  it('passes at $0.999 (normal)', () => {
    expect(evaluateUsdcPeg(0.999)).toBe('ok');
  });

  it('warns at $1.015 (>1% above peg)', () => {
    expect(evaluateUsdcPeg(1.015)).toBe('warn');
  });

  it('warns at $0.985 (>1% below peg)', () => {
    expect(evaluateUsdcPeg(0.985)).toBe('warn');
  });

  it('fails at $1.025 (>2% above peg)', () => {
    expect(evaluateUsdcPeg(1.025)).toBe('fail');
  });

  it('fails at $0.975 (>2% below peg — depeg!)', () => {
    expect(evaluateUsdcPeg(0.975)).toBe('fail');
  });

  it('warns at boundary $1.01 (floating point: 1.01-1.0 > 0.01)', () => {
    expect(evaluateUsdcPeg(1.01)).toBe('warn');
  });

  it('passes at $1.009 (just under 1% boundary)', () => {
    expect(evaluateUsdcPeg(1.009)).toBe('ok');
  });

  it('warns at boundary $1.011', () => {
    expect(evaluateUsdcPeg(1.011)).toBe('warn');
  });

  it('fails at $0.90 (severe depeg like USDC March 2023)', () => {
    expect(evaluateUsdcPeg(0.90)).toBe('fail');
  });
});

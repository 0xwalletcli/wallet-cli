import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ═══════════════════════════════════════════════════════════════
//  validateAmount — guards every write command from bad input.
//  If this passes bad input, parseTokenAmount can crash or
//  produce wildly wrong amounts that get sent on-chain.
// ═══════════════════════════════════════════════════════════════

// We need to test that validateAmount calls process.exit(1) for bad input.
// Import the module fresh for each test.

describe('validateAmount', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called');
    }) as any);
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    exitSpy.mockRestore();
    errorSpy.mockRestore();
  });

  async function getValidateAmount() {
    const mod = await import('../src/lib/prompt.js');
    return mod.validateAmount;
  }

  // ── Valid amounts (should NOT exit) ──

  it('accepts plain integers', async () => {
    const validateAmount = await getValidateAmount();
    expect(() => validateAmount('100')).not.toThrow();
  });

  it('accepts plain decimals', async () => {
    const validateAmount = await getValidateAmount();
    expect(() => validateAmount('1.5')).not.toThrow();
    expect(() => validateAmount('0.001')).not.toThrow();
    expect(() => validateAmount('0.000001')).not.toThrow();
  });

  it('accepts large amounts', async () => {
    const validateAmount = await getValidateAmount();
    expect(() => validateAmount('999999.999999')).not.toThrow();
  });

  // ── Invalid amounts that MUST be rejected ──

  it('rejects zero', async () => {
    const validateAmount = await getValidateAmount();
    expect(() => validateAmount('0')).toThrow();
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('rejects negative numbers', async () => {
    const validateAmount = await getValidateAmount();
    expect(() => validateAmount('-1')).toThrow();
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('rejects NaN strings', async () => {
    const validateAmount = await getValidateAmount();
    expect(() => validateAmount('abc')).toThrow();
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('rejects empty string', async () => {
    const validateAmount = await getValidateAmount();
    expect(() => validateAmount('')).toThrow();
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  // ── Dangerous edge cases that MUST be rejected ──
  // These pass Number() > 0 but would crash or produce wrong values in parseTokenAmount

  it('rejects scientific notation (1e18)', async () => {
    const validateAmount = await getValidateAmount();
    expect(() => validateAmount('1e18')).toThrow();
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('rejects negative scientific notation (1e-7)', async () => {
    const validateAmount = await getValidateAmount();
    expect(() => validateAmount('1e-7')).toThrow();
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('rejects Infinity', async () => {
    const validateAmount = await getValidateAmount();
    expect(() => validateAmount('Infinity')).toThrow();
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('rejects hex notation', async () => {
    const validateAmount = await getValidateAmount();
    expect(() => validateAmount('0xff')).toThrow();
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('rejects amounts with spaces', async () => {
    const validateAmount = await getValidateAmount();
    expect(() => validateAmount('1 000')).toThrow();
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('rejects amounts with commas', async () => {
    const validateAmount = await getValidateAmount();
    expect(() => validateAmount('1,000')).toThrow();
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

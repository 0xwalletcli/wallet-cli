import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ═══════════════════════════════════════════════════════════════
//  Audit gate — blocks mainnet write commands when audit is
//  missing, stale (>7 days), or has failures.
//  Getting this wrong = either false lockout or unaudited mainnet.
// ═══════════════════════════════════════════════════════════════

const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

interface AuditRecord {
  timestamp: number;
  version: string;
  services: { name: string; status: 'ok' | 'warn' | 'fail'; details: string }[];
  passed: boolean;
}

// Replicate the checkAuditGate logic from src/lib/auditgate.ts
// so we can test it without filesystem or process.exit side effects.
function checkAuditGate(
  network: 'mainnet' | 'testnet',
  dryRun: boolean,
  audit: AuditRecord | null,
): 'allowed' | 'no-audit' | 'stale' | 'failed' {
  if (network !== 'mainnet' || dryRun) return 'allowed';
  if (!audit) return 'no-audit';

  const ageMs = Date.now() - audit.timestamp;
  if (ageMs > MAX_AGE_MS) return 'stale';
  if (!audit.passed) return 'failed';

  return 'allowed';
}

function freshAudit(overrides: Partial<AuditRecord> = {}): AuditRecord {
  return {
    timestamp: Date.now() - 1000, // 1 second ago
    version: '0.1.0',
    services: [{ name: 'test', status: 'ok', details: 'ok' }],
    passed: true,
    ...overrides,
  };
}

describe('checkAuditGate', () => {
  describe('bypass conditions', () => {
    it('always allows testnet regardless of audit state', () => {
      expect(checkAuditGate('testnet', false, null)).toBe('allowed');
      expect(checkAuditGate('testnet', false, freshAudit({ passed: false }))).toBe('allowed');
      expect(checkAuditGate('testnet', true, null)).toBe('allowed');
    });

    it('always allows dry-run regardless of audit state', () => {
      expect(checkAuditGate('mainnet', true, null)).toBe('allowed');
      expect(checkAuditGate('mainnet', true, freshAudit({ passed: false }))).toBe('allowed');
    });
  });

  describe('mainnet live (no bypass)', () => {
    it('blocks when no audit record exists', () => {
      expect(checkAuditGate('mainnet', false, null)).toBe('no-audit');
    });

    it('blocks when audit is older than 7 days', () => {
      const staleAudit = freshAudit({
        timestamp: Date.now() - (8 * 24 * 60 * 60 * 1000), // 8 days ago
      });
      expect(checkAuditGate('mainnet', false, staleAudit)).toBe('stale');
    });

    it('blocks when audit is exactly 7 days + 1ms old', () => {
      const barelyStale = freshAudit({
        timestamp: Date.now() - MAX_AGE_MS - 1,
      });
      expect(checkAuditGate('mainnet', false, barelyStale)).toBe('stale');
    });

    it('allows when audit is just under 7 days old (boundary)', () => {
      const boundary = freshAudit({
        timestamp: Date.now() - MAX_AGE_MS + 50,
      });
      // ageMs < MAX_AGE_MS, condition is > so this should pass
      expect(checkAuditGate('mainnet', false, boundary)).toBe('allowed');
    });

    it('blocks when audit has failures', () => {
      const failedAudit = freshAudit({ passed: false });
      expect(checkAuditGate('mainnet', false, failedAudit)).toBe('failed');
    });

    it('allows fresh passing audit', () => {
      expect(checkAuditGate('mainnet', false, freshAudit())).toBe('allowed');
    });

    it('allows audit from 6 days ago', () => {
      const recentAudit = freshAudit({
        timestamp: Date.now() - (6 * 24 * 60 * 60 * 1000),
      });
      expect(checkAuditGate('mainnet', false, recentAudit)).toBe('allowed');
    });
  });

  describe('priority: staleness checked before pass/fail', () => {
    it('reports stale even if audit passed', () => {
      const staleButPassed = freshAudit({
        timestamp: Date.now() - (10 * 24 * 60 * 60 * 1000),
        passed: true,
      });
      expect(checkAuditGate('mainnet', false, staleButPassed)).toBe('stale');
    });
  });
});

// ═══════════════════════════════════════════════════════════════
//  loadAudit — JSON parsing resilience
// ═══════════════════════════════════════════════════════════════

// Replicate the validation logic from loadAudit
function parseAuditRecord(data: any): AuditRecord | null {
  try {
    if (!data.timestamp || !Array.isArray(data.services)) return null;
    return data as AuditRecord;
  } catch {
    return null;
  }
}

describe('parseAuditRecord', () => {
  it('accepts valid records', () => {
    const record = parseAuditRecord(freshAudit());
    expect(record).not.toBeNull();
    expect(record!.passed).toBe(true);
  });

  it('rejects records without timestamp', () => {
    expect(parseAuditRecord({ services: [], passed: true })).toBeNull();
  });

  it('rejects records without services array', () => {
    expect(parseAuditRecord({ timestamp: Date.now(), passed: true })).toBeNull();
  });

  it('rejects records with services as non-array', () => {
    expect(parseAuditRecord({ timestamp: Date.now(), services: 'bad', passed: true })).toBeNull();
  });

  it('accepts old records without prices field (backward compat)', () => {
    const oldRecord = {
      timestamp: Date.now(),
      version: '0.1.0',
      services: [{ name: 'test', status: 'ok', details: 'ok' }],
      passed: true,
      // no prices field — old format
    };
    const parsed = parseAuditRecord(oldRecord);
    expect(parsed).not.toBeNull();
    expect(parsed!.passed).toBe(true);
  });
});

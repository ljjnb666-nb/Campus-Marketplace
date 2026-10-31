import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const root = process.cwd();
const tempDirs: string[] = [];
const sha = 'a'.repeat(40);
interface EvidenceManifest {
  releaseSha: string;
  checks: Record<string, { status: string; evidence: string; reviewer: string; verifiedAt: string }>;
}
function runEvidence(mutate: (manifest: EvidenceManifest) => void) {
  const dir = mkdtempSync(path.join(tmpdir(), 'campus-evidence-test-'));
  tempDirs.push(dir);
  const manifest = JSON.parse(readFileSync(path.join(root, 'deploy/production-evidence.example.json'), 'utf8'));
  manifest.releaseSha = sha;
  for (const check of Object.values(manifest.checks) as Record<string, string>[]) {
    Object.assign(check, { status: 'verified', evidence: 'https://example.invalid/evidence', reviewer: 'test reviewer', verifiedAt: new Date().toISOString() });
  }
  mutate(manifest);
  const file = path.join(dir, 'evidence.json');
  writeFileSync(file, JSON.stringify(manifest));
  return spawnSync(process.execPath, ['scripts/ops/production-evidence-check.mjs', file, sha], { cwd: root, encoding: 'utf8' });
}
afterEach(() => { for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe('production evidence completeness gate', () => {
  it('rejects the untouched template', () => {
    const result = spawnSync(process.execPath, ['scripts/ops/production-evidence-check.mjs', 'deploy/production-evidence.example.json', sha], { cwd: root, encoding: 'utf8' });
    expect(result.status).toBe(1);
  });
  it('requires evidence for the exact release', () => {
    expect(runEvidence((m) => { m.releaseSha = 'b'.repeat(40); }).status).toBe(1);
  });
  it.each(['missing', 'unverified'])('rejects %s real email delivery even when other checks pass', (mode) => {
    const result = runEvidence((m) => {
      if (mode === 'missing') delete m.checks.transactionalEmailDelivery;
      else m.checks.transactionalEmailDelivery.status = 'unverified';
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('transactionalEmailDelivery');
  });
  it.each(['unverified', 'missing', 'stale', 'future'])('fails closed for %s production evidence', (mode) => {
    const result = runEvidence((m) => {
      const check = m.checks.offsiteBackupAndRestore;
      if (mode === 'unverified') check.status = 'unverified';
      if (mode === 'missing') check.evidence = '';
      if (mode === 'stale') check.verifiedAt = '2020-01-01T00:00:00Z';
      if (mode === 'future') check.verifiedAt = '2099-01-01T00:00:00Z';
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('offsiteBackupAndRestore');
  });
  it('accepts complete recent attestation while stating its limit', () => {
    const result = runEvidence(() => {});
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('authenticity requires human review');
  });
});

describe('failure notification transport (no external requests)', () => {
  function notify(preload: string, url = 'https://example.invalid/secret-token') {
    return spawnSync(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(preload)}`, 'scripts/ops/notify-ops-failure.mjs', 'campus-backup.service'], {
      cwd: root, encoding: 'utf8', env: { ...process.env, OPS_ALERT_WEBHOOK_URL: url },
    });
  }
  it('sends fixed unit/event metadata without logs or environment secrets', () => {
    const result = notify('globalThis.fetch = async (_, opts) => { console.log(opts.body); return {ok:true}; };');
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout.split('\n')[0])).toMatchObject({ event: 'campus_ops_unit_failed', unit: 'campus-backup.service' });
    expect(result.stdout + result.stderr).not.toContain('secret-token');
  });
  it('rejects non-HTTPS transport before invoking fetch', () => {
    const result = notify('globalThis.fetch = () => { console.log("UNEXPECTED_FETCH"); };', 'http://example.invalid/secret-token');
    expect(result.status).toBe(1);
    expect(result.stdout).not.toContain('UNEXPECTED_FETCH');
  });
  it('propagates a receiver rejection without leaking endpoint tokens', () => {
    const result = notify('globalThis.fetch = async () => { throw Error("secret-token"); };');
    expect(result.status).toBe(1);
    expect(result.stderr).not.toContain('secret-token');
  });
});

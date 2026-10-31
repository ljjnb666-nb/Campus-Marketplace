import { execFileSync, spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
const bash = process.env.CAMPUS_TEST_BASH ?? 'bash';
const available = spawnSync(bash, ['--version'], { encoding: 'utf8' }).status === 0;
describe('restore drill isolation and cleanup', () => {
  it.skipIf(!available)('rejects corrupt backups before DB creation and drops only its own drill database on failure', () => {
    const output = execFileSync(bash, ['tests/ops/restore-drill.test.sh'], { encoding: 'utf8', timeout: 60000 });
    expect(output).toContain('PASS=6 FAIL=0');
  }, 65000);
  it.skipIf(!available)('offsite drill rejects production topology, stale/corrupt objects, and restores a fresh verified copy', () => {
    const output = execFileSync(bash, ['tests/ops/offsite-drill.test.sh'], { encoding: 'utf8', timeout: 60000 });
    expect(output).toContain('PASS=4 FAIL=0');
  }, 65000);
});

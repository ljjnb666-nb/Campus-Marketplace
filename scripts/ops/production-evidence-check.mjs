// Evidence completeness gate only; reviewers remain responsible for the truth of
// attached production evidence. A green repository test never fills these fields.
import { readFileSync } from 'node:fs';
const required = ['publicTlsAndReadiness', 'transactionalEmailDelivery', 'offsiteBackupAndRestore', 'alertDeliveryAndOnCall', 'capacityAndRecoveryObjectives', 'businessAndPrivacyApproval'];
try {
  const [file, expectedSha] = process.argv.slice(2);
  if (!file || !/^[a-f0-9]{40}$/.test(expectedSha ?? '')) throw new Error('usage: production-evidence-check.mjs <manifest.json> <exact-release-sha>');
  const manifest = JSON.parse(readFileSync(file, 'utf8'));
  if (manifest.releaseSha !== expectedSha) throw new Error('release SHA mismatch');
  for (const name of required) {
    const check = manifest.checks?.[name];
    const age = Date.now() - Date.parse(check?.verifiedAt);
    if (check?.status !== 'verified' || !check?.evidence?.trim() || !check?.reviewer?.trim() || !Number.isFinite(age) || age < 0 || age > 30 * 86400000) {
      throw new Error(`missing, stale, or unverified production evidence: ${name}`);
    }
  }
  console.log('PASS: required production evidence is recorded for this release; evidence authenticity requires human review');
} catch (error) {
  console.error(`FAIL: ${error.message}`);
  process.exitCode = 1;
}

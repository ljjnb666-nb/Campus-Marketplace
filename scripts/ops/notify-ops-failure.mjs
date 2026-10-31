// Generic HTTPS JSON webhook. Install a receiver which maps this payload to the
// chosen paging service. Never send environment values or raw command output.
const endpoint = process.env.OPS_ALERT_WEBHOOK_URL;
const unit = process.argv[2] ?? 'unknown';
const fail = (message) => { console.error(`[alert][FAIL] ${message}`); process.exitCode = 1; };
try {
  if (!endpoint || new URL(endpoint).protocol !== 'https:') {
    throw new Error('missing HTTPS webhook configuration');
  }
  if (!/^[a-zA-Z0-9@_.-]{1,128}$/.test(unit)) throw new Error('invalid unit name');
  const response = await fetch(endpoint, {
    method: 'POST',
    redirect: 'error',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ event: 'campus_ops_unit_failed', unit, timestamp: new Date().toISOString() }),
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error('receiver returned non-success status');
  console.log('[alert] receiver accepted failure event');
} catch {
  // Fetch errors may contain webhook tokens. Keep diagnostics deliberately fixed.
  fail('delivery failed; inspect receiver connectivity/configuration locally');
}

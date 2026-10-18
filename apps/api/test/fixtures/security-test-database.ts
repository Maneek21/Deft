/** These tests create random tenant fixtures only; they never reset shared data. */
export function securityTestDatabaseIsSafe(): boolean {
  const target=process.env.DEFT_TEST_DATABASE_URL;
  if (!target || target!==process.env.DATABASE_URL) return false;
  try {
    const url=new URL(target);
    if (!['postgres:','postgresql:'].includes(url.protocol) || !['127.0.0.1','localhost'].includes(url.hostname) || url.search || url.hash) return false;
    if (process.env.CI==='true') return url.port==='5432' && url.username==='postgres' && url.pathname==='/deft_test';
    return url.hostname==='127.0.0.1' && url.port==='55435' && url.username==='gate_g_test' && !url.password
      && /^\/gate_g_202609(?:27_email_flagship_(?:fresh53|private53)_test(?:_v2)?|28_experience_consent_test_v[1-9][0-9]*|27_c28_runtime_setup_test(?:_v[0-9]+)?)$/.test(url.pathname);
  } catch { return false; }
}

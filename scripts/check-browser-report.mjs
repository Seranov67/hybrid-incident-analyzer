import { readFile, stat } from 'node:fs/promises';
import { InferenceMode, InferenceSource } from 'firebase/ai';
import { assess, fixtures } from '../src/policy.mjs';

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error('Usage: node scripts/check-browser-report.mjs <browser-report.json> [more-reports.json]');
  process.exitCode = 2;
} else {
  try {
    const reports = [];
    for (const filename of args) {
      const info = await stat(filename);
      if (!info.isFile() || info.size > 1_000_000) throw new Error('Expected a JSON report file of at most 1 MB');
      const report = JSON.parse(await readFile(filename, 'utf8'));
      if (report?.schemaVersion !== 1 || report.scope !== 'synthetic-only manual browser preflight' || !Array.isArray(report.records)) {
        throw new Error('Expected a preflight report exported by Hybrid Incident Analyzer');
      }
      reports.push(report);
    }
    const rows = reports.flatMap(report => report.records).filter(row =>
      row?.step === 'inference' && row.status === 'PASS' &&
      row.source === InferenceSource.ON_DEVICE && row.deviceInitialization === 'READY' &&
      Object.hasOwn(fixtures, row.fixture) && typeof row.output === 'string' &&
      assess(row.mode, row.source, row.output) === 'PASS'
    );
    const checks = {
      onlyOnDeviceOnline: rows.some(row => row.mode === InferenceMode.ONLY_ON_DEVICE && row.online === true),
      onlyOnDeviceOffline: rows.some(row => row.mode === InferenceMode.ONLY_ON_DEVICE && row.online === false),
      preferOnDeviceOnline: rows.some(row => row.mode === InferenceMode.PREFER_ON_DEVICE && row.online === true && row.appCheckVerified === true)
    };
    const pass = Object.values(checks).every(Boolean);
    console.log(JSON.stringify({ status: pass ? 'PASS' : 'MISSING_EVIDENCE', checks, reportCount: reports.length }, null, 2));
    process.exitCode = pass ? 0 : 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
  }
}

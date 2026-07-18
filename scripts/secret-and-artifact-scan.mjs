import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

const { stdout } = await exec('git', ['ls-files'], { maxBuffer: 10 * 1024 * 1024 });
const tracked = stdout.split(/\r?\n/).filter(Boolean);

const forbiddenPatterns = [
  /^\.env(?:\.|$)/,
  /(^|\/)android\/keystore\.properties$/,
  /\.(?:jks|keystore)$/i,
  /\.(?:db|db-wal|db-shm|sqlite|sqlite-wal|sqlite-shm|sqlite3|sqlite3-wal|sqlite3-shm)$/i,
];

const allowed = new Set(['.env.example']);
const violations = tracked.filter(
  (file) => !allowed.has(file) && forbiddenPatterns.some((pattern) => pattern.test(file)),
);

if (violations.length > 0) {
  console.error('Tracked secret or generated data artifacts found:');
  for (const file of violations) console.error(`- ${file}`);
  process.exit(1);
}

console.log('No tracked secret or generated data artifacts found.');

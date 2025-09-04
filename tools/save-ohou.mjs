import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const r = spawnSync(process.execPath, ['rank-ohou-chrome.mjs'], { encoding: 'utf8' });
if (r.status !== 0) {
  process.stderr.write(r.stderr || r.stdout);
  process.exit(r.status ?? 1);
}
const line = (r.stdout || '').trim();
console.log(line);
fs.mkdirSync('logs', { recursive: true });
fs.appendFileSync('logs/ohou.jsonl', line + '\\n', { encoding: 'utf8' });

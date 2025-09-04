import 'dotenv/config';
import express from 'express';
import { spawn } from 'node:child_process';
import path from 'node:path';

const app = express();
app.set('trust proxy', true);
app.use(express.json({ limit: '1mb' }));

function runNode(scriptRelPath, envOverrides = {}, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const abs = path.join(process.cwd(), scriptRelPath);
    const child = spawn(process.execPath, [abs], {
      env: { ...process.env, ...envOverrides },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '', err = '';
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('timeout')); }, timeoutMs);
    child.stdout.on('data', d => out += d.toString('utf8'));
    child.stderr.on('data', d => err += d.toString('utf8'));
    child.on('close', code => {
      clearTimeout(timer);
      if (!out) return reject(new Error(err || ('exit '+code)));
      try { resolve(JSON.parse(out.trim())); }
      catch(e){ reject(new Error('JSON parse fail: '+e.message+'\\n'+out)); }
    });
  });
}

app.get('/', (_req, res) => res.send('OK'));
app.get('/healthz', (_req, res) => res.json({ ok:true }));

// 오늘의집: /rank/ohou?kw=옷걸이&pid=3112642&pages=2
app.get('/rank/ohou', async (req, res) => {
  try {
    const { kw='옷걸이', pid='3112642', pages='2', user_data_dir } = req.query;
    const env = { KW:String(kw), PID:String(pid), PAGES:String(pages) };
    if (user_data_dir) env.USER_DATA_DIR = String(user_data_dir);
    const result = await runNode('rank-ohou-chrome.mjs', env);
    res.json(result);
  } catch(e){ res.status(500).json({ ok:false, error:String(e.message||e) }); }
});

// 쿠팡: /rank/coupang?kw=벽시계&product_url=...&pages=2
app.get('/rank/coupang', async (req, res) => {
  try {
    const { kw='벽시계', product_url='', pages='2', user_data_dir } = req.query;
    const env = { KW:String(kw), PRODUCT_URL:String(product_url), PAGES:String(pages) };
    if (user_data_dir) env.USER_DATA_DIR = String(user_data_dir);
    const result = await runNode('rank-coupang-chrome.mjs', env);
    res.json(result);
  } catch(e){ res.status(500).json({ ok:false, error:String(e.message||e) }); }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log('[server] listening on :'+PORT));

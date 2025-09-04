/* Minimal Express server (clean) */
const express = require('express');
const axios = require('axios');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { HttpProxyAgent } = require('http-proxy-agent');
const { SocksProxyAgent } = require('socks-proxy-agent');

const app = express();
app.set('trust proxy', true);

// Health
app.get('/', (req, res) => res.send('OK'));
app.get('/healthz', (req, res) => res.json({ ok: true }));

// GET /fetch?url=https://example.com  (프록시 동작/크롤링 테스트용)
app.get('/fetch', async (req, res) => {
  try {
    const url = String(req.query.url || '');
    if (!url || !/^https?:\/\//i.test(url)) {
      res.status(400).json({ ok:false, error: 'Provide a valid ?url=' });
      return;
    }
    const proxy = process.env.PROXY || '';
    let agent;
    if (proxy.startsWith('http://')) agent = new HttpProxyAgent(proxy);
    else if (proxy.startsWith('https://')) agent = new HttpsProxyAgent(proxy);
    else if (proxy.startsWith('socks')) agent = new SocksProxyAgent(proxy);
    const r = await axios.get(url, { httpAgent: agent, httpsAgent: agent, timeout: 15000, validateStatus: () => true });
    res.status(200).json({
      ok: true,
      status: r.status,
      headers: r.headers,
      sample: String(r.data).slice(0, 1000),
    });
  } catch (e) {
    res.status(500).json({ ok:false, error: String(e && e.message || e) });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(\[server] listening on :\\));

/* eslint-disable */
const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { HttpProxyAgent } = require('http-proxy-agent');
const { SocksProxyAgent } = require('socks-proxy-agent');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.set('trust proxy', true);

/* =========================
   기본 라우트 / 헬스체크
   ========================= */
app.get('/', (req, res) => res.send('OK'));
app.get('/healthz', (req, res) => {
  const pools = global.__PROXIES || {
    ohou: parseProxyList('PROXY_URLS_OHOU'),
    coupang: parseProxyList('PROXY_URLS_COUPANG'),
    common: parseProxyList('PROXY_URLS')
  };
  res.json({
    ok: true,
    activeProxies: {
      ohou: (pools.ohou || []).length,
      coupang: (pools.coupang || []).length,
      common: (pools.common || []).length
    }
  });
});

/* ================ 공통 상수/유틸 ================ */
const UA = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 13_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0 Safari/537.36'
];
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const TIMEOUT_MS = Math.max(1, parseInt(process.env.TIMEOUT_MS || '45000', 10));
const HTTP_ONLY = String(process.env.HTTP_ONLY || '').toLowerCase() === 'true';

const browserHeaders = (host) => ({
  'User-Agent': pick(UA),
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
  'Accept-Encoding': 'identity',
  'Cache-Control': 'no-cache',
  'Pragma': 'no-cache',
  'sec-fetch-dest': 'document',
  'sec-fetch-mode': 'navigate',
  'sec-fetch-site': 'same-origin',
  'sec-fetch-user': '?1',
  'upgrade-insecure-requests': '1',
  ...(host ? { Host: host } : {})
});

function parseProxyList(name) {
  return String(process.env[name] || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

function makeProxyAgent(proxyUrl) {
  if (!proxyUrl) return undefined;
  const u = proxyUrl.trim();
  const withScheme = /^[a-z]+:\/\//i.test(u) ? u : `http://${u}`;
  const proto = new URL(withScheme).protocol;
  if (proto.startsWith('socks')) return new SocksProxyAgent(withScheme);
  return proto === 'http:' ? new HttpProxyAgent(withScheme) : new HttpsProxyAgent(withScheme);
}

async function probe(proxyUrl) {
  try {
    const ag = makeProxyAgent(proxyUrl);
    const r = await axios.get('https://ipinfo.thordata.com', {
      httpAgent: ag, httpsAgent: ag,
      timeout: Math.min(TIMEOUT_MS, 12000),
      validateStatus: () => true,
      headers: { 'user-agent': pick(UA), 'accept': 'application/json' }
    });
    return r.status > 0;
  } catch {
    return false;
  }
}

/* ================ 프록시 풀 워밍업 ================ */
async function warmupProxies() {
  const pools = {
    ohou: parseProxyList('PROXY_URLS_OHOU'),
    coupang: parseProxyList('PROXY_URLS_COUPANG'),
    common: parseProxyList('PROXY_URLS')
  };
  const skipProbe = String(process.env.SKIP_PROXY_PROBE || '').toLowerCase() === 'true';

  if (!skipProbe) {
    for (const k of Object.keys(pools)) {
      if (!pools[k].length) continue;
      const ok = [];
      for (const p of pools[k]) {
        if (await probe(p)) ok.push(p);
      }
      pools[k] = ok;
    }
  }
  global.__PROXIES = pools;

  function* rr(arr){ let i=0; while(true) yield arr[i++ % arr.length]; }
  global.__RR = {
    ohou: (pools.ohou?.length ? rr(pools.ohou) : null),
    coupang: (pools.coupang?.length ? rr(pools.coupang) : null),
    common: (pools.common?.length ? rr(pools.common) : null)
  };

  console.log('[warmup]', {
    skipProbe,
    ohou: pools.ohou.length,
    coupang: pools.coupang.length,
    common: pools.common.length
  });
}
warmupProxies();

function nextProxy(site) {
  const r = (global.__RR?.[site]) || (global.__RR?.common);
  if (r) return r.next().value;

  const pools = {
    ohou: parseProxyList('PROXY_URLS_OHOU'),
    coupang: parseProxyList('PROXY_URLS_COUPANG'),
    common: parseProxyList('PROXY_URLS')
  };
  const list =
    (pools[site] && pools[site].length) ? pools[site]
    : (pools.common && pools.common.length ? pools.common : []);
  return list.length ? list[0] : undefined;
}

function buildCookieHeader(prevCookie, setCookieArray) {
  const jar = new Map();
  if (prevCookie) {
    prevCookie.split(';').map(s => s.trim()).forEach(kv => {
      const [k, ...rest] = kv.split('=');
      if (!k) return;
      jar.set(k, rest.join('='));
    });
  }
  (setCookieArray || []).forEach(sc => {
    const part = String(sc).split(';')[0];
    const [k, ...rest] = part.split('=');
    if (!k) return;
    jar.set(k, rest.join('='));
  });
  return Array.from(jar.entries()).map(([k,v]) => `${k}=${v}`).join('; ');
}

/* ================ HTTP GET with proxy + hedge ================ */
async function fetchHtml(
  url,
  extraHeaders = {},
  { site = 'common', maxTries = 3, cookieState, forceProxy, hedgeCount = 2, abortSignal } = {}
) {
  const errors = [];
  let hostHeader; try { hostHeader = new URL(url).host; } catch (_) {}
  let cookie = cookieState?.cookie || '';
  const triedHosts = new Set();

  const tryOnce = async (proxyUrl) => {
    const agent = makeProxyAgent(proxyUrl);
    const headers = {
      ...browserHeaders(hostHeader),
      Connection: 'close',
      ...(cookie ? { Cookie: cookie } : {}),
      ...extraHeaders
    };
    const t0 = Date.now();
    const res = await axios.get(url, {
      httpAgent: agent,
      httpsAgent: agent,
      headers,
      timeout: TIMEOUT_MS,
      maxRedirects: 5,
      decompress: false,
      signal: abortSignal,
      validateStatus: () => true,
      transitional: { clarifyTimeoutError: true }
    });
    const ms = Date.now() - t0;
    const viaHost = proxyUrl ? new URL(/^[a-z]+:\/\//.test(proxyUrl) ? proxyUrl : `http://${proxyUrl}`).host : 'direct';
    console.log(JSON.stringify({ site, host: hostHeader, status: res.status, ms, via: viaHost }));

    const setCookie = res.headers?.['set-cookie'] || res.headers?.['Set-Cookie'];
    if (setCookie) {
      cookie = buildCookieHeader(cookie, Array.isArray(setCookie) ? setCookie : [setCookie]);
    }
    if (cookieState) cookieState.cookie = cookie;

    if (res.status >= 200 && res.status < 300) return { html: String(res.data), cookie };
    if ([301,302,303,307,308].includes(res.status)) return { html: String(res.data), cookie };

    const snippet = String(res.data).slice(0, 240);
    const err = [403,429].includes(res.status)
      ? new Error(`HTTP ${res.status} via ${viaHost}`)
      : new Error(`HTTP ${res.status} :: ${snippet}`);
    err._via = viaHost;
    throw err;
  };

  for (let attempt = 1; attempt <= maxTries; attempt++) {
    let cand = [];
    if (forceProxy) cand = [forceProxy];
    else {
      const seen = new Set();
      for (let i = 0; i < 3; i++) {
        const p = nextProxy(site);
        if (!p) break;
        const host = new URL(/^[a-z]+:\/\//.test(p) ? p : `http://${p}`).host;
        if (triedHosts.has(host) || seen.has(host)) continue;
        cand.push(p); seen.add(host);
      }
      if (cand.length === 0) {
        const p = nextProxy(site);
        if (p) cand = [p];
      }
    }

    cand = cand.filter(p => {
      try {
        const host = new URL(/^[a-z]+:\/\//.test(p) ? p : `http://${p}`).host;
        return !triedHosts.has(host);
      } catch { return true; }
    });
    if (cand.length === 0) {
      triedHosts.clear();
      const p = nextProxy(site);
      if (p) cand = [p];
    }

    try {
      const n = Math.max(1, Math.min(2, hedgeCount));
      const picks = cand.slice(0, n);
      picks.forEach(p => {
        try {
          const host = new URL(/^[a-z]+:\/\//.test(p) ? p : `http://${p}`).host;
          triedHosts.add(host);
        } catch {}
      });

      if (n === 1) {
        return await tryOnce(picks[0]);
      } else {
        const tasks = picks.map(p => tryOnce(p));
        return await Promise.any(tasks);
      }
    } catch (e) {
      const msg = e?.message || String(e);
      errors.push(msg);
      if (!/ECONNRESET|ETIMEDOUT|socket hang up|timeout|HTTP 403|HTTP 429/i.test(msg)) {
        break;
      }
    }
    const wait = Math.min(3500, 500 * Math.pow(1.6, attempt)) + Math.floor(Math.random() * 300);
    await new Promise(r => setTimeout(r, wait));
  }
  throw new Error(errors.join(' | '));
}

/* ================ 유틸: URL에서 ID 파싱 ================ */
function parseIdsFromUrl(site, productUrl) {
  const out = {};
  if (site === 'coupang') {
    const pid = /\/products\/(\d+)/.exec(productUrl)?.[1];
    const itemId = /(?:[?&])itemId=(\d+)/.exec(productUrl)?.[1];
    const vendorItemId = /(?:[?&])vendorItemId=(\d+)/.exec(productUrl)?.[1];
    if (pid) out.productId = pid;
    if (itemId) out.itemId = itemId;
    if (vendorItemId) out.vendorItemId = vendorItemId;
  } else if (site === 'ohou') {
    const pid = /\/productions\/(\d+)\/selling/.exec(productUrl)?.[1];
    if (pid) out.productId = pid;
  }
  return out;
}

/* ================ 오늘의집: HTTP-only 랭킹 ================ */
async function rankOhouseHTTP(keyword, productUrl, { maxPages = 10, fast = false, maxScanPages = 5 } = {}) {
  const want = parseIdsFromUrl('ohou', productUrl).productId;
  if (!want) throw new Error('오늘의집 productId 파싱 실패(예: https://ohou.se/productions/1132252/selling)');

  const cookies = { cookie: '' };
  await fetchHtml('https://ohou.se/', {}, { site: 'ohou', cookieState: cookies, maxTries: 2, hedgeCount: 2 });

  const enc = encodeURIComponent(keyword);
  const candidates = (page) => ([
    `https://ohou.se/search/index?query=${enc}&page=${page}`,
    `https://ohou.se/search?keyword=${enc}&page=${page}`
  ]);

  const scanPage = async (p, abortSignal) => {
    let lastErr;
    for (const u of candidates(p)) {
      try {
        const r = await fetchHtml(u, { Referer: 'https://ohou.se/' }, { site: 'ohou', cookieState: cookies, maxTries: 2, hedgeCount: 2, abortSignal });
        const html = r.html;
        const $ = cheerio.load(html);
        const items = [];
        $('a[href*="/productions/"][href$="/selling"]').each((_, a) => {
          const href = $(a).attr('href') || '';
          const pid = /\/productions\/(\d+)\/selling/.exec(href)?.[1];
          if (pid) {
            items.push({ productId: pid, link: href.startsWith('http') ? href : `https://ohou.se${href}` });
          }
        });
        if (items.length) return { page: p, items };
      } catch (e) { lastErr = e; }
    }
    if (lastErr) throw lastErr;
    return { page: p, items: [] };
  };

  if (!fast) {
    let scanned = 0;
    for (let p = 1; p <= maxPages; p++) {
      const { items } = await scanPage(p);
      const seen = new Set();
      const uniq = items.filter(it => (seen.has(it.productId) ? false : (seen.add(it.productId), true)));
      for (let i = 0; i < uniq.length; i++) {
        scanned++;
        if (String(uniq[i].productId) === String(want)) {
          return { site: 'ohou', keyword, productUrl, rank: scanned, page: p, scanned, foundItem: uniq[i], idInfo: { productId: want }, requestId: uuidv4(), itemsPerPage: uniq.length };
        }
      }
    }
    return { site: 'ohou', keyword, productUrl, rank: null, page: null, scanned: null, foundItem: null, idInfo: { productId: want }, requestId: uuidv4() };
  }

  // fast: 동시 페이지 스캔 + 조기중단
  const pagesToScan = Math.min(maxScanPages, maxPages);
  const ac = new AbortController();
  const tasks = [];
  const pageSizeGuess = 60; // 오늘의집 체감값(SSR가변). 최종 rank는 누적 방식으로 계산
  let found = null;

  for (let p = 1; p <= pagesToScan; p++) {
    tasks.push(
      scanPage(p, ac.signal).then(({ page, items }) => {
        if (found) return;
        for (let i = 0; i < items.length; i++) {
          if (String(items[i].productId) === String(want)) {
            found = { page, index: i, item: items[i], countOnPrevPages: (page - 1) * pageSizeGuess };
            ac.abort(); // 조기 중단
            break;
          }
        }
      }).catch(() => {})
    );
  }
  await Promise.allSettled(tasks);

  if (found) {
    const rank = found.countOnPrevPages + found.index + 1;
    return {
      site: 'ohou', keyword, productUrl,
      rank, page: found.page, scanned: null,
      foundItem: found.item, idInfo: { productId: want }, requestId: uuidv4()
    };
  }
  return { site: 'ohou', keyword, productUrl, rank: null, page: null, scanned: null, foundItem: null, idInfo: { productId: want }, requestId: uuidv4() };
}

/* ================ 쿠팡: HTTP-only 랭킹 ================ */
async function rankCoupangHTTP(keyword, productUrl, { maxPages = 10, listSize = 36, fast = false, maxScanPages = 5 } = {}) {
  const want = parseIdsFromUrl('coupang', productUrl);
  if (!want.productId) throw new Error('쿠팡 productId 파싱 실패(예: https://www.coupang.com/vp/products/000?itemId=...&vendorItemId=...)');

  const cookies = { cookie: '' };
  await fetchHtml('https://www.coupang.com/', { 'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.7' }, { site: 'coupang', cookieState: cookies, maxTries: 2, hedgeCount: 2 });

  const scanPage = async (p, abortSignal) => {
    const url = `https://www.coupang.com/np/search?component=&q=${encodeURIComponent(keyword)}&page=${p}&listSize=${listSize}&channel=user`;
    const r = await fetchHtml(url, { Referer: 'https://www.coupang.com/', 'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.7' }, { site: 'coupang', cookieState: cookies, maxTries: 2, hedgeCount: 2, abortSignal });
    const html = r.html;
    const $ = cheerio.load(html);
    const items = [];
    $('li.search-product[data-product-id]').each((_, li) => {
      const el = $(li);
      const productId = (el.attr('data-product-id') || '').trim();
      const itemId = (el.attr('data-item-id') || '').trim();
      const vendorItemId = (el.attr('data-vendor-item-id') || '').trim();
      const a = el.find('a.search-product-link').first();
      const href = a.attr('href') || '';
      const link = href.startsWith('http') ? href : `https://www.coupang.com${href}`;
      const title = el.find('div.name').first().text().trim();
      if (productId) items.push({ productId, itemId, vendorItemId, link, title });
    });
    return { page: p, items };
  };

  const match = (it) => {
    if (want.vendorItemId && it.vendorItemId === want.vendorItemId) return true;
    if (want.itemId && it.itemId === want.itemId) return true;
    if (want.productId && it.productId === want.productId) return true;
    return false;
  };

  if (!fast) {
    let scanned = 0;
    for (let p = 1; p <= maxPages; p++) {
      const { items } = await scanPage(p);
      for (let i = 0; i < items.length; i++) {
        scanned++;
        if (match(items[i])) {
          return { site: 'coupang', keyword, productUrl, rank: scanned, page: p, scanned, foundItem: items[i], idInfo: want, requestId: uuidv4(), itemsPerPage: items.length };
        }
      }
    }
    return { site: 'coupang', keyword, productUrl, rank: null, page: null, scanned: null, foundItem: null, idInfo: want, requestId: uuidv4() };
  }

  // fast: 동시 페이지 스캔 + 조기중단
  const pagesToScan = Math.min(maxScanPages, maxPages);
  const ac = new AbortController();
  const tasks = [];
  let found = null;

  for (let p = 1; p <= pagesToScan; p++) {
    tasks.push(
      scanPage(p, ac.signal).then(({ page, items }) => {
        if (found) return;
        for (let i = 0; i < items.length; i++) {
          if (match(items[i])) {
            found = { page, index: i, item: items[i] };
            ac.abort(); // 조기 중단
            break;
          }
        }
      }).catch(() => {})
    );
  }
  await Promise.allSettled(tasks);

  if (found) {
    const rank = (found.page - 1) * listSize + found.index + 1;
    return { site: 'coupang', keyword, productUrl, rank, page: found.page, scanned: null, foundItem: found.item, idInfo: want, requestId: uuidv4(), itemsPerPage: listSize };
  }
  return { site: 'coupang', keyword, productUrl, rank: null, page: null, scanned: null, foundItem: null, idInfo: want, requestId: uuidv4() };
}

/* ================ (옵션) Playwright Fallback ================ */
// 기본은 HTTP-only. 정말 필요할 때만 쓰도록 남겨둠.
// HTTP_ONLY=true 이거나 요청 파라미터 noPW=1이면 절대 사용하지 않음.
// const { chromium } = await import('playwright');
// ... (필요시 과거 버전 참고)

/* ================ /rank API ================ */
app.get('/rank', async (req, res) => {
  try {
    if (process.env.RELAY_KEY) {
      const key = req.header('X-Relay-Key') || req.query.key;
      if (key !== process.env.RELAY_KEY) {
        return res.status(401).json({ error: 'unauthorized' });
      }
    }

    const site = String(req.query.site || '').trim();
    const kw = String(req.query.kw || '').trim();
    const productUrl = String(req.query.productUrl || '').trim();
    const maxPages = Math.min(10, Math.max(1, parseInt(req.query.maxPages || '10', 10)));
    const listSize = Math.min(120, Math.max(12, parseInt(req.query.listSize || (site === 'coupang' ? '36' : '60'), 10)));
    const deadlineMs = Math.min(90000, Math.max(10000, parseInt(req.query.deadlineMs || '85000', 10)));
    const fast = String(req.query.fast || '0') === '1';
    const noPW = HTTP_ONLY || String(req.query.noPW || '0') === '1'; // 전역 또는 요청 단위로 PW 금지

    if (!kw) return res.status(400).json({ error: 'kw required' });
    if (!productUrl) return res.status(400).json({ error: 'productUrl required' });
    if (!site) return res.status(400).json({ error: 'site required' });

    const work = (async () => {
      if (site === 'ohou' || site === 'ohouse') {
        // HTTP-only 우선
        const r = await rankOhouseHTTP(kw, productUrl, { maxPages, fast, maxScanPages: 6 });
        if (r && r.rank != null) return r;

        // noPW면 여기서 종료
        if (noPW) return r;

        // (옵션) PW Fallback 원하면 여기서 호출 (기본은 비활성)
        // return await rankOhousePW(kw, productUrl, { pageMax: Math.min(5, maxPages) });
        return r;
      } else if (site === 'coupang') {
        const r = await rankCoupangHTTP(kw, productUrl, { maxPages, listSize, fast, maxScanPages: 5 });
        if (r && r.rank != null) return r;
        if (noPW) return r;
        // (옵션) PW Fallback 자리
        // return await rankCoupangPW(kw, productUrl, { pageMax: Math.min(5, maxPages), listSize });
        return r;
      } else {
        throw new Error(`unsupported site: ${site}`);
      }
    })();

    const timeoutP = new Promise((_, rej) => setTimeout(() => rej(new Error('deadline exceeded')), deadlineMs));
    const data = await Promise.race([work, timeoutP]);
    return res.json(data);
  } catch (err) {
    return res.status(500).json({ error: String(err.message || err), requestId: uuidv4() });
  }
});

const port = process.env.PORT || 8080;
app.listen(port, '0.0.0.0', () => console.log(`Rank API listening on :${port}`));

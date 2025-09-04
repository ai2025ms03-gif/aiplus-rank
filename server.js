/* eslint-disable */
require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { HttpProxyAgent } = require('http-proxy-agent');
const { SocksProxyAgent } = require('socks-proxy-agent');
const { CookieJar } = require('tough-cookie');
const { wrapper: axiosCookieJarSupport } = require('axios-cookiejar-support');
axiosCookieJarSupport(axios);
const { v4: uuidv4 } = require('uuid');

const app = express();
app.set('trust proxy', true);

/* =========================
   헬스체크 (Koyeb 확인용)
   ========================= */
app.get('/', (req, res) => res.send('OK'));
app.get('/healthz', (req, res) => {
  // 전역 풀이 아직 없으면, 환경변수를 읽어 길이를 보여주도록 보강
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

/* ================
   공통 유틸
   ================ */
const UA = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 13_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0 Safari/537.36'
];
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

const browserHeaders = (host) => ({
  'User-Agent': pick(UA),  // 매 요청마다 랜덤
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
  'Accept-Encoding': 'identity', // 일부 프록시/사이트와 호환성 ↑
  'Cache-Control': 'no-cache',
  'Pragma': 'no-cache',
  'sec-fetch-dest': 'document',
  'sec-fetch-mode': 'navigate',
  'sec-fetch-site': 'same-origin',
  'sec-fetch-user': '?1',
  'upgrade-insecure-requests': '1',
  ...(host ? { Host: host } : {})
});

const TIMEOUT_MS = Math.max(1, parseInt(process.env.TIMEOUT_MS || '30000', 10));

/* ==========================================
   프록시 유틸 (사이트별 풀 + SOCKS 지원 + 워밍업)
   ========================================== */
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

// 워밍업용 간단 통신 확인 (공급사 엔드포인트로 변경)
async function probe(proxyUrl) {
  try {
    const ag = makeProxyAgent(proxyUrl);
    const r = await axios.get('https://ipinfo.thordata.com', {
      httpAgent: ag, httpsAgent: ag,
      timeout: Math.min(TIMEOUT_MS, 12000),
      validateStatus: () => true,
      headers: { 'user-agent': pick(UA), 'accept': 'application/json' }
    });
    return r.status > 0; // (4xx라도) 응답 형식이 오면 통신 OK로 간주
  } catch {
    return false;
  }
}

// 프록시 풀 초기화
async function warmupProxies() {
  const pools = {
    ohou: parseProxyList('PROXY_URLS_OHOU'),
    coupang: parseProxyList('PROXY_URLS_COUPANG'),
    common: parseProxyList('PROXY_URLS')
  };

  // 옵션: SKIP_PROXY_PROBE=true 이면 사전검증 건너뛰기
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

  // 라운드로빈 제너레이터
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

// 비차단 워밍업 (서버 시작 시 1회)
warmupProxies();

// RR가 아직 없을 때도 env에서 즉시 1개 골라 쓰도록 안전화
function nextProxy(site) {
  const r = (global.__RR?.[site]) || (global.__RR?.common);
  if (r) return r.next().value;

  // RR이 아직 초기화 전이면 env에서 즉시 사용
  const pools = {
    ohou: parseProxyList('PROXY_URLS_OHOU'),
    coupang: parseProxyList('PROXY_URLS_COUPANG'),
    common: parseProxyList('PROXY_URLS')
  };
  const list =
    (pools[site] && pools[site].length) ? pools[site]
    : (pools.common && pools.common.length ? pools.common : []);
  return list.length ? list[0] : undefined; // 그래도 없으면 direct
}

/* ==========================================
   HTML GET (프록시 회전 + 재시도 + 쿠키 지원)
   ========================================== */
/**
 * @param {string} url
 * @param {object} extraHeaders - 추가 헤더
 * @param {object} opts - { site?: 'ohou'|'coupang'|'common', maxTries?: number, jar?: CookieJar }
 * @returns {Promise<string>} HTML 문자열
 */
async function fetchHtml(url, extraHeaders = {}, { site = 'common', maxTries = 4, jar } = {}) {
  const errors = [];
  let hostHeader; try { hostHeader = new URL(url).host; } catch (_) {}
  const cookieJar = jar || new CookieJar();

  for (let attempt = 1; attempt <= maxTries; attempt++) {
    const p = nextProxy(site);
    const agent = makeProxyAgent(p);
    const headers = { ...browserHeaders(hostHeader), Connection: 'close', ...extraHeaders };
    const t0 = Date.now();

    try {
      const res = await axios.get(url, {
        httpAgent: agent,
        httpsAgent: agent,
        headers,
        timeout: TIMEOUT_MS,
        maxRedirects: 5,
        decompress: false,
        validateStatus: () => true,
        transitional: { clarifyTimeoutError: true },
        jar: cookieJar,
        withCredentials: true
      });

      const ms = Date.now() - t0;
      console.log(JSON.stringify({
        site, host: hostHeader, status: res.status, ms,
        via: p ? new URL(/^[a-z]+:\/\//.test(p) ? p : `http://${p}`).host : 'direct'
      }));

      if (res.status >= 200 && res.status < 300) return String(res.data);
      if ([301,302,303,307,308].includes(res.status)) return String(res.data);
      if ([403,429].includes(res.status)) {
        errors.push(`HTTP ${res.status} via ${p || 'direct'}`);
      } else {
        const snippet = String(res.data).slice(0, 240);
        errors.push(`HTTP ${res.status} :: ${snippet}`);
      }
    } catch (e) {
      const msg = e?.message || String(e);
      errors.push(`${msg} via ${p || 'direct'}`);
      if (!/ECONNRESET|ETIMEDOUT|socket hang up|timeout/i.test(msg)) {
        break; // 비네트워크 오류면 즉시 중단
      }
    }

    // 지수 백오프 + 지터
    const wait = Math.min(3500, 500 * Math.pow(1.6, attempt)) + Math.floor(Math.random() * 300);
    await new Promise(r => setTimeout(r, wait));
  }

  throw new Error(errors.join(' | '));
}

/* =========================
   보조: URL에서 ID 추출
   ========================= */
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

/* =========================
   오늘의집 랭킹
   ========================= */
async function rankOhouse(keyword, productUrl, maxPages = 10) {
  const want = parseIdsFromUrl('ohou', productUrl).productId;
  if (!want) throw new Error('오늘의집: productId 파싱 실패(예: https://ohou.se/productions/1132252/selling)');

  const jar = new CookieJar(); // 쿠키 유지
  // 홈 워밍업(쿠키/세션 확보)
  await fetchHtml('https://ohou.se/', {}, { site: 'ohou', jar });

  let scanned = 0;
  let total = null;

  for (let p = 1; p <= maxPages; p++) {
    const enc = encodeURIComponent(keyword);
    const candidates = [
      `https://ohou.se/store/search?keyword=${enc}&page=${p}`,
      `https://ohou.se/store/search?query=${enc}&page=${p}`,
      `https://ohou.se/search?keyword=${enc}&page=${p}`
    ];

    let html = null;
    let $ = null;
    const tried = [];

    for (const u of candidates) {
      try {
        html = await fetchHtml(u, { Referer: 'https://ohou.se/' }, { site: 'ohou', jar });
        $ = cheerio.load(html);

        let hasItems = $('a[href*="/productions/"][href$="/selling"]').length > 0;
        if (!hasItems) {
          const m = String(html).match(/href="(\/productions\/\d+\/selling)"/g);
          hasItems = !!(m && m.length);
        }
        if (!hasItems) {
          tried.push(`200 but no items: ${u}`);
          html = null; $ = null; continue;
        }
        break;
      } catch (e) {
        tried.push((e && e.message) ? e.message.slice(0, 120) : String(e));
        html = null; $ = null;
      }
    }

    if (!$) {
      throw new Error(`오늘의집 검색 실패. tried=${tried.join(' | ')}`);
    }

    const items = [];
    $('a[href*="/productions/"][href$="/selling"]').each((_, a) => {
      const href = $(a).attr('href') || '';
      const pid = /\/productions\/(\d+)\/selling/.exec(href)?.[1];
      if (pid) {
        const title = $(a).attr('title') || $(a).find('[class*="production-item__"]').text().trim();
        items.push({
          productId: pid,
          link: href.startsWith('http') ? href : `https://ohou.se${href}`,
          title: title || ''
        });
      }
    });
    if (items.length === 0) {
      const rx = /href="(\/productions\/(\d+)\/selling)"/g;
      let m; while ((m = rx.exec(html))) {
        items.push({ productId: m[2], link: `https://ohou.se${m[1]}`, title: '' });
      }
    }

    const seen = new Set();
    const uniq = items.filter(it => (seen.has(it.productId) ? false : (seen.add(it.productId), true)));

    for (let i = 0; i < uniq.length; i++) {
      scanned++;
      if (uniq[i].productId === want) {
        return {
          site: 'ohou',
          keyword,
          productUrl,
          rank: scanned,
          page: p,
          scanned,
          total,
          foundItem: uniq[i],
          idInfo: { productId: want },
          requestId: uuidv4(),
          itemsPerPage: uniq.length
        };
      }
    }
  }

  return {
    site: 'ohou',
    keyword,
    productUrl,
    rank: null,
    page: null,
    scanned,
    total,
    foundItem: null,
    idInfo: { productId: parseIdsFromUrl('ohou', productUrl).productId },
    requestId: uuidv4()
  };
}

/* =========================
   쿠팡 랭킹
   ========================= */
async function rankCoupang(keyword, productUrl, maxPages = 10, listSize = 36) {
  const want = parseIdsFromUrl('coupang', productUrl);
  if (!want.productId) {
    throw new Error('쿠팡: productId 파싱 실패(예: https://www.coupang.com/vp/products/000?itemId=...&vendorItemId=...)');
  }

  const jar = new CookieJar(); // 쿠키 유지
  // 홈 워밍업(쿠키/세션 확보)
  await fetchHtml('https://www.coupang.com/', {
    'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.7'
  }, { site: 'coupang', jar });

  let scanned = 0;
  let total = null;

  for (let p = 1; p <= maxPages; p++) {
    const url = `https://www.coupang.com/np/search?component=&q=${encodeURIComponent(keyword)}&page=${p}&listSize=${listSize}&channel=user`;
    const html = await fetchHtml(url, {
      Referer: 'https://www.coupang.com/',
      'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.7'
    }, { site: 'coupang', jar });

    const $ = cheerio.load(html);

    if (total == null) {
      const txt = $('div.search-form strong').first().text().replace(/[^\d]/g, '');
      total = txt ? parseInt(txt, 10) : null;
    }

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
      items.push({ productId, itemId, vendorItemId, link, title });
    });

    // 백업: 정규식 스캔 (정적 DOM이 비어 보일 때)
    if (items.length === 0) {
      const rx = /data-product-id="(\d+)"[^>]*data-item-id="(\d+)"[^>]*data-vendor-item-id="(\d+)"/g;
      let m; while ((m = rx.exec(html))) {
        items.push({ productId: m[1], itemId: m[2], vendorItemId: m[3], link: '', title: '' });
      }
      const rx2 = /<a[^>]*class="search-product-link"[^>]*href="([^"]+)"/g;
      let k = 0, m2; while ((m2 = rx2.exec(html))) {
        if (items[k]) items[k].link = m2[1].startsWith('http') ? m2[1] : `https://www.coupang.com${m2[1]}`;
        k++;
      }
    }

    const match = (it) => {
      if (want.vendorItemId && it.vendorItemId === want.vendorItemId) return true;
      if (want.itemId && it.itemId === want.itemId) return true;
      if (want.productId && it.productId === want.productId) return true;
      return false;
    };

    for (let i = 0; i < items.length; i++) {
      scanned++;
      if (match(items[i])) {
        return {
          site: 'coupang',
          keyword,
          productUrl,
          rank: scanned,
          page: p,
          scanned,
          total,
          foundItem: items[i],
          idInfo: want,
          requestId: uuidv4(),
          itemsPerPage: items.length
        };
      }
    }
  }

  return {
    site: 'coupang',
    keyword,
    productUrl,
    rank: null,
    page: null,
    scanned,
    total,
    foundItem: null,
    idInfo: want,
    requestId: uuidv4(),
    itemsPerPage: null
  };
}

/* =========================
   라우터
   ========================= */
app.get('/rank', async (req, res) => {
  try {
    // (선택) API 키 인증
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

    if (!kw) return res.status(400).json({ error: 'kw required' });
    if (!productUrl) return res.status(400).json({ error: 'productUrl required' });
    if (!site) return res.status(400).json({ error: 'site required' });

    let data;
    if (site === 'ohou' || site === 'ohouse') {
      data = await rankOhouse(kw, productUrl, maxPages);
    } else if (site === 'coupang') {
      const listSize = parseInt(req.query.listSize || '36', 10);
      data = await rankCoupang(kw, productUrl, maxPages, listSize);
    } else {
      return res.status(400).json({ error: 'unsupported site', site });
    }
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: String(err.message || err), requestId: uuidv4() });
  }
});

const port = process.env.PORT || 8080;
app.listen(port, '0.0.0.0', () => console.log(`Relay listening on :${port}`));

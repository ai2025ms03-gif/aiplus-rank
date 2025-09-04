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
   헬스체크 (Koyeb 확인용)
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

// 기본 타임아웃 45초로 상향 (env로 덮어쓰기 가능)
const TIMEOUT_MS = Math.max(1, parseInt(process.env.TIMEOUT_MS || '45000', 10));

/* ==========================================
   프록시 유틸 (사이트별 풀 + SOCKS 지원 + 워밍업 스킵 옵션)
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

// 워밍업용 간단 통신 확인
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

// 프록시 풀 초기화
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
warmupProxies();

// RR가 아직 없을 때도 env에서 즉시 1개 골라 쓰도록 안전화
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

/* ==========================================
   초간단 쿠키 상태(문자열) 헬퍼 — 같은 요청 흐름에서만 사용
   ========================================== */
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

/* ==========================================
   HTML GET (프록시 회전 + 재시도 + 쿠키 문자열 지원)
   ========================================== */
/**
 * @param {string} url
 * @param {object} extraHeaders
 * @param {object} opts - {
 *   site?: 'ohou'|'coupang'|'common',
 *   maxTries?: number,
 *   cookieState?: {cookie?: string},
 *   forceProxy?: string,           // 디버그용: 특정 프록시 강제
 *   hedgeCount?: number            // 병렬로 동시에 보내는 프록시 수(최대 2)
 * }
 * @returns {Promise<{html: string, cookie: string}>}
 */
async function fetchHtml(
  url,
  extraHeaders = {},
  { site = 'common', maxTries = 4, cookieState, forceProxy, hedgeCount = 1 } = {}
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
    // 프록시 선택 로직: 강제 프록시 > RR > 공용
    let cand = [];
    if (forceProxy) cand = [forceProxy];
    else {
      // attempt 마다 다른 프록시가 되도록 최대 3개 후보 뽑기
      const seen = new Set();
      for (let i = 0; i < 3; i++) {
        const p = nextProxy(site);
        if (!p) break;
        const host = new URL(/^[a-z]+:\/\//.test(p) ? p : `http://${p}`).host;
        if (triedHosts.has(host) || seen.has(host)) continue;
        cand.push(p);
        seen.add(host);
      }
      // 후보가 비면 하나는 넣기(마지막 수단)
      if (cand.length === 0) {
        const p = nextProxy(site);
        if (p) cand = [p];
      }
    }

    // 같은 호스트 반복 방지
    cand = cand.filter(p => {
      try {
        const host = new URL(/^[a-z]+:\/\//.test(p) ? p : `http://${p}`).host;
        return !triedHosts.has(host);
      } catch { return true; }
    });
    if (cand.length === 0) {
      // 호스트 세트를 초기화해서라도 진행
      triedHosts.clear();
      const p = nextProxy(site);
      if (p) cand = [p];
    }

    try {
      // hedgeCount(최대 2) 만큼 병렬 요청 → 먼저 성공하는 쪽 채택
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
        const tasks = picks.map(p =>
          tryOnce(p).catch(e => {
            e._isHedgeFail = true;
            throw e;
          })
        );
        // 먼저 성공하는 놈을 사용
        return await Promise.any(tasks);
      }
    } catch (e) {
      const msg = e?.message || String(e);
      errors.push(msg);
      // 네트워크 에러/타임아웃 계열만 재시도
      if (!/ECONNRESET|ETIMEDOUT|socket hang up|timeout|HTTP 403|HTTP 429/i.test(msg)) {
        break;
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

// =========================
// Playwright Fallback 헬퍼
// =========================
async function withChromium(proxyUrl, fn) {
  const { chromium } = await import('playwright'); // CJS에서도 동작하는 동적 import
  const browser = await chromium.launch({
    headless: false, // headful이 차단 회피에 유리
    proxy: proxyUrl ? { server: proxyUrl } : undefined,
    args: ['--disable-blink-features=AutomationControlled'],
  });
  try {
    const ctx = await browser.newContext({
      locale: 'ko-KR',
      timezoneId: 'Asia/Seoul',
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
    });
    const page = await ctx.newPage();
    page.setDefaultTimeout(45000);
    return await fn(page, ctx);
  } finally {
    await browser.close();
  }
}
function jitter(ms) { return new Promise(r => setTimeout(r, ms + Math.floor(Math.random() * 700))); }

// =========================
// 오늘의집: Playwright Fallback
// =========================
async function rankOhousePW(keyword, productUrl, { pageMax = 5 } = {}) {
  const want = parseIdsFromUrl('ohou', productUrl).productId;
  if (!want) throw new Error('오늘의집 productId 파싱 실패(예: https://ohou.se/productions/1132252/selling)');

  const proxy = nextProxy('ohou') || nextProxy('common'); // 기존 RR 재사용

  return await withChromium(proxy, async (page) => {
    // 워밍업 후 시작
    await page.goto('https://ohou.se/', { waitUntil: 'domcontentloaded' });
    await jitter(800);

    let scanned = 0;
    let total = null;
    for (let p = 1; p <= pageMax; p++) {
      const url = `https://ohou.se/store/search?keyword=${encodeURIComponent(keyword)}&page=${p}`;
      await page.goto(url, { waitUntil: 'domcontentloaded' });

      // 사람처럼 스크롤
      for (let i = 0; i < 3; i++) { await page.mouse.wheel(0, 1400); await jitter(900); }

      // DOM 파싱 (SPA여도 SSR 결과가 있을 때가 많음)
      const items = await page.$$eval('a[href*="/productions/"][href$="/selling"]', (els) => {
        return els.map(a => {
          const href = a.getAttribute('href') || '';
          const m = href.match(/\/productions\/(\d+)\/selling/);
          const productId = m && m[1];
          const title =
            a.getAttribute('title') ||
            (a.querySelector('[class*="production-item__"]')?.textContent || '').trim();
          if (productId) {
            return {
              productId,
              link: href.startsWith('http') ? href : `https://ohou.se${href}`,
              title: title || ''
            };
          }
          return null;
        }).filter(Boolean);
      });

      // 중복 제거(첫 등장만 유효)
      const seen = new Set();
      const uniq = items.filter(it => (seen.has(it.productId) ? false : (seen.add(it.productId), true)));

      for (let i = 0; i < uniq.length; i++) {
        scanned++;
        if (String(uniq[i].productId) === String(want)) {
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
      await jitter(1200);
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
      idInfo: { productId: want },
      requestId: uuidv4()
    };
  });
}

// =========================
// 쿠팡: Playwright Fallback
// =========================
async function rankCoupangPW(keyword, productUrl, { pageMax = 5, listSize = 72 } = {}) {
  const want = parseIdsFromUrl('coupang', productUrl);
  if (!want.productId) {
    throw new Error('쿠팡 productId 파싱 실패(예: https://www.coupang.com/vp/products/000?itemId=...&vendorItemId=...)');
  }

  const proxy = nextProxy('coupang') || nextProxy('common');

  return await withChromium(proxy, async (page) => {
    let scanned = 0;
    let total = null;

    for (let p = 1; p <= pageMax; p++) {
      const url =
        `https://www.coupang.com/np/search?q=${encodeURIComponent(keyword)}&page=${p}&listSize=${listSize}`;
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      for (let i = 0; i < 4; i++) { await page.mouse.wheel(0, 1600); await jitter(900); }

      const items = await page.$$eval('li.search-product, li.product, li.baby-product', (els) => {
        return els.map(el => {
          const a = el.querySelector('a.search-product-link, a.baby-product-link, a.prod-link');
          const href = a?.getAttribute('href') || '';
          const m = href.match(/\/vp\/products\/(\d+)/) || href.match(/\/products\/(\d+)/);
          const productId = m ? m[1] : null;
          const itemId = el.getAttribute('data-item-id') || '';
          const vendorItemId = el.getAttribute('data-vendor-item-id') || '';
          const title =
            el.querySelector('.name, .title, .descriptions-inner, .prod-name')?.textContent?.trim() || '';
          const link = href ? (href.startsWith('http') ? href : `https://www.coupang.com${href}`) : '';
          return productId ? { productId, itemId, vendorItemId, link, title } : null;
        }).filter(Boolean);
      });

      for (let i = 0; i < items.length; i++) {
        scanned++;
        const it = items[i];
        const match =
          (want.itemId && it.itemId === want.itemId) ||
          (want.productId && it.productId === want.productId);
        if (match) {
          return {
            site: 'coupang',
            keyword,
            productUrl,
            rank: scanned,
            page: p,
            scanned,
            total,
            foundItem: it,
            idInfo: want,
            requestId: uuidv4(),
            itemsPerPage: items.length
          };
        }
      }
      await jitter(1200);
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
  });
}

// =========================
// 스마트 래퍼: axios 성공시 그대로, 실패/미발견시 PW로 승격
// =========================
async function rankOhouseSmart(keyword, productUrl, maxPages = 10, maxTries = 2) {
     if (String(process.env.FAST_PW_OHOU || '').toLowerCase() === 'true') {
    return await rankOhousePW(keyword, productUrl, { pageMax: Math.min(5, maxPages) });
  }
  try {
    const r = await rankOhouse(keyword, productUrl, maxPages, maxTries); // 기존 axios 버전
    if (r && r.rank != null) return r;
  } catch (_) {}
  // axios 실패/미발견 → 브라우저 fallback
  return await rankOhousePW(keyword, productUrl, { pageMax: Math.min(5, maxPages) });
}

async function rankCoupangSmart(keyword, productUrl, maxPages = 10, listSize = 36, maxTries = 2) {
  try {
    const r = await rankCoupang(keyword, productUrl, maxPages, listSize, maxTries); // 기존 axios 버전
    if (r && r.rank != null) return r;
  } catch (_) {}
  return await rankCoupangPW(keyword, productUrl, { pageMax: Math.min(5, maxPages), listSize });
}

/* =========================
   오늘의집 랭킹
   ========================= */
async function rankOhouse(keyword, productUrl, maxPages = 10, maxTries = 2) {
  const want = parseIdsFromUrl('ohou', productUrl).productId;
  if (!want) throw new Error('오늘의집: productId 파싱 실패(예: https://ohou.se/productions/1132252/selling)');

  const cookies = { cookie: '' };

  await fetchHtml('https://ohou.se/', {}, { site: 'ohou', cookieState: cookies, maxTries, hedgeCount: 2 });

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
        const r = await fetchHtml(u, { Referer: 'https://ohou.se/' }, { site: 'ohou', cookieState: cookies, maxTries, hedgeCount: 2 });
        html = r.html;
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
async function rankCoupang(keyword, productUrl, maxPages = 10, listSize = 36, maxTries = 2) {
  const want = parseIdsFromUrl('coupang', productUrl);
  if (!want.productId) {
    throw new Error('쿠팡: productId 파싱 실패(예: https://www.coupang.com/vp/products/000?itemId=...&vendorItemId=...)');
  }

  const cookies = { cookie: '' };

  await fetchHtml('https://www.coupang.com/', {
    'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.7'
  }, { site: 'coupang', cookieState: cookies, maxTries, hedgeCount: 2 });

  let scanned = 0;
  let total = null;

  for (let p = 1; p <= maxPages; p++) {
    const url = `https://www.coupang.com/np/search?component=&q=${encodeURIComponent(keyword)}&page=${p}&listSize=${listSize}&channel=user`;
    const r = await fetchHtml(url, {
      Referer: 'https://www.coupang.com/',
      'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.7'
    }, { site: 'coupang', cookieState: cookies, maxTries, hedgeCount: 2 });

    const html = r.html;
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

    // 조절 가능한 파라미터
    const listSize = Math.min(120, Math.max(12, parseInt(req.query.listSize || (site === 'coupang' ? '36' : '36'), 10)));
    const maxTries = Math.min(3, Math.max(1, parseInt(req.query.maxTries || '2', 10)));
    const deadlineMs = Math.min(90000, Math.max(10000, parseInt(req.query.deadlineMs || '85000', 10)));
    const forceProxy = req.query.forceProxy ? String(req.query.forceProxy) : undefined;

    if (!kw) return res.status(400).json({ error: 'kw required' });
    if (!productUrl) return res.status(400).json({ error: 'productUrl required' });
    if (!site) return res.status(400).json({ error: 'site required' });

    const work = (async () => {
      if (site === 'ohou' || site === 'ohouse') {
        return await rankOhouseSmart(kw, productUrl, maxPages, maxTries);
      } else if (site === 'coupang') {
        // coupang은 hedge(병렬) 효과를 fetchHtml 내부에서 사용
        return await rankCoupangSmart(kw, productUrl, maxPages, listSize, maxTries);
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
app.listen(port, '0.0.0.0', () => console.log(`Relay listening on :${port}`));

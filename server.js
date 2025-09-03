/* eslint-disable */
require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { HttpProxyAgent } = require('http-proxy-agent');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.set('trust proxy', true);
// ───────────── 헬스체크 (Koyeb이 활성여부 확인) ─────────────
// 인증 없이 200을 리턴해야 함
app.get('/', (req, res) => {
  res.send('OK');
});
app.get('/healthz', (req, res) => {
  res.json({ ok: true });
});

// ───────────── 공통 유틸 ─────────────
const UA = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 13_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0 Safari/537.36'
];

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

// 브라우저 지문 비슷한 헤더 세트
function browserHeaders(host) {
  return {
    'User-Agent': pick(UA),
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
    'Accept-Encoding': 'gzip, deflate, br',
    'Cache-Control': 'no-cache',
    'Pragma': 'no-cache',
    // 아래 4개가 403 회피에 꽤 효과적
    'sec-fetch-dest': 'document',
    'sec-fetch-mode': 'navigate',
    'sec-fetch-site': 'same-origin',
    'sec-fetch-user': '?1',
    'upgrade-insecure-requests': '1',
    ...(host ? { 'Host': host } : {})
  };
}

function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }

function makeProxyAgent() {
  const list = (process.env.PROXY_URLS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!list.length) return undefined;
  const proxy = pick(list);
  const isHttps = proxy.startsWith('https://') || proxy.startsWith('http://');
  return proxy.startsWith('https:') ? new HttpsProxyAgent(proxy) :
         proxy.startsWith('http:')  ? new HttpProxyAgent(proxy) : undefined;
}

async function fetchHtml(url, extraHeaders = {}) {
  const timeout = Math.max(1, parseInt(process.env.TIMEOUT_MS || '45000', 10));
  const maxTry = Math.max(1, parseInt(process.env.RETRY || '3', 10));
  const backoff = Math.max(0, parseInt(process.env.RETRY_SLEEP_MS || '1200', 10));

  let lastErr;
  for (let attempt = 1; attempt <= maxTry; attempt++) {
    const agent = makeProxyAgent(); // 매 시도마다 프록시 재선택(회전)
    const u = new URL(url);
    const headers = {
      ...browserHeaders(u.host),
      ...extraHeaders
    };
    try {
      const res = await axios.get(url, {
        httpAgent: agent,
        httpsAgent: agent,
        headers,
        timeout,
        decompress: true,
        validateStatus: () => true
      });
      // 강차단/봇페이지는 그대로 에러로
      if (res.status >= 400) {
        const snippet = String(res.data).slice(0, 240);
        throw new Error(`HTTP ${res.status} fetching ${url} :: ${snippet}`);
      }
      const html = String(res.data);
      // 오늘의집/쿠팡이 종종 “Access Denied”를 200으로 보낼 때가 있어 탐지
      if (/Access Denied|봇이 감지|blocked|captcha/i.test(html)) {
        throw new Error('200 but blocked page');
      }
      return html;
    } catch (e) {
      lastErr = e;
      if (attempt < maxTry) await sleep(backoff);
    }
  }
  throw lastErr;
}

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
  } else if (site === 'naver') {
    const pid = /\/products\/(\d+)/.exec(productUrl)?.[1];
    if (pid) out.productId = pid;
  }
  return out;
}

// ───────────── 오늘의집 랭킹 ─────────────
async function rankOhouse(keyword, productUrl, maxPages = 10) {
  const want = parseIdsFromUrl('ohou', productUrl).productId;
  if (!want) throw new Error('오늘의집: productId 파싱 실패(예: https://ohou.se/productions/1132252/selling)');

  let scanned = 0;
  let total = null;
  for (let p = 1; p <= maxPages; p++) {
// (변경 후) rankOhouse() 내부
// 기존 3줄( url, fetchHtml, $ )을 아래 블록으로 교체
const enc = encodeURIComponent(keyword);
const candidates = [
  `https://ohou.se/store/search?keyword=${enc}&page=${p}`, // 1순위: keyword 파라미터
  `https://ohou.se/store/search?query=${enc}&page=${p}`,   // 2순위: 기존 query 파라미터
  `https://ohou.se/search?keyword=${enc}&page=${p}`        // 3순위: 경로 단축형
];

let html, $;
let tried = [];
for (const u of candidates) {
  try {
    html = await fetchHtml(u, { Referer: 'https://ohou.se/' });
    $ = cheerio.load(html);
    // 간단 건강검진: 결과 리스트가 있는지 확인 (없으면 다음 후보 시도)
    const hasItems = $('a[href*="/productions/"][href$="/selling"]').length > 0;
    if (!hasItems) {
      tried.push(`200 but no items: ${u}`);
      continue;
    }
    break; // 성공
  } catch (e) {
    tried.push(`${e.message?.slice(0, 120) || String(e)}`);
    html = null;
    $ = null;
  }
}

if (!$) {
  throw new Error(`오늘의집 검색 실패. tried=${tried.join(' | ')}`);
}

    // 결과 총 개수(있으면)
    if (total == null) {
      const t = $('span').filter((_,el)=>/검색결과/.test($(el).text())).first().text();
      total = total ?? null;
    }

    const items = [];
    $('a[href*="/productions/"][href$="/selling"]').each((_, a) => {
      const href = $(a).attr('href');
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

    // 중복 제거 + 순서 유지
    const seen = new Set();
    const uniq = items.filter(it => (seen.has(it.productId) ? false : (seen.add(it.productId), true)));

    // 랭크 계산
    for (let i = 0; i < uniq.length; i++) {
      scanned++;
      if (uniq[i].productId === want) {
        return {
          site: 'ohou',
          keyword, productUrl,
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
    scanned += 0; // for clarity
  }
  return {
    site: 'ohou',
    keyword, productUrl,
    rank: null,
    page: null,
    scanned,
    total,
    foundItem: null,
    idInfo: { productId: parseIdsFromUrl('ohou', productUrl).productId },
    requestId: uuidv4()
  };
}

// ───────────── 쿠팡 랭킹 ─────────────
// HTML 목록을 파싱하는 방식. 프록시 없으면 실패 확률 높음.
async function rankCoupang(keyword, productUrl, maxPages = 10, listSize = 36) {
  const want = parseIdsFromUrl('coupang', productUrl); // productId/itemId/vendorItemId
  if (!want.productId) throw new Error('쿠팡: productId 파싱 실패(예: https://www.coupang.com/vp/products/000?itemId=...&vendorItemId=...)');

  let scanned = 0;
  let total = null;

  for (let p = 1; p <= maxPages; p++) {
    const url = `https://www.coupang.com/np/search?component=&q=${encodeURIComponent(keyword)}&page=${p}&listSize=${listSize}&channel=user`;
    const html = await fetchHtml(url, {
      Referer: 'https://www.coupang.com/',
      'Upgrade-Insecure-Requests': '1'
    });
    const $ = cheerio.load(html);

    // 총 개수 추정값(있으면)
    if (total == null) {
      const txt = $('div.search-form strong').first().text().replace(/[^\d]/g, '');
      total = txt ? parseInt(txt, 10) : null;
    }

    const items = [];
    $('li.search-product[data-product-id]').each((_, li) => {
      const el = $(li);
      const productId = (el.attr('data-product-id') || '').trim();
      const itemId    = (el.attr('data-item-id') || '').trim();
      const vendorItemId = (el.attr('data-vendor-item-id') || '').trim();
      const a = el.find('a.search-product-link').first();
      const href = a.attr('href') || '';
      const link = href.startsWith('http') ? href : `https://www.coupang.com${href}`;
      const title = el.find('div.name').first().text().trim();

      items.push({ productId, itemId, vendorItemId, link, title });
    });

    // 랭크 매칭 로직: vendorItemId > itemId > productId 우선
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
          keyword, productUrl,
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
    keyword, productUrl,
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

// ───────────── 라우터 ─────────────
app.get('/rank', async (req, res) => {
  try {
    // 인증
    if (process.env.RELAY_KEY) {
      const key = req.header('X-Relay-Key') || req.query.key;
      if (key !== process.env.RELAY_KEY) return res.status(401).json({ error: 'unauthorized' });
    }

    const site = String(req.query.site || 'naver');
    const kw = String(req.query.kw || '').trim();
    const productUrl = String(req.query.productUrl || '').trim();
    const maxPages = Math.min(10, Math.max(1, parseInt(req.query.maxPages || '10', 10)));

    if (!kw) return res.status(400).json({ error: 'kw required' });
    if (!productUrl) return res.status(400).json({ error: 'productUrl required' });

    let data;
    if (site === 'ohou' || site === 'ohouse') {
      data = await rankOhouse(kw, productUrl, maxPages);
    } else if (site === 'coupang') {
      data = await rankCoupang(kw, productUrl, maxPages, parseInt(req.query.listSize || '36', 10));
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

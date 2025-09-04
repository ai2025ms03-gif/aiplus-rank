*** original/server.js
--- patched/server.js
@@
 require('dotenv').config();
 const express = require('express');
 const axios = require('axios');
 const cheerio = require('cheerio');
 const { HttpsProxyAgent } = require('https-proxy-agent');
 const { HttpProxyAgent } = require('http-proxy-agent');
+const { SocksProxyAgent } = require('socks-proxy-agent');
+const { CookieJar } = require('tough-cookie');
+const { wrapper: axiosCookieJarSupport } = require('axios-cookiejar-support');
 const { v4: uuidv4 } = require('uuid');
 
 const app = express();
 app.set('trust proxy', true);
 
@@
 app.get('/healthz', (req, res) => {
-  res.json({ ok: true });
+  res.json({
+    ok: true,
+    activeProxies: {
+      ohou: (global.__PROXIES?.ohou || []).length,
+      coupang: (global.__PROXIES?.coupang || []).length,
+      common: (global.__PROXIES?.common || []).length
+    }
+  });
 });
 
 // ───────────── 공통 유틸 ─────────────
 const UA = [
   'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
   'Mozilla/5.0 (Macintosh; Intel Mac OS X 13_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
   'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0 Safari/537.36'
 ];
 const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
 
 const browserHeaders = (host) => ({
-  'User-Agent': pick(UA),
+  'User-Agent': pick(UA), // 매 요청 랜덤 로테이션
   'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
   'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
-  'Accept-Encoding': 'gzip, deflate, br',
+  'Accept-Encoding': 'identity',        // 일부 프록시/사이트와 호환성 ↑
   'Cache-Control': 'no-cache',
   'Pragma': 'no-cache',
   'sec-fetch-dest': 'document',
   'sec-fetch-mode': 'navigate',
   'sec-fetch-site': 'same-origin',
   'sec-fetch-user': '?1',
   'upgrade-insecure-requests': '1',
   ...(host ? { Host: host } : {})
 });
 
-const normalizeProxyUrl = (s) => {
-  let u = (s || '').trim();
-  if (!u) return null;
-  if (!/^https?:\/\//i.test(u)) u = 'http://' + u;
-  return u;
-};
-
-const makeProxyAgent = (proxyUrl) => {
-  if (!proxyUrl) return undefined;
-  const url = normalizeProxyUrl(proxyUrl);
-  if (!url) return undefined;
-  return url.startsWith('https://') ? new HttpsProxyAgent(url) : new HttpProxyAgent(url);
-};
+// ───────────── 프록시 유틸(사이트별 풀 + SOCKS 지원 + 워밍업) ─────────────
+axiosCookieJarSupport(axios);
+const TIMEOUT_MS = Math.max(1, parseInt(process.env.TIMEOUT_MS || '30000', 10));
+
+function parseProxyList(name) {
+  const raw = String(process.env[name] || '').split(',').map(s => s.trim()).filter(Boolean);
+  return raw;
+}
+function makeProxyAgent(proxyUrl) {
+  if (!proxyUrl) return undefined;
+  const u = proxyUrl.trim();
+  // 스킴이 없으면 http:// 가정
+  const withScheme = /^[a-z]+:\/\//i.test(u) ? u : `http://${u}`;
+  const proto = new URL(withScheme).protocol;
+  if (proto.startsWith('socks')) return new SocksProxyAgent(withScheme);
+  return proto === 'http:' ? new HttpProxyAgent(withScheme) : new HttpsProxyAgent(withScheme);
+}
+async function probe(proxyUrl) {
+  try {
+    const ag = makeProxyAgent(proxyUrl);
+    const r = await axios.get('https://ipinfo.io/json', {
+      httpAgent: ag, httpsAgent: ag, timeout: Math.min(TIMEOUT_MS, 8000), validateStatus: () => true,
+      headers: { 'user-agent': pick(UA), 'accept': 'application/json' }
+    });
+    return r.status > 0; // 4xx라도 응답 형식 정상이면 통신 OK
+  } catch { return false; }
+}
+async function warmupProxies() {
+  const pools = {
+    ohou: parseProxyList('PROXY_URLS_OHOU'),
+    coupang: parseProxyList('PROXY_URLS_COUPANG'),
+    common: parseProxyList('PROXY_URLS')
+  };
+  for (const k of Object.keys(pools)) {
+    if (!pools[k].length) continue;
+    const ok = [];
+    for (const p of pools[k]) {
+      if (await probe(p)) ok.push(p);
+    }
+    pools[k] = ok;
+  }
+  global.__PROXIES = pools; // healthz에서 보이도록 글로벌에 유지
+  // 라운드로빈 제너레이터
+  function* rr(arr){ let i=0; while(true) yield arr[i++ % arr.length]; }
+  global.__RR = {
+    ohou: (pools.ohou?.length ? rr(pools.ohou) : null),
+    coupang: (pools.coupang?.length ? rr(pools.coupang) : null),
+    common: (pools.common?.length ? rr(pools.common) : null)
+  };
+}
+// 비차단 워밍업 (가능하면 시작 즉시 준비)
+warmupProxies();
+function nextProxy(site) {
+  const r = (global.__RR?.[site]) || (global.__RR?.common);
+  return r ? r.next().value : undefined;
+}
 
-/**
- * 프록시 회전/재시도 포함 HTML GET
- */
-async function fetchHtml(url, extraHeaders = {}) {
-  const rawList = (process.env.PROXY_URLS || '')
-    .split(',')
-    .map((s) => s.trim())
-    .filter(Boolean);
-
-  const proxyList = rawList.length ? rawList : [null]; // 프록시 없으면 직접접속
-  const timeout = Math.max(1, parseInt(process.env.TIMEOUT_MS || '20000', 10));
-  const errors = [];
-
-  // URL 호스트(헤더 보강용)
-  let hostHeader = undefined;
-  try {
-    hostHeader = new URL(url).host;
-  } catch (_) {}
-
-  // 최대 5회까지(프록시 갯수만큼) 시도
-  const maxAttempts = Math.min(proxyList.length, 5);
-
-  for (let attempt = 0; attempt < maxAttempts; attempt++) {
-    const p = proxyList[attempt % proxyList.length];
-    const agent = makeProxyAgent(p);
-
-    // 일부 프록시/사이트와의 상성 때문에 연결/압축 옵션 보수적으로
-    const headers = {
-      ...browserHeaders(hostHeader),
-      Connection: 'close',
-      'Accept-Encoding': 'identity',
-      ...extraHeaders
-    };
-
-    try {
-      const res = await axios.get(url, {
-        httpAgent: agent,
-        httpsAgent: agent,
-        headers,
-        timeout,
-        maxRedirects: 5,
-        decompress: false,
-        validateStatus: () => true,
-        transitional: { clarifyTimeoutError: true }
-      });
-
-      // 4xx/5xx
-      if (res.status >= 400) {
-        const snippet = String(res.data).slice(0, 240);
-        // 403/429 → 다음 프록시로 재시도
-        if (res.status === 403 || res.status === 429) {
-          errors.push(`HTTP ${res.status} via ${p || 'direct'}`);
-          continue;
-        }
-        throw new Error(`HTTP ${res.status} fetching ${url} :: ${snippet}`);
-      }
-
-      // OK
-      return String(res.data);
-    } catch (e) {
-      const msg = e && e.message ? e.message : String(e);
-      errors.push(`${msg} via ${p || 'direct'}`);
-
-      // 재시도 가치 있는 네트워크성 오류
-      if (/ECONNRESET|ETIMEDOUT|socket hang up|timeout/i.test(msg)) {
-        continue;
-      }
-      // 그 외는 즉시 실패
-      throw new Error(errors.join(' | '));
-    }
-  }
-
-  // 모든 시도 실패
-  throw new Error(errors.join(' | '));
-}
+/**
+ * 프록시 회전/재시도/쿠키 포함 HTML GET (사이트별 풀 사용)
+ */
+async function fetchHtml(url, extraHeaders = {}, { site = 'common', maxTries = 4 } = {}) {
+  const errors = [];
+  // URL 호스트(헤더 보강용)
+  let hostHeader; try { hostHeader = new URL(url).host; } catch (_) {}
+  const jar = new CookieJar();
+
+  for (let attempt = 1; attempt <= maxTries; attempt++) {
+    const p = nextProxy(site);
+    const agent = makeProxyAgent(p);
+    const headers = { ...browserHeaders(hostHeader), Connection: 'close', ...extraHeaders };
+    const t0 = Date.now();
+    try {
+      const res = await axios.get(url, {
+        httpAgent: agent, httpsAgent: agent,
+        headers, timeout: TIMEOUT_MS, maxRedirects: 5,
+        decompress: false, validateStatus: () => true,
+        transitional: { clarifyTimeoutError: true },
+        jar, withCredentials: true
+      });
+      const ms = Date.now() - t0;
+      console.log(JSON.stringify({ site, host: hostHeader, status: res.status, ms, via: p ? new URL(/^[a-z]+:\/\//.test(p)?p:`http://${p}`).host : 'direct' }));
+
+      if (res.status >= 200 && res.status < 300) return String(res.data);
+      if ([301,302,303,307,308].includes(res.status)) return String(res.data); // 리디렉션 후 본문이 오는 케이스 방어
+      if ([403,429].includes(res.status)) {
+        errors.push(`HTTP ${res.status} via ${p || 'direct'}`);
+      } else {
+        const snippet = String(res.data).slice(0, 240);
+        errors.push(`HTTP ${res.status} :: ${snippet}`);
+      }
+      // 차단류 → 백오프 후 다음 프록시/시도
+    } catch (e) {
+      const msg = e?.message || String(e);
+      errors.push(`${msg} via ${p || 'direct'}`);
+      if (!/ECONNRESET|ETIMEDOUT|socket hang up|timeout/i.test(msg)) {
+        // 비네트워크 오류는 즉시 중단
+        break;
+      }
+    }
+    // 지수 백오프 + 지터
+    const wait = Math.min(3500, 500 * Math.pow(1.6, attempt)) + Math.floor(Math.random() * 300);
+    await new Promise(r => setTimeout(r, wait));
+  }
+  throw new Error(errors.join(' | '));
+}
 
 function parseIdsFromUrl(site, productUrl) {
@@
 async function rankOhouse(keyword, productUrl, maxPages = 10) {
   const want = parseIdsFromUrl('ohou', productUrl).productId;
   if (!want) throw new Error('오늘의집: productId 파싱 실패(예: https://ohou.se/productions/1132252/selling)');
 
   let scanned = 0;
   let total = null;
 
   for (let p = 1; p <= maxPages; p++) {
@@
-    for (const u of candidates) {
+    for (const u of candidates) {
       try {
-        html = await fetchHtml(u, { Referer: 'https://ohou.se/' });
+        html = await fetchHtml(u, { Referer: 'https://ohou.se/' }, { site: 'ohou' });
         $ = cheerio.load(html);
 
         // 결과 아이템이 실제로 있는지 체크
-        const hasItems = $('a[href*="/productions/"][href$="/selling"]').length > 0;
+        let hasItems = $('a[href*="/productions/"][href$="/selling"]').length > 0;
+        // 정적 DOM에 안 보이는 경우를 위한 백업: 원시 HTML에서 링크 정규식 스캔
+        if (!hasItems) {
+          const m = String(html).match(/href="(\/productions\/\d+\/selling)"/g);
+          hasItems = !!(m && m.length);
+        }
         if (!hasItems) {
           tried.push(`200 but no items: ${u}`);
           html = null;
           $ = null;
           continue;
         }
         break; // 성공
       } catch (e) {
         tried.push((e && e.message) ? e.message.slice(0, 120) : String(e));
         html = null;
         $ = null;
       }
     }
@@
-    $('a[href*="/productions/"][href$="/selling"]').each((_, a) => {
+    $('a[href*="/productions/"][href$="/selling"]').each((_, a) => {
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
+    // 백업: 정규식으로 누락분 보강 (a태그가 없게 렌더된 경우)
+    if (items.length === 0) {
+      const rx = /href="(\/productions\/(\d+)\/selling)"/g;
+      let m; while ((m = rx.exec(html))) {
+        items.push({ productId: m[2], link: `https://ohou.se${m[1]}`, title: '' });
+      }
+    }
@@
 async function rankCoupang(keyword, productUrl, maxPages = 10, listSize = 36) {
   const want = parseIdsFromUrl('coupang', productUrl); // productId/itemId/vendorItemId
   if (!want.productId) {
     throw new Error('쿠팡: productId 파싱 실패(예: https://www.coupang.com/vp/products/000?itemId=...&vendorItemId=...)');
   }
@@
   for (let p = 1; p <= maxPages; p++) {
     const url = `https://www.coupang.com/np/search?component=&q=${encodeURIComponent(keyword)}&page=${p}&listSize=${listSize}&channel=user`;
-    const html = await fetchHtml(url, {
+    const html = await fetchHtml(url, {
       Referer: 'https://www.coupang.com/',
       'Upgrade-Insecure-Requests': '1'
-    });
+    }, { site: 'coupang' });
     const $ = cheerio.load(html);
@@
-    $('li.search-product[data-product-id]').each((_, li) => {
+    $('li.search-product[data-product-id]').each((_, li) => {
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
+    // 백업: 정규식으로 data-* 속성 스캔 (정적 DOM이 비어보일 때)
+    if (items.length === 0) {
+      const rx = /data-product-id="(\d+)"[^>]*data-item-id="(\d+)"[^>]*data-vendor-item-id="(\d+)"/g;
+      let m; while ((m = rx.exec(html))) {
+        items.push({ productId: m[1], itemId: m[2], vendorItemId: m[3], link: '', title: '' });
+      }
+      // 링크/타이틀 백업 추출(가능한 경우)
+      const rx2 = /<a[^>]*class="search-product-link"[^>]*href="([^"]+)"/g;
+      let k = 0, m2; while ((m2 = rx2.exec(html))) {
+        if (items[k]) items[k].link = m2[1].startsWith('http') ? m2[1] : `https://www.coupang.com${m2[1]}`;
+        k++;
+      }
+    }

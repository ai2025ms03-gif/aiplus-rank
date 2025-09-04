import { chromium } from "playwright";

const PROXY   = process.env.PROXY || "";         // 예: http://user:pass@host:port
const KEYWORD = process.env.KW    || "옷걸이";   // 검색 키워드
const TARGET  = process.env.PID   || "3112642";  // 목표 productId
const PAGES   = parseInt(process.env.PAGES || "2", 10);

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function collectFromDom(page) {
  try {
    // DOM에서 카드 링크 수집
    const items = await page.$$eval('a[href*="/productions/"]', (els) => {
      const out = []; const seen = new Set();
      for (const a of els) {
        const href = a.getAttribute("href") || "";
        const m = href.match(/\/productions\/(\d+)(?:\/selling)?/);
        if (!m) continue;
        const id = m[1];
        if (seen.has(id)) continue;
        seen.add(id);
        out.push({ id });
      }
      return out;
    });
    return items;
  } catch { return []; }
}

async function collectFromEmbeddedHtml(page) {
  try {
    const html = await page.content();
    // 1) 정규식으로 productions id 긁기
    const rx = /\/productions\/(\d+)(?:\/selling)?/g;
    const seen = new Set(); const out = [];
    let m; while ((m = rx.exec(html))) { if (!seen.has(m[1])) { seen.add(m[1]); out.push({ id: m[1] }); } }
    if (out.length) return out;

    // 2) Next.js __NEXT_DATA__ 파싱 시도
    const match = html.match(/id="__NEXT_DATA__"[^>]*>(.*?)<\/script>/s);
    if (match) {
      const json = JSON.parse(match[1]);
      const ids = JSON.stringify(json).match(/"productions\/(\d+)(?:\/selling)?"/g) || [];
      const seen2 = new Set(); const out2 = [];
      for (const s of ids) {
        const mm = s.match(/productions\/(\d+)/);
        if (mm && !seen2.has(mm[1])) { seen2.add(mm[1]); out2.push({ id: mm[1] }); }
      }
      return out2;
    }
  } catch {}
  return [];
}

(async () => {
  // ── 브라우저/프록시/스텔스 세팅
  const server = PROXY && (/^[a-z]+:\/\//i.test(PROXY) ? PROXY : `http://${PROXY}`);
  const browser = await chromium.launch({
    headless: true,
    proxy: server ? { server } : undefined,
    args: ["--disable-blink-features=AutomationControlled"],
  });
  const ctx = await browser.newContext({
    locale: "ko-KR",
    timezoneId: "Asia/Seoul",
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  });
  // webdriver 흔적 제거(간단 스텔스)
  await ctx.addInitScript(() => {
    try { Object.defineProperty(navigator, "webdriver", { get: () => undefined }); } catch {}
  });
  const page = await ctx.newPage();

  // 무거운 리소스 차단 → 속도/안정성↑
  await page.route("**/*", (route) => {
    const t = route.request().resourceType();
    if (t === "image" || t === "font" || t === "stylesheet" || t === "media") return route.abort();
    route.continue();
  });

  // 홈 워밍업(쿠키 수립)
  try { await page.goto("https://ohou.se/", { waitUntil: "domcontentloaded", timeout: 45000 }); } catch {}

  let rank = null, scannedTotal = 0;

  for (let p = 1; p <= PAGES; p++) {
    const candidates = [
      `https://ohou.se/search/index?query=${encodeURIComponent(KEYWORD)}&page=${p}`,
      `https://ohou.se/search/index?query=${encodeURIComponent(KEYWORD)}&page=${p}`,
      `https://ohou.se/search?keyword=${encodeURIComponent(KEYWORD)}&page=${p}`,
    ];

    // 네트워크 JSON 인터셉트 버퍼
    const pageResults = [];
    const onResp = async (res) => {
      try {
        const url = res.url();
        const ct = (res.headers()["content-type"] || "").toLowerCase();
        if (!ct.includes("application/json")) return;
        if (!/ohou\.se\/api\/.*search|\/search\?/.test(url)) return;
        const json = await res.json().catch(() => null);
        if (!json) return;
        const items = json?.data?.items || json?.items || json?.results || [];
        for (const it of items) {
          const id = String(it?.id || it?.product_id || it?.uuid || "");
          if (id) pageResults.push({ id });
        }
      } catch {}
    };
    page.on("response", onResp);

    // 후보 URL 순차 시도 (네트워크 안정까지 대기)
    let loaded = false;
    for (const u of candidates) {
      try {
        await page.goto(u, { waitUntil: "networkidle", timeout: 60000 });
        loaded = true; break;
      } catch { /* 다음 후보 */ }
    }
    if (!loaded) { page.off("response", onResp); continue; }

    // 스크롤로 lazy-load 유도
    for (let i = 0; i < 3; i++) { await page.mouse.wheel(0, 1400); await sleep(350); }

    // 1) JSON 결과 우선 사용
    let items = pageResults.slice();

    // 2) DOM 백업
    if (items.length === 0) items = await collectFromDom(page);

    // 3) 임베디드 HTML 백업
    if (items.length === 0) items = await collectFromEmbeddedHtml(page);

    // 첫 등장 인덱스가 실제 순위
    for (const it of items) {
      scannedTotal++;
      if (it.id === TARGET) {
        rank = scannedTotal;
        console.log(JSON.stringify({ ok:true, keyword:KEYWORD, productId:TARGET, page:p, rank, scanned:scannedTotal }, null, 2));
        page.off("response", onResp);
        await browser.close();
        return;
      }
    }

    page.off("response", onResp);
    await sleep(400);
  }

  console.log(JSON.stringify({ ok:false, keyword:KEYWORD, productId:TARGET, rank:null, scanned:scannedTotal }, null, 2));
  await browser.close();
})().catch(async (e) => {
  console.error(JSON.stringify({ ok:false, error: String(e && e.message || e) }));
  process.exit(1);
});

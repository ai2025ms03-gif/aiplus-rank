import { chromium } from "playwright";

const KEYWORD = process.env.KW  || "옷걸이";
const TARGET  = process.env.PID || "3112642";   // productions/{이 숫자}/selling
const PAGES   = parseInt(process.env.PAGES || "2", 10);

// 사람 확인이 필요할 수 있으니 headful + 실제 Chrome + 영구 프로필 사용
const USER_DATA_DIR = process.env.USER_DATA_DIR || "C:\\\\Users\\\\MOJISE\\\\ohou-profile"; // 원하면 경로 바꿔도 됨

const sleep = (ms) => new Promise(r=>setTimeout(r, ms));

// productions/{id} 추출 유틸(여러 구조 대비)
async function collectIds(page) {
  // 1) DOM
  const domIds = await page.$$eval('a[href*="/productions/"]', els => {
    const seen = new Set(); const out = [];
    for (const a of els) {
      const href = a.getAttribute("href") || "";
      const m = href.match(/\/productions\/(\d+)(?:\/selling)?/);
      if (!m) continue;
      const id = m[1];
      if (!seen.has(id)) { seen.add(id); out.push(id); }
    }
    return out;
  }).catch(()=>[]);
  if (domIds.length) return domIds;

  // 2) HTML 정규식 백업
  const html = await page.content();
  const rx = /\/productions\/(\d+)(?:\/selling)?/g;
  const seen = new Set(); const out = [];
  let m; while ((m = rx.exec(html))) { if (!seen.has(m[1])) { seen.add(m[1]); out.push(m[1]); } }
  return out;
}

(async () => {
  const ctx = await chromium.launchPersistentContext(USER_DATA_DIR, {
    channel: "chrome",        // 실제 Chrome
    headless: false,          // 눈으로 보이게
    viewport: { width: 1280, height: 900 },
    locale: "ko-KR",
    timezoneId: "Asia/Seoul",
    args: [
      "--disable-blink-features=AutomationControlled",
      "--lang=ko-KR,ko",
    ],
  });

  const page = await ctx.newPage();

  // 약식 스텔스
  await page.addInitScript(() => {
    try { Object.defineProperty(navigator, "webdriver", { get: () => undefined }); } catch {}
  });

  // 1) 홈 진입 (사람 확인/쿠키 수립)
  try {
    await page.goto("https://ohou.se/", { waitUntil: "domcontentloaded", timeout: 60000 });
  } catch {}
  // 만약 봇캡차/동의 페이지가 보이면 네가 직접 한 번만 처리하면 됨.
  // 최대 120초 대기: 사용자가 뭔가 클릭/해결할 시간
  await page.waitForLoadState("networkidle", { timeout: 120000 }).catch(()=>{});

  let scanned = 0;
  for (let p = 1; p <= PAGES; p++) {
    const urlCandidates = [
      `https://ohou.se/search/index?query=${encodeURIComponent(KEYWORD)}&page=${p}`,
      `https://ohou.se/search/index?query=${encodeURIComponent(KEYWORD)}&page=${p}`,
      `https://ohou.se/search?keyword=${encodeURIComponent(KEYWORD)}&page=${p}`,
    ];

    let loaded = false;
    for (const u of urlCandidates) {
      try {
        await page.goto(u, { waitUntil: "networkidle", timeout: 60000 });
        loaded = true; break;
      } catch { /* 다음 후보 */ }
    }
    if (!loaded) continue;

    // 사람처럼 살짝 스크롤
    for (let i=0;i<3;i++){ await page.mouse.wheel(0, 1400); await sleep(500); }

    const ids = await collectIds(page);
    for (const id of ids) {
      scanned++;
      if (id === TARGET) {
        console.log(JSON.stringify({ ok:true, keyword:KEYWORD, productId:TARGET, page:p, rank:scanned, scanned }, null, 2));
        await ctx.close(); return;
      }
    }
    await sleep(500);
  }

  console.log(JSON.stringify({ ok:false, keyword:KEYWORD, productId:TARGET, rank:null, scanned }, null, 2));
  await ctx.close();
})().catch(async (e) => {
  console.error(JSON.stringify({ ok:false, error: String(e && e.message || e) }));
  process.exit(1);
});

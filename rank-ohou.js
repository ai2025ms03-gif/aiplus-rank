// rank-ohou.js
import { chromium } from "playwright";

const PROXY = process.env.PROXY || ""; // 예: http://user:pass@host:port
const KEYWORD = process.env.KW || "옷걸이";
const TARGET_ID = process.env.PID || "3112642"; // ← 3112642 고정
const MAX_PAGES = parseInt(process.env.PAGES || "2", 10); // 1~2 추천

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

(async () => {
  const server = PROXY && (/^[a-z]+:\/\//i.test(PROXY) ? PROXY : `http://${PROXY}`);
  const browser = await chromium.launch({
    headless: true,
    proxy: server ? { server } : undefined,
    args: ["--disable-blink-features=AutomationControlled"],
  });
  const ctx = await browser.newContext({
    locale: "ko-KR",
    timezoneId: "Asia/Seoul",
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  });
  const page = await ctx.newPage();

  let rank = null;
  let scanned = 0;
  for (let p = 1; p <= MAX_PAGES; p++) {
    const url = `https://ohou.se/store/search?keyword=${encodeURIComponent(KEYWORD)}&page=${p}`;
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });

    // 사람처럼 약간 스크롤
    for (let i = 0; i < 3; i++) { await page.mouse.wheel(0, 1400); await sleep(500); }

    // 상품 카드 href 파싱
    const items = await page.$$eval('a[href*="/productions/"][href$="/selling"]', els => {
      const out = [];
      const seen = new Set();
      for (const a of els) {
        const href = a.getAttribute("href") || "";
        const m = href.match(/\/productions\/(\d+)\/selling/);
        if (!m) continue;
        const id = m[1];
        if (seen.has(id)) continue;
        seen.add(id);
        out.push({ productId: id, link: href.startsWith("http") ? href : `https://ohou.se${href}` });
      }
      return out;
    });

    for (const it of items) {
      scanned++;
      if (it.productId === TARGET_ID) {
        rank = scanned;
        console.log(JSON.stringify({ ok: true, keyword: KEYWORD, productId: TARGET_ID, page: p, rank, scanned }, null, 2));
        await browser.close();
        return;
      }
    }
    await sleep(700);
  }

  console.log(JSON.stringify({ ok: false, keyword: KEYWORD, productId: TARGET_ID, rank: null, scanned }, null, 2));
  await browser.close();
})().catch(async (e) => {
  console.error(JSON.stringify({ ok: false, error: String(e && e.message || e) }));
  process.exit(1);
});

import { chromium } from "playwright";

// ==== 입력 ====
const KW    = process.env.KW || "벽시계";
const URL   = process.env.PRODUCT_URL || "";
const PAGES = parseInt(process.env.PAGES || "2", 10);
// ==============

// 상품 URL에서 id 추출
function parseIds(u){
  const out = {};
  const m1 = /\/vp\/products\/(\d+)/.exec(u) || /\/products\/(\d+)/.exec(u);
  const m2 = /[?&]itemId=(\d+)/.exec(u);
  const m3 = /[?&]vendorItemId=(\d+)/.exec(u);
  if (m1) out.productId = m1[1];
  if (m2) out.itemId = m2[1];
  if (m3) out.vendorItemId = m3[1];
  return out;
}
const target = parseIds(URL);
if (!target.productId) { console.error(JSON.stringify({ok:false,error:"productId parse failed"})); process.exit(1); }

const MURL = (p=1) => `https://m.coupang.com/nm/search?q=${encodeURIComponent(KW)}&page=${p}`;
const sleep = (ms)=>new Promise(r=>setTimeout(r,ms));

(async () => {
  // 모바일 컨텍스트(안드로이드 UA)
  const ctx = await chromium.launchPersistentContext(
    (process.env.USER_DATA_DIR || "C:\\\\Users\\\\MOJISE\\\\coupang-m-profile"),
    {
      headless: false,
      viewport: { width: 420, height: 820 },
      userAgent: "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36",
      locale: "ko-KR",
      timezoneId: "Asia/Seoul",
    }
  );
  await ctx.addInitScript(() => { try{Object.defineProperty(navigator,'webdriver',{get:()=>undefined});}catch{} });
  const page = await ctx.newPage();

  let scanned = 0;
  for (let p=1; p<=PAGES; p++) {
    // 단순 검색 URL 직행
    await page.goto(MURL(p), { waitUntil: "domcontentloaded", timeout: 60000 }).catch(()=>{});
    // 로딩 유도
    for (let i=0;i<4;i++){ await page.mouse.wheel(0, 1200); await sleep(250); }

    // 검색 결과 파싱 (모바일은 앵커 href만으로 충분)
    const items = await page.$$eval('a[href*="/vp/products/"], a[href*="/products/"]', (els) => {
      const seen = new Set();
      return els.map(a => {
        const href = a.getAttribute('href') || '';
        const m = href.match(/\/vp\/products\/(\d+)/) || href.match(/\/products\/(\d+)/);
        const productId = m ? m[1] : null;
        if (!productId || seen.has(productId)) return null;
        seen.add(productId);
        return { productId, itemId: "", vendorItemId: "" };
      }).filter(Boolean);
    }).catch(()=>[]);

    for (const it of items){
      scanned++;
      const hit =
        (target.vendorItemId && it.vendorItemId === target.vendorItemId) ||
        (target.itemId && it.itemId === target.itemId) ||
        (target.productId && it.productId === target.productId);
      if (hit){
        console.log(JSON.stringify({ ok:true, mode:"mobile", site:"coupang", keyword:KW, page:p, rank:scanned, scanned, idInfo:target }, null, 2));
        await ctx.close(); return;
      }
    }
  }

  console.log(JSON.stringify({ ok:false, site:"coupang", keyword:KW, rank:null, scanned, idInfo:target }, null, 2));
  await ctx.close();
})().catch(e => { console.error(JSON.stringify({ ok:false, error:String(e?.message||e) })); process.exit(1); });

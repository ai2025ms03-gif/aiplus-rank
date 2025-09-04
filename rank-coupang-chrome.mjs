import { chromium } from "playwright";

const KW    = process.env.KW || "벽시계";
const URL   = process.env.PRODUCT_URL || "";
const PAGES = parseInt(process.env.PAGES || "2", 10);
const LIST  = parseInt(process.env.LIST || "72", 10);
const PROF  = process.env.USER_DATA_DIR || "C:\\\\Users\\\\MOJISE\\\\coupang-profile";

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
if (!target.productId) throw new Error("PRODUCT_URL에서 productId 파싱 실패");

const DESKTOP_URL = (p=1) => `https://www.coupang.com/np/search?q=${encodeURIComponent(KW)}&page=${p}&listSize=${LIST}`;
const MOBILE_URL  = (p=1) => `https://m.coupang.com/nm/search?q=${encodeURIComponent(KW)}&page=${p}`;

const sleep = (ms)=>new Promise(r=>setTimeout(r,ms));

async function parseDesktop(page){
  return await page.$$eval('li.search-product, li.product, li.baby-product', (els) => {
    return els.map(el => {
      const a = el.querySelector('a.search-product-link, a.baby-product-link, a.prod-link');
      const href = a?.getAttribute('href') || '';
      const m = href.match(/\/vp\/products\/(\d+)/) || href.match(/\/products\/(\d+)/);
      const productId = m ? m[1] : null;
      const itemId = el.getAttribute('data-item-id') || '';
      const vendorItemId = el.getAttribute('data-vendor-item-id') || '';
      return productId ? { productId, itemId, vendorItemId } : null;
    }).filter(Boolean);
  }).catch(()=>[]);
}

async function parseMobile(page){
  return await page.$$eval('a[href*="/vp/products/"], a[href*="/products/"]', (els) => {
    const seen = new Set();
    return els.map(a => {
      const href = a.getAttribute('href') || '';
      const m = href.match(/\/vp\/products\/(\d+)/) || href.match(/\/products\/(\d+)/);
      const productId = m ? m[1] : null;
      if (!productId) return null;
      if (seen.has(productId)) return null;
      seen.add(productId);
      return { productId, itemId: "", vendorItemId: "" };
    }).filter(Boolean);
  }).catch(()=>[]);
}

function isHit(it){
  return (target.vendorItemId && it.vendorItemId===target.vendorItemId)
      || (target.itemId && it.itemId===target.itemId)
      || (target.productId && it.productId===target.productId);
}

(async () => {
  // 1) 데스크톱 시도 (HTTP/2/QUIC 끄지 않음)
  let ctx = await chromium.launchPersistentContext(PROF, {
    channel: "chrome",
    headless: false,
    viewport: { width: 1360, height: 900 },
    locale: "ko-KR",
    timezoneId: "Asia/Seoul",
  });
  await ctx.addInitScript(() => { try{Object.defineProperty(navigator,'webdriver',{get:()=>undefined});}catch{} });
  let page = await ctx.newPage();

  // 홈 → 검색 입력 → 버튼 클릭, 그래도 실패면 URL 직행(파라미터 최소)
  try {
    await page.goto("https://www.coupang.com/", { waitUntil:"domcontentloaded", timeout: 60000 }).catch(()=>{});
    await page.waitForSelector('#headerSearchKeyword', { timeout: 8000 }).catch(()=>{});
    const box = await page.$('#headerSearchKeyword');
    if (box) { await box.click(); await box.fill(KW); }
    const clickAndWait = async () => {
      const btn = await page.$('#headerSearchBtn, button[type="submit"]');
      if (btn) {
        await Promise.all([ page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 15000 }).catch(()=>{}), btn.click() ]);
      }
    };
    await clickAndWait();
    if (!/\/np\/search\?/.test(page.url())) {
      await page.goto(DESKTOP_URL(1), { waitUntil:"domcontentloaded", timeout: 60000 });
    }
  } catch {}

  // 빈 DOM 감지 → 모바일 폴백
  let useMobile = false;
  try {
    await page.waitForTimeout(1200);
    const blank = await page.evaluate(() => document.body && document.body.children.length < 10);
    if (blank) useMobile = true;
  } catch { useMobile = true; }

  let scanned = 0;
  if (!useMobile) {
    for (let p=1; p<=PAGES; p++){
      if (p>1) await page.goto(DESKTOP_URL(p), { waitUntil:"domcontentloaded", timeout: 60000 }).catch(()=>{});
      for (let i=0;i<3;i++){ await page.mouse.wheel(0,1600); await sleep(300); }
      const items = await parseDesktop(page);
      // 여전히 빈 페이지면 즉시 모바일로 전환
      if (!items || items.length===0) { useMobile = true; break; }
      for (const it of items){ scanned++; if (isHit(it)) {
        console.log(JSON.stringify({ ok:true, mode:"desktop", site:"coupang", keyword:KW, page:p, rank:scanned, scanned, idInfo:target }, null, 2));
        await ctx.close(); return; } }
    }
  }

  // 2) 모바일 폴백 (Android UA, m.coupang)
  if (useMobile) {
    await ctx.close().catch(()=>{});
    ctx = await chromium.launchPersistentContext(PROF+"-m", {
      headless: false,
      viewport: { width: 420, height: 800 },
      userAgent: "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36",
      locale: "ko-KR",
      timezoneId: "Asia/Seoul",
    });
    await ctx.addInitScript(() => { try{Object.defineProperty(navigator,'webdriver',{get:()=>undefined});}catch{} });
    page = await ctx.newPage();

    for (let p=1; p<=PAGES; p++){
      await page.goto(MOBILE_URL(p), { waitUntil:"domcontentloaded", timeout: 60000 }).catch(()=>{});
      for (let i=0;i<3;i++){ await page.mouse.wheel(0,1200); await sleep(250); }
      const items = await parseMobile(page);
      for (const it of items){ scanned++; if (isHit(it)) {
        console.log(JSON.stringify({ ok:true, mode:"mobile", site:"coupang", keyword:KW, page:p, rank:scanned, scanned, idInfo:target }, null, 2));
        await ctx.close(); return; } }
    }
  }

  console.log(JSON.stringify({ ok:false, site:"coupang", keyword:KW, rank:null, scanned, idInfo:target }, null, 2));
  await ctx.close();
})().catch(e => { console.error(JSON.stringify({ ok:false, error:String(e?.message||e) })); process.exit(1); });

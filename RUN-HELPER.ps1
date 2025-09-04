# Run helper for aiplus-rank (Windows PowerShell)
# 1) Install deps
npm install
# If playwright was added, ensure browsers are installed:
npx playwright install

# 2) Sanity checks
$env:KW="옷걸이"
$env:PID="3112642"
$env:PAGES="2"

# Optional proxy (uncomment if you have one)
# $env:PROXY="http://user:pass@host:port"
# $env:HTTP_PROXY=$env:PROXY; $env:HTTPS_PROXY=$env:PROXY

# 3) Test proxy
node .\CHATGPT_PATCHES\proxy-check.mjs

# 4) Run 오늘의집 (Chrome GUI)
node .\rank-ohou-chrome.mjs

# 5) Run 쿠팡 (needs PRODUCT_URL) example:
# $env:KW="벽시계"
# $env:PRODUCT_URL="https://www.coupang.com/vp/products/12345678?itemId=987654&vendorItemId=345678"
# node .\rank-coupang-chrome.mjs

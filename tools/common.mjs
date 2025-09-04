import { HttpsProxyAgent } from 'https-proxy-agent';
import { HttpProxyAgent } from 'http-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';

export const sleep = (ms) => new Promise(r => setTimeout(r, ms + Math.floor(Math.random()*200)));

export function buildProxyAgent(proxy) {
  if (!proxy) return undefined;
  if (proxy.startsWith('http://'))  return new HttpProxyAgent(proxy);
  if (proxy.startsWith('https://')) return new HttpsProxyAgent(proxy);
  if (proxy.startsWith('socks'))    return new SocksProxyAgent(proxy);
  return undefined;
}

export function parseOhouIdFromUrl(u=''){
  const m = u.match(/\/productions\/(\d+)(?:\/selling)?/);
  return m ? m[1] : null;
}

export function parseCoupangIds(u=''){
  const out = {};
  const m1 = /\/vp\/products\/(\d+)/.exec(u) || /\/products\/(\d+)/.exec(u);
  const m2 = /[?&]itemId=(\d+)/.exec(u);
  const m3 = /[?&]vendorItemId=(\d+)/.exec(u);
  if (m1) out.productId = m1[1];
  if (m2) out.itemId = m2[1];
  if (m3) out.vendorItemId = m3[1];
  return out;
}

import axios from 'axios';
import { HttpsProxyAgent } from 'https-proxy-agent';

const proxy = process.env.PROXY;
const agent = proxy ? new HttpsProxyAgent(proxy) : undefined;

try {
  const res = await axios.get('https://ipinfo.io/json', { httpsAgent: agent, timeout: 10000 });
  console.log(JSON.stringify({ ok:true, data:res.data }, null, 2));
} catch (e) {
  console.error(JSON.stringify({ ok:false, error: String(e && e.message || e) }, null, 2));
  process.exit(1);
}

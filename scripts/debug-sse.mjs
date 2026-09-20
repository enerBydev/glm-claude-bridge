// Debug: fetch upstream SSE con node fetch y ver bytes crudos + parser
import { loadZaiConfig, upstreamHeaders, upstreamUrl } from '../zai-config.mjs';

const cfg = loadZaiConfig();
const body = {
  model: 'glm-5.3-flash',
  messages: [{ role: 'user', content: 'cuenta del 1 al 3' }],
  max_tokens: 40, stream: true, thinking: { type: 'disabled' },
};

const res = await fetch(upstreamUrl(cfg), {
  method: 'POST',
  headers: upstreamHeaders(cfg),
  body: JSON.stringify(body),
});
console.log('status:', res.status, '| CT:', res.headers.get('content-type'));

let raw = '';
const decoder = new TextDecoder();
for await (const chunk of res.body) {
  const s = decoder.decode(chunk, { stream: true });
  raw += s;
}
console.log('RAW len:', raw.length);
console.log('RAW repr (primeros 600):');
console.log(JSON.stringify(raw.slice(0, 600)));
console.log('---');
// simular parser del bridge
let buf = ''; const payloads = [];
let b = '';
for (const line of raw.split('\n')) {
  const l = line.replace(/\r$/, '');
  if (l.startsWith('data:')) { const p = l.slice(5).trim(); if (p) payloads.push(p); }
}
console.log('payloads con split simple:', payloads.length, '| ultimo:', payloads[payloads.length-1]);

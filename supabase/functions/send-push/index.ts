import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const VAPID_PUBLIC  = Deno.env.get('VAPID_PUBLIC')!;
const VAPID_PRIVATE = Deno.env.get('VAPID_PRIVATE')!;
const SUPABASE_URL  = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_KEY  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

// ── Minimal Web Push implementation ─────────────────────────────
async function importPrivateKey(b64: string) {
  const der = Uint8Array.from(atob(b64.replace(/-/g,'+').replace(/_/g,'/')), c => c.charCodeAt(0));
  return crypto.subtle.importKey('pkcs8', der, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
}

function b64url(buf: ArrayBuffer) {
  return btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}

async function makeJwt(audience: string) {
  const header = b64url(new TextEncoder().encode(JSON.stringify({ typ:'JWT', alg:'ES256' })));
  const payload = b64url(new TextEncoder().encode(JSON.stringify({
    aud: audience, exp: Math.floor(Date.now()/1000) + 3600, sub: 'mailto:fedecherny@gmail.com'
  })));
  const key = await importPrivateKey(VAPID_PRIVATE);
  const sig = await crypto.subtle.sign({ name:'ECDSA', hash:'SHA-256' }, key,
    new TextEncoder().encode(`${header}.${payload}`));
  return `${header}.${payload}.${b64url(sig)}`;
}

async function sendPush(sub: { endpoint: string; keys: { p256dh: string; auth: string } }, payload: string) {
  const url = new URL(sub.endpoint);
  const audience = `${url.protocol}//${url.host}`;
  const jwt = await makeJwt(audience);

  // Encrypt payload with ECDH + AES-GCM (RFC 8291)
  const serverKeys = await crypto.subtle.generateKey({ name:'ECDH', namedCurve:'P-256' }, true, ['deriveKey','deriveBits']);
  const serverPub = await crypto.subtle.exportKey('raw', serverKeys.publicKey);

  const clientPub = Uint8Array.from(atob(sub.keys.p256dh.replace(/-/g,'+').replace(/_/g,'/')), c=>c.charCodeAt(0));
  const clientKey = await crypto.subtle.importKey('raw', clientPub, { name:'ECDH', namedCurve:'P-256' }, false, []);
  const auth = Uint8Array.from(atob(sub.keys.auth.replace(/-/g,'+').replace(/_/g,'/')), c=>c.charCodeAt(0));

  const ikm = await crypto.subtle.deriveBits({ name:'ECDH', public: clientKey }, serverKeys.privateKey, 256);
  const prk = await crypto.subtle.importKey('raw', await crypto.subtle.deriveBits(
    { name:'HKDF', hash:'SHA-256', salt: auth, info: new TextEncoder().encode('Content-Encoding: auth\0') },
    await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']), 256
  ), 'HKDF', false, ['deriveBits','deriveKey']);

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const keyInfo = new Uint8Array([...new TextEncoder().encode('Content-Encoding: aesgcm\0'), 0, 65, ...new Uint8Array(serverPub), 0, 65, ...clientPub]);
  const nonceInfo = new Uint8Array([...new TextEncoder().encode('Content-Encoding: nonce\0'), 0, 65, ...new Uint8Array(serverPub), 0, 65, ...clientPub]);

  const aesKey = await crypto.subtle.deriveKey(
    { name:'HKDF', hash:'SHA-256', salt, info: keyInfo },
    prk, { name:'AES-GCM', length:128 }, false, ['encrypt']
  );
  const nonce = (await crypto.subtle.deriveBits({ name:'HKDF', hash:'SHA-256', salt, info: nonceInfo }, prk, 96));

  const data = new TextEncoder().encode(payload);
  const padded = new Uint8Array([0, 0, ...data]);
  const encrypted = await crypto.subtle.encrypt({ name:'AES-GCM', iv: nonce }, aesKey, padded);

  const body = new Uint8Array([...salt, 0, 0, 16, 0, 65, ...new Uint8Array(serverPub), ...new Uint8Array(encrypted)]);

  return fetch(sub.endpoint, {
    method: 'POST',
    headers: {
      'Authorization': `vapid t=${jwt},k=${VAPID_PUBLIC}`,
      'Content-Type': 'application/octet-stream',
      'Content-Encoding': 'aesgcm',
      'Encryption': `salt=${b64url(salt.buffer)}`,
      'Crypto-Key': `dh=${b64url(serverPub)};p256ecdsa=${VAPID_PUBLIC}`,
      'TTL': '86400',
    },
    body,
  });
}

// ── Handler ──────────────────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: { 'Access-Control-Allow-Origin':'*', 'Access-Control-Allow-Headers':'*' } });

  const { user_keys, title, body, url } = await req.json();
  const payload = JSON.stringify({ title, body, url: url || '/' });

  const sb = createClient(SUPABASE_URL, SUPABASE_KEY);
  const { data: subs } = await sb.from('push_subscriptions')
    .select('subscription')
    .in('user_key', user_keys);

  const results = await Promise.allSettled(
    (subs || []).map(row => sendPush(JSON.parse(row.subscription), payload))
  );

  return new Response(JSON.stringify({ sent: results.length }), {
    headers: { 'Content-Type':'application/json', 'Access-Control-Allow-Origin':'*' }
  });
});

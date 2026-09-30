import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import webpush from 'npm:web-push@3.6.7';

const VAPID_PUBLIC  = Deno.env.get('VAPID_PUBLIC')!;
const VAPID_PRIVATE = Deno.env.get('VAPID_PRIVATE')!;
const SUPABASE_URL  = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_KEY  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

webpush.setVapidDetails('mailto:fedecherny@gmail.com', VAPID_PUBLIC, VAPID_PRIVATE);

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, {
    headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' }
  });

  const { user_keys, title, body, url } = await req.json();
  const payload = JSON.stringify({ title, body, url: url || '/la-casa-radio/' });

  const sb = createClient(SUPABASE_URL, SUPABASE_KEY);
  const { data: rows } = await sb.from('push_subscriptions').select('data');

  const subs = (rows || [])
    .filter(r => user_keys.includes(r.data?.user_key))
    .map(r => { try { return JSON.parse(r.data?.subscription); } catch { return null; } })
    .filter(Boolean);

  console.log(`Enviando push a ${subs.length} suscripciones para keys: ${user_keys}`);

  const results = await Promise.allSettled(
    subs.map(sub => webpush.sendNotification(sub, payload))
  );

  results.forEach((r, i) => {
    if (r.status === 'rejected') console.error(`Error sub ${i}:`, r.reason);
  });

  return new Response(JSON.stringify({ sent: subs.length, results: results.map(r => r.status) }), {
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
  });
});

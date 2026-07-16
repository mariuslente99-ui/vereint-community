const KV_NAME = 'VEREINT_TICKETS';

export async function onRequestGet({ request, env }) {
  try {
    const url = new URL(request.url);
    const slug = cleanSlug(url.searchParams.get('event') || '');
    if (!slug) return json({ error: 'Event fehlt.' }, 400);
    const inventory = await readInventory(env, slug);
    return json({ eventSlug: slug, ...inventory });
  } catch (error) {
    return json({ error: error?.message || 'Ticketbestand konnte nicht gelesen werden.' }, 500);
  }
}

export async function onRequestPost({ request, env }) {
  try {
    const payload = await request.json();
    const slug = cleanSlug(payload.eventSlug || payload.event_slug || '');
    if (!slug) return json({ error: 'Event fehlt.' }, 400);
    const quantity = Math.max(0, Number(payload.quantity || 0));
    const earlyBirdQuantity = Math.max(0, Number(payload.earlyBirdQuantity || payload.early_bird_quantity || 0));
    const sessionId = String(payload.sessionId || payload.stripe_session_id || '').trim();
    if (!quantity) return json({ error: 'Ticketanzahl fehlt.' }, 400);
    const updated = await incrementInventory(env, slug, { quantity, earlyBirdQuantity, sessionId });
    return json({ eventSlug: slug, ...updated });
  } catch (error) {
    return json({ error: error?.message || 'Ticketbestand konnte nicht aktualisiert werden.' }, 500);
  }
}

async function readInventory(env, slug) {
  const kv = env && env[KV_NAME];
  if (!kv) return { bookedTickets: 0, earlyBirdBooked: 0, processedSessions: [] };
  const data = await kv.get(key(slug), 'json');
  return normaliseInventory(data);
}

async function incrementInventory(env, slug, update) {
  const kv = env && env[KV_NAME];
  if (!kv) return { bookedTickets: update.quantity, earlyBirdBooked: update.earlyBirdQuantity, processedSessions: [] };
  const current = normaliseInventory(await kv.get(key(slug), 'json'));
  if (update.sessionId && current.processedSessions.includes(update.sessionId)) return current;
  const next = {
    bookedTickets: current.bookedTickets + update.quantity,
    earlyBirdBooked: current.earlyBirdBooked + update.earlyBirdQuantity,
    processedSessions: update.sessionId ? current.processedSessions.concat(update.sessionId).slice(-250) : current.processedSessions
  };
  await kv.put(key(slug), JSON.stringify(next));
  return next;
}

function normaliseInventory(data) {
  const processed = Array.isArray(data?.processedSessions) ? data.processedSessions.map(String).filter(Boolean) : [];
  return {
    bookedTickets: Math.max(0, Number(data?.bookedTickets || 0)),
    earlyBirdBooked: Math.max(0, Number(data?.earlyBirdBooked || 0)),
    processedSessions: processed
  };
}

function key(slug) { return 'event:' + cleanSlug(slug); }
function cleanSlug(value) { return String(value || '').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 120); }
function json(body, status = 200) { return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }); }

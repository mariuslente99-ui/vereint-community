export async function onRequestGet({ request, env }) {
  try {
    if (!env.STRIPE_SECRET_KEY) return json({ paid: false, error: 'STRIPE_SECRET_KEY fehlt.' }, 500);
    const url = new URL(request.url);
    const sessionId = String(url.searchParams.get('session_id') || '').trim();
    if (!/^cs_(test|live)_/.test(sessionId)) return json({ paid: false, error: 'Stripe Session fehlt.' }, 400);
    const stripeResponse = await fetch('https://api.stripe.com/v1/checkout/sessions/' + encodeURIComponent(sessionId), {
      headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` }
    });
    const data = await stripeResponse.json();
    if (!stripeResponse.ok) return json({ paid: false, error: data?.error?.message || 'Stripe Session konnte nicht geprüft werden.' }, stripeResponse.status);
    const paid = data.payment_status === 'paid' || data.status === 'complete';

    let inventory = null;
    if (paid) {
      inventory = await incrementInventory(env, data.metadata?.event_slug || '', {
        quantity: Math.max(0, Number(data.metadata?.quantity || 0)),
        earlyBirdQuantity: Math.max(0, Number(data.metadata?.early_bird_quantity || 0)),
        sessionId
      });
    }
    return json({
      paid,
      status: data.status || '',
      payment_status: data.payment_status || '',
      eventSlug: data.metadata?.event_slug || '',
      eventName: data.metadata?.event_name || '',
      quantity: data.metadata?.quantity || '',
      earlyBirdQuantity: data.metadata?.early_bird_quantity || '',
      normalQuantity: data.metadata?.normal_quantity || '',
      bookedTickets: inventory?.bookedTickets || 0,
      earlyBirdBooked: inventory?.earlyBirdBooked || 0
    });
  } catch (error) {
    return json({ paid: false, error: error?.message || 'Stripe Session konnte nicht geprüft werden.' }, 500);
  }
}


async function incrementInventory(env, slug, update) {
  const kv = env && env.VEREINT_TICKETS;
  if (!kv || !slug || !update.quantity) return null;
  const key = 'event:' + cleanSlug(slug);
  const current = normaliseInventory(await kv.get(key, 'json'));
  if (update.sessionId && current.processedSessions.includes(update.sessionId)) return current;
  const next = {
    bookedTickets: current.bookedTickets + Math.max(0, Number(update.quantity || 0)),
    earlyBirdBooked: current.earlyBirdBooked + Math.max(0, Number(update.earlyBirdQuantity || 0)),
    processedSessions: update.sessionId ? current.processedSessions.concat(update.sessionId).slice(-250) : current.processedSessions
  };
  await kv.put(key, JSON.stringify(next));
  return next;
}

function normaliseInventory(data) {
  return {
    bookedTickets: Math.max(0, Number(data?.bookedTickets || 0)),
    earlyBirdBooked: Math.max(0, Number(data?.earlyBirdBooked || 0)),
    processedSessions: Array.isArray(data?.processedSessions) ? data.processedSessions.map(String).filter(Boolean) : []
  };
}

function cleanSlug(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 120);
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

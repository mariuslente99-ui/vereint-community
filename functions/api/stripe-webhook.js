export async function onRequestPost({ request, env }) {
  try {
    const body = await request.text();
    let event;
    try { event = JSON.parse(body); } catch (error) { return json({ error: 'Invalid Stripe webhook JSON.' }, 400); }

    const type = String(event?.type || '');
    const object = event?.data?.object || {};
    if (type !== 'checkout.session.completed' && type !== 'checkout.session.async_payment_succeeded') {
      return json({ received: true, ignored: type });
    }

    const slug = object?.metadata?.event_slug || '';
    const name = cleanLabel(object?.metadata?.event_name || slug || 'vereint. Ticket');
    const domain = env.PLAUSIBLE_DOMAIN || 'vereint.community';
    const plausibleEventName = 'Ticket Purchased: ' + name;

    const quantity = Math.max(0, Number(object?.metadata?.quantity || 0));
    const earlyBirdQuantity = Math.max(0, Number(object?.metadata?.early_bird_quantity || 0));
    await incrementInventory(env, slug, { quantity, earlyBirdQuantity, sessionId: object?.id || '' });
    const props = {
      event_name: name,
      event_slug: slug,
      funnel_step: 'ticket_purchased_paid',
      quantity: object?.metadata?.quantity || '',
      amount_total: String(object?.amount_total || ''),
      currency: object?.currency || 'eur',
      stripe_session_id: object?.id || ''
    };

    await fetch('https://plausible.io/api/event', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'vereint-community-stripe-webhook' },
      body: JSON.stringify({
        name: plausibleEventName,
        url: 'https://' + domain + '/funnel/ticket-purchased/' + encodeURIComponent(slug || 'unknown'),
        domain,
        props
      })
    }).catch(() => null);

    return json({ received: true, tracked: plausibleEventName });
  } catch (error) {
    return json({ error: error?.message || 'Webhook konnte nicht verarbeitet werden.' }, 500);
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

function cleanLabel(value) {
  return String(value || 'Event').replace(/\s+/g, ' ').trim().slice(0, 90);
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

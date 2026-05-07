export async function onRequestPost({ request, env }) {
  try {
    if (!env.STRIPE_SECRET_KEY) {
      return json({ error: 'STRIPE_SECRET_KEY is missing in Cloudflare Pages environment variables.' }, 500);
    }

    const payload = await request.json();

    const slug = cleanSlug(payload.eventSlug || '');
    const requestedQty = Math.max(0, Number(payload.quantity || 0));
    const inventory = await readInventory(env, slug);
    const baseBooked = Math.max(0, Number(payload.bookedTickets || 0));
    const baseEarlyBooked = Math.max(0, Number(payload.earlyBirdBooked || 0));
    const totalTickets = Math.max(0, Number(payload.totalTickets || 0));
    const earlyBirdTickets = Math.max(0, Number(payload.earlyBirdTickets || 0));
    const availableTickets = totalTickets ? Math.max(0, totalTickets - baseBooked - inventory.bookedTickets) : requestedQty;
    const earlyBirdAvailable = Math.max(0, earlyBirdTickets - baseEarlyBooked - inventory.earlyBirdBooked);
    if (!requestedQty || requestedQty > availableTickets) {
      return json({ error: 'Leider sind nicht mehr genug Tickets verfügbar. Bitte lade die Seite neu.' }, 409);
    }
    payload.quantity = requestedQty;
    payload.earlyBirdQuantity = Math.min(Math.max(0, Number(payload.earlyBirdQuantity || 0)), earlyBirdAvailable, requestedQty);
    payload.normalQuantity = Math.max(0, requestedQty - payload.earlyBirdQuantity);
    const origin = new URL(request.url).origin;
    const params = new URLSearchParams();

    params.append('mode', 'payment');
    params.append('customer_email', String(payload.email || ''));
    params.append('client_reference_id', String(payload.clientReference || ''));
    params.append('success_url', `${origin}/checkout.html?event=${encodeURIComponent(payload.eventSlug || '')}&status=success&session_id={CHECKOUT_SESSION_ID}`);
    params.append('cancel_url', `${origin}/checkout.html?event=${encodeURIComponent(payload.eventSlug || '')}&status=cancelled`);
    params.append('invoice_creation[enabled]', 'true');
    params.append('metadata[event_slug]', safeMeta(payload.eventSlug));
    params.append('metadata[event_name]', safeMeta(payload.eventName));
    params.append('metadata[event_date]', safeMeta(payload.eventDate));
    params.append('metadata[event_time]', safeMeta(payload.eventTime));
    params.append('metadata[quantity]', safeMeta(payload.quantity));
    params.append('metadata[early_bird_quantity]', safeMeta(payload.earlyBirdQuantity));
    params.append('metadata[normal_quantity]', safeMeta(payload.normalQuantity));
    params.append('metadata[unit]', safeMeta(payload.unit));
    params.append('metadata[ticket_holders]', safeMeta(payload.ticketHolders));
    params.append('metadata[billing_name]', safeMeta(payload.billingName));
    params.append('metadata[billing_address]', safeMeta(payload.billingAddress));
    params.append('metadata[phone]', safeMeta(payload.phone));
    params.append('metadata[phone_count]', safeMeta(payload.phoneCount));
    params.append('metadata[required_phone_count]', safeMeta(payload.requiredPhoneCount));
    params.append('metadata[location]', safeMeta([payload.locationName, payload.address, payload.postalCode, payload.city].filter(Boolean).join(', ')));

    const earlyQty = Math.max(0, Number(payload.earlyBirdQuantity || 0));
    const normalQty = Math.max(0, Number(payload.normalQuantity || 0));
    let index = 0;

    if (earlyQty > 0) {
      appendLineItem(params, index++, {
        name: `${payload.eventName} · Early Bird`,
        description: `${payload.eventDate || ''} ${payload.eventTime || ''}`.trim(),
        unitAmount: Number(payload.earlyBirdUnitPrice || 0) * 100,
        quantity: earlyQty,
      });
    }
    if (normalQty > 0) {
      appendLineItem(params, index++, {
        name: `${payload.eventName} · Normalpreis`,
        description: `${payload.eventDate || ''} ${payload.eventTime || ''}`.trim(),
        unitAmount: Number(payload.normalUnitPrice || 0) * 100,
        quantity: normalQty,
      });
    }
    if (index === 0) {
      appendLineItem(params, index++, {
        name: String(payload.eventName || 'vereint. Ticket'),
        description: `${payload.eventDate || ''} ${payload.eventTime || ''}`.trim(),
        unitAmount: Number(payload.total || 0) * 100,
        quantity: 1,
      });
    }

    const stripeResponse = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params,
    });

    const data = await stripeResponse.json();
    if (!stripeResponse.ok) {
      return json({ error: data?.error?.message || 'Stripe Checkout konnte nicht erstellt werden.' }, stripeResponse.status);
    }

    return json({ url: data.url, id: data.id });
  } catch (error) {
    return json({ error: error?.message || 'Checkout Session konnte nicht erstellt werden.' }, 500);
  }
}

function appendLineItem(params, index, item) {
  params.append(`line_items[${index}][price_data][currency]`, 'eur');
  params.append(`line_items[${index}][price_data][product_data][name]`, String(item.name || 'vereint. Ticket'));
  if (item.description) params.append(`line_items[${index}][price_data][product_data][description]`, String(item.description));
  params.append(`line_items[${index}][price_data][unit_amount]`, String(Math.round(Number(item.unitAmount || 0))));
  params.append(`line_items[${index}][quantity]`, String(Math.max(1, Number(item.quantity || 1))));
}


async function readInventory(env, slug) {
  const kv = env && env.VEREINT_TICKETS;
  if (!kv || !slug) return { bookedTickets: 0, earlyBirdBooked: 0 };
  const data = await kv.get('event:' + slug, 'json');
  return {
    bookedTickets: Math.max(0, Number(data?.bookedTickets || 0)),
    earlyBirdBooked: Math.max(0, Number(data?.earlyBirdBooked || 0)),
  };
}

function cleanSlug(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 120);
}

function safeMeta(value) {
  return String(value == null ? '' : value).slice(0, 500);
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

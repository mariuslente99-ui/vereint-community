export async function onRequestPost({ request, env }) {
  try {
    if (!env.STRIPE_SECRET_KEY) {
      return json({ error: 'STRIPE_SECRET_KEY is missing in Cloudflare Pages environment variables.' }, 500);
    }

    const payload = await request.json();
    const validationError = validateContactData(payload);
    if (validationError) return json({ error: validationError }, 400);

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
    payload.email = String(payload.email || '').trim();
    payload.billingName = normaliseSingleLine(payload.billingName);
    payload.billingAddress = String(payload.billingAddress || '').trim();
    payload.ticketHolders = String(payload.ticketHolders || '').trim();
    payload.phone = splitEntries(payload.phone).join('\n');
    payload.phoneCount = splitEntries(payload.phone).length;
    payload.requiredPhoneCount = Math.max(1, Number(payload.requiredPhoneCount || 1));

    const origin = new URL(request.url).origin;
    const clientReference = cleanClientReference(payload.clientReference || `${slug}-${Date.now()}`);
    const stripeDescription = buildStripeDescription(payload);

    // Create a real Stripe Customer first. This makes the buyer's email, name and
    // primary phone directly visible/searchable in the Stripe customer dashboard.
    // All ticket-holder names and every submitted phone number are also copied to
    // metadata below, so no participant data is lost.
    const customerParams = new URLSearchParams();
    customerParams.append('email', payload.email.slice(0, 512));
    customerParams.append('name', payload.billingName.slice(0, 256));
    customerParams.append('phone', splitEntries(payload.phone)[0].slice(0, 20));
    customerParams.append('description', stripeDescription);
    appendOrderMetadata(customerParams, 'metadata', payload, clientReference);

    const customerResponse = await stripePost(
      env,
      'https://api.stripe.com/v1/customers',
      customerParams,
      `vereint-customer-${clientReference}`
    );
    if (!customerResponse.ok) {
      return json({ error: customerResponse.error || 'Stripe-Kundendaten konnten nicht angelegt werden.' }, customerResponse.status);
    }

    const params = new URLSearchParams();
    params.append('mode', 'payment');
    params.append('customer', String(customerResponse.data.id || ''));
    params.append('client_reference_id', clientReference);
    params.append('success_url', `${origin}/checkout.html?event=${encodeURIComponent(payload.eventSlug || '')}&status=success&session_id={CHECKOUT_SESSION_ID}`);
    params.append('cancel_url', `${origin}/checkout.html?event=${encodeURIComponent(payload.eventSlug || '')}&status=cancelled`);
    params.append('invoice_creation[enabled]', 'true');

    // Keep the order data on every relevant Stripe object:
    // Checkout Session, PaymentIntent/Charge and post-purchase Invoice.
    appendOrderMetadata(params, 'metadata', payload, clientReference);
    appendOrderMetadata(params, 'payment_intent_data[metadata]', payload, clientReference);
    appendOrderMetadata(params, 'invoice_creation[invoice_data][metadata]', payload, clientReference);
    params.append('payment_intent_data[description]', stripeDescription);
    params.append('invoice_creation[invoice_data][description]', stripeDescription);

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

    const sessionResponse = await stripePost(
      env,
      'https://api.stripe.com/v1/checkout/sessions',
      params,
      `vereint-session-${clientReference}`
    );
    if (!sessionResponse.ok) {
      return json({ error: sessionResponse.error || 'Stripe Checkout konnte nicht erstellt werden.' }, sessionResponse.status);
    }

    return json({
      url: sessionResponse.data.url,
      id: sessionResponse.data.id,
      customerId: customerResponse.data.id,
    });
  } catch (error) {
    return json({ error: error?.message || 'Checkout Session konnte nicht erstellt werden.' }, 500);
  }
}

function validateContactData(payload) {
  const email = String(payload?.email || '').trim();
  const billingName = normaliseSingleLine(payload?.billingName);
  const ticketHolders = String(payload?.ticketHolders || '').trim();
  const phones = splitEntries(payload?.phone);
  const requiredPhoneCount = Math.max(1, Number(payload?.requiredPhoneCount || 1));

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return 'Bitte gib eine gültige Mailadresse an.';
  if (!billingName) return 'Bitte gib einen Rechnungsnamen an.';
  if (!ticketHolders) return 'Bitte gib die Namen aller Ticketinhaber an.';
  if (phones.length < requiredPhoneCount) {
    return `Bitte gib mindestens ${requiredPhoneCount} Telefonnummer${requiredPhoneCount === 1 ? '' : 'n'} an.`;
  }
  return '';
}

function appendLineItem(params, index, item) {
  params.append(`line_items[${index}][price_data][currency]`, 'eur');
  params.append(`line_items[${index}][price_data][product_data][name]`, String(item.name || 'vereint. Ticket'));
  if (item.description) params.append(`line_items[${index}][price_data][product_data][description]`, String(item.description));
  params.append(`line_items[${index}][price_data][unit_amount]`, String(Math.round(Number(item.unitAmount || 0))));
  params.append(`line_items[${index}][quantity]`, String(Math.max(1, Number(item.quantity || 1))));
}

function appendOrderMetadata(params, prefix, payload, clientReference) {
  const values = {
    order_reference: clientReference,
    event_slug: payload.eventSlug,
    event_name: payload.eventName,
    event_date: payload.eventDate,
    event_time: payload.eventTime,
    quantity: payload.quantity,
    early_bird_quantity: payload.earlyBirdQuantity,
    normal_quantity: payload.normalQuantity,
    unit: payload.unit,
    ticket_holders: payload.ticketHolders,
    billing_name: payload.billingName,
    billing_address: payload.billingAddress,
    email: payload.email,
    phone: payload.phone,
    phone_count: payload.phoneCount || splitEntries(payload.phone).length,
    required_phone_count: payload.requiredPhoneCount,
    team_preference: payload.teamPreference,
    location: [payload.locationName, payload.address, payload.postalCode, payload.city].filter(Boolean).join(', '),
  };

  Object.entries(values).forEach(([key, value]) => appendMetadata(params, prefix, key, value));
}

function appendMetadata(params, prefix, key, value) {
  const text = String(value == null ? '' : value).trim();
  params.append(`${prefix}[${key}]`, text.slice(0, 500));
  if (text.length <= 500) return;

  const chunks = splitChunks(text, 490).slice(0, 9);
  chunks.forEach((chunk, index) => {
    params.append(`${prefix}[${key}_${String(index + 1).padStart(2, '0')}]`, chunk);
  });
}

function buildStripeDescription(payload) {
  const holders = normaliseInlineList(payload.ticketHolders);
  const phones = splitEntries(payload.phone).join(', ');
  const parts = [
    `vereint. Ticket: ${normaliseSingleLine(payload.eventName)}`,
    `Rechnungsname: ${normaliseSingleLine(payload.billingName)}`,
    `Ticketinhaber: ${holders}`,
    `Telefon: ${phones}`,
  ].filter((part) => !part.endsWith(': '));
  return parts.join(' | ').slice(0, 1000);
}

async function stripePost(env, url, params, idempotencyKey) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Idempotency-Key': String(idempotencyKey || '').slice(0, 255),
    },
    body: params,
  });

  const data = await response.json().catch(() => ({}));
  return {
    ok: response.ok,
    status: response.status,
    data,
    error: data?.error?.message || '',
  };
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

function splitEntries(value) {
  return String(value == null ? '' : value)
    .split(/\r?\n+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function normaliseSingleLine(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
}

function normaliseInlineList(value) {
  return splitEntries(value).join('; ');
}

function cleanSlug(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 120);
}

function cleanClientReference(value) {
  return String(value || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 180) || `vereint-${Date.now()}`;
}

function splitChunks(value, size) {
  const chunks = [];
  for (let i = 0; i < value.length; i += size) chunks.push(value.slice(i, i + size));
  return chunks;
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// Policy engine: deterministic business rules that decide what happens to a ticket.
// The LLM only labels the ticket (intent, flags, sentiment). Code decides the action,
// so the AI never decides on its own to send money-related or risky replies.
//
// This file is the single source of truth. scripts/build-workflows.js embeds it into
// the n8n Code nodes, and tests/policy-engine.test.js runs it against the labelled test set.

const INTENTS = [
  'order_status', 'return_request', 'refund_status', 'damaged_or_wrong_item',
  'cancel_or_change_order', 'product_question', 'shipping_question',
  'billing_or_discount', 'complaint', 'other', 'spam',
];
const RISK_FLAGS = ['legal_threat', 'chargeback_threat', 'safety_issue', 'prompt_injection'];
const URGENT_FLAGS = ['legal_threat', 'chargeback_threat', 'safety_issue'];
const ACTIONS = ['auto_reply', 'needs_approval', 'human_handoff', 'ignore'];

const POLICY_DEFAULTS = {
  return_window_days: 30,
  damage_window_days: 14,
  overdue_grace_days: 3,
  min_confidence: 0.6,
};

const DAY_MS = 86400000;

function normalizeOrderNumber(raw) {
  if (raw === null || raw === undefined) return null;
  const m = String(raw).match(/(\d{4,6})/);
  return m ? 'DS-' + m[1] : null;
}

// Fallback extraction when the LLM misses the order number.
function extractOrderNumber(text) {
  const s = String(text || '');
  const m = s.match(/\b(?:DS[-\s]?|#\s?)(\d{4})\b/i)
    || s.match(/\border\s*(?:no\.?|number|nr\.?|#)?\s*:?\s*(\d{4})\b/i);
  return m ? 'DS-' + m[1] : null;
}

// Accept the LLM's order number only if its digits really appear in the email.
function pickOrderNumber(ticket, triage) {
  const text = (ticket.subject || '') + ' ' + (ticket.body || '');
  const fromLlm = normalizeOrderNumber(triage && triage.order_number);
  if (fromLlm && text.includes(fromLlm.slice(3))) return fromLlm;
  return extractOrderNumber(text);
}

// Deterministic hostility check, so one mislabelled sentiment can't lead to an auto-reply.
// (Added after eval run 1: the model labelled a shouting customer "negative", not "angry".)
const NOT_SHOUTING = ['DS', 'USPS', 'UPS', 'DHL', 'USA', 'USB', 'LED', 'SKU', 'ETA', 'ASAP', 'FAQ', 'BTU', 'ET', 'OK', 'EU', 'UK', 'VAT'];
function hostilitySignals(text) {
  const s = String(text || '');
  const signals = [];
  const capsWords = (s.match(/\b[A-Z]{3,}\b/g) || []).filter(w => !NOT_SHOUTING.includes(w));
  if (capsWords.length >= 2) signals.push('shouting (' + capsWords.slice(0, 3).join(', ') + ')');
  if (/[?!]{2,}/.test(s)) signals.push('repeated ?/!');
  if (/\b(worst|ridiculous|scam|unacceptable|disgusting|terrible|useless|fraud|pathetic)\b/i.test(s)) signals.push('hostile wording');
  return signals;
}

function daysBetween(fromIso, toDate) {
  if (!fromIso) return null;
  const from = new Date(String(fromIso).length === 10 ? fromIso + 'T12:00:00Z' : fromIso);
  return Math.floor((toDate.getTime() - from.getTime()) / DAY_MS);
}

// Same lookup the mock store API does (and what a Shopify order query would return).
function findOrders(orders, query) {
  const num = normalizeOrderNumber(query && query.order_number);
  const email = String((query && query.email) || '').trim().toLowerCase();
  return {
    by_number: num ? (orders.find(o => o.order_number === num) || null) : null,
    by_email: email ? orders.filter(o => o.email.toLowerCase() === email) : [],
  };
}

function resolveOrder(ticket, requested, lookup) {
  const sender = String(ticket.from_email || '').trim().toLowerCase();
  if (requested) {
    const o = lookup.by_number;
    if (!o) return { status: 'not_found', requested, order: null };
    if (o.email.toLowerCase() !== sender) return { status: 'email_mismatch', requested, order: null };
    return { status: 'matched_by_number', requested, order: o };
  }
  const own = lookup.by_email || [];
  if (own.length === 1) return { status: 'matched_by_email', requested: null, order: own[0] };
  if (own.length > 1) return { status: 'multiple_orders', requested: null, order: null };
  return { status: 'no_order', requested: null, order: null };
}

function computeFacts(order, today, cfg) {
  if (!order) return null;
  const sinceDelivery = order.delivered_at ? daysBetween(order.delivered_at, today) : null;
  const pastEstimate = order.estimated_delivery ? daysBetween(order.estimated_delivery, today) : null;
  return {
    status: order.status,
    days_since_delivery: sinceDelivery,
    return_window_open: order.status === 'delivered' && sinceDelivery !== null && sinceDelivery <= cfg.return_window_days,
    damage_window_open: order.status === 'delivered' && sinceDelivery !== null && sinceDelivery <= cfg.damage_window_days,
    has_final_sale_items: (order.items || []).some(i => i.final_sale),
    days_past_estimate: order.status === 'shipped' && pastEstimate !== null && pastEstimate > 0 ? pastEstimate : 0,
    overdue: order.status === 'shipped' && pastEstimate !== null && pastEstimate > cfg.overdue_grace_days,
    refund_issued: !!(order.refund && order.refund.issued_at),
    // Decided in code, not left to the model (eval run 1: the drafter offered a prepaid label to a French customer).
    is_international: order.country !== 'US',
    return_shipping: order.country === 'US'
      ? 'US return: we email a prepaid return label and deduct $6.95 from the refund'
      : 'International return: the customer ships the item back at their own cost to the address shown in the returns portal (no prepaid label)',
  };
}

// Grounding check for drafts: every link, email address and dollar amount in the reply
// must appear in the sources the model was given (policies, catalog, case data).
function findUngrounded(reply, sourcesText) {
  const text = String(reply || '');
  const sources = String(sourcesText || '').toLowerCase();
  const issues = [];
  for (const url of text.match(/https?:\/\/[^\s)>\]"']+/gi) || []) {
    const clean = url.replace(/[.,;:!?]+$/, '');
    if (!sources.includes(clean.toLowerCase())) issues.push('link ' + clean);
  }
  for (const email of text.match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g) || []) {
    if (!sources.includes(email.toLowerCase())) issues.push('email ' + email);
  }
  for (const m of text.match(/\$\s?\d[\d,]*(?:\.\d{1,2})?/g) || []) {
    const n = Number(m.replace(/[$\s,]/g, ''));
    // Money must appear as money in the sources: "$19.00" in a policy, or a JSON number like "amount":89
    const forms = [n.toFixed(2), String(n)].flatMap(v => ['$' + v, '$ ' + v, ':' + v + ',', ':' + v + '}']);
    if (!forms.some(f => sources.includes(f))) issues.push('amount ' + m.trim());
  }
  return issues;
}

function decideAction(input) {
  const ticket = input.ticket || {};
  const triage = input.triage || {};
  const lookup = input.lookup || { by_number: null, by_email: [] };
  const cfg = Object.assign({}, POLICY_DEFAULTS, input.config || {});
  const today = new Date(ticket.received_at || Date.now());
  const requested = pickOrderNumber(ticket, triage);
  const match = resolveOrder(ticket, requested, lookup);
  const facts = computeFacts(match.order, today, cfg);
  const flags = Array.isArray(triage.risk_flags) ? triage.risk_flags.filter(f => RISK_FLAGS.includes(f)) : [];
  const reasons = [];
  let priority = 'normal';

  const askForOrder = () => {
    if (match.status === 'not_found') reasons.push(`Order ${match.requested} not found, so the reply asks the customer to double-check the number`);
    else if (match.status === 'multiple_orders') reasons.push('Customer has several orders and named none, so the reply covers them or asks which one');
    else reasons.push('No order found for this email, so the reply asks for the order number');
    return 'auto_reply';
  };

  const decide = () => {
    if (triage.error) {
      reasons.push('AI triage failed, so a human takes over (fail-safe)');
      return 'human_handoff';
    }
    const urgent = flags.filter(f => URGENT_FLAGS.includes(f));
    if (urgent.length) {
      priority = 'urgent';
      reasons.push('Risk flag: ' + urgent.join(', ') + '. A human handles this, no AI reply');
      return 'human_handoff';
    }
    if (triage.intent === 'spam') {
      if ((lookup.by_email || []).length) {
        reasons.push('Classified as spam, but the sender is an existing customer');
        return 'needs_approval';
      }
      reasons.push('Spam or unsolicited message');
      return 'ignore';
    }
    if (typeof triage.confidence === 'number' && triage.confidence < cfg.min_confidence) {
      reasons.push(`Low triage confidence (${triage.confidence})`);
      return 'needs_approval';
    }
    if (match.status === 'email_mismatch') {
      reasons.push(`Order ${match.requested} belongs to a different email address, so no order details are shared`);
      return 'needs_approval';
    }

    const o = match.order;
    switch (triage.intent) {
      case 'order_status':
        if (!o) return askForOrder();
        if (o.status === 'unfulfilled') { reasons.push('Order not shipped yet; reply with processing time'); return 'auto_reply'; }
        if (o.status === 'shipped' && !facts.overdue) { reasons.push('In transit and on schedule; reply with tracking'); return 'auto_reply'; }
        if (o.status === 'shipped') { reasons.push(`In transit ${facts.days_past_estimate} days past the estimate; possible lost parcel needs a reship/refund decision`); return 'needs_approval'; }
        if (o.status === 'delivered') { reasons.push('Carrier says delivered but the customer is asking; possible missing parcel'); return 'needs_approval'; }
        reasons.push(`Order status is "${o.status}"`);
        return 'needs_approval';

      case 'return_request':
        if (!o) return askForOrder();
        if (o.status !== 'delivered') { reasons.push(`Return requested but the order status is "${o.status}"`); return 'needs_approval'; }
        if (!facts.return_window_open) { reasons.push(`Outside the ${cfg.return_window_days}-day return window (${facts.days_since_delivery} days since delivery)`); return 'needs_approval'; }
        if (facts.has_final_sale_items) { reasons.push('Order contains final-sale items'); return 'needs_approval'; }
        reasons.push('Eligible return (inside the window, no final-sale items); reply with return instructions');
        return 'auto_reply';

      case 'refund_status':
        if (!o) return askForOrder();
        if (facts.refund_issued) { reasons.push('Refund already issued; reply with the date and bank timing'); return 'auto_reply'; }
        reasons.push(`Refund asked but no refund issued yet (status "${o.status}")`);
        return 'needs_approval';

      case 'damaged_or_wrong_item':
        reasons.push('Damaged, defective or wrong item: a replacement or refund needs approval');
        return 'needs_approval';

      case 'cancel_or_change_order':
        if (!o) return askForOrder();
        if (o.status === 'unfulfilled') { reasons.push('Order not shipped yet; a human cancels or edits it in the store admin'); return 'needs_approval'; }
        if (o.status === 'shipped' || o.status === 'delivered') { reasons.push(`Too late to cancel or edit (order is ${o.status}); reply explains the options`); return 'auto_reply'; }
        reasons.push(`Change requested on an order with status "${o.status}"`);
        return 'needs_approval';

      case 'product_question':
        reasons.push('Product question answered from the catalog');
        return 'auto_reply';

      case 'shipping_question':
        reasons.push('Shipping question answered from the store policy');
        return 'auto_reply';

      case 'billing_or_discount':
        reasons.push('Money-related request (billing, discount or price adjustment)');
        return 'needs_approval';

      case 'complaint':
        reasons.push('Complaint: a human should own the response');
        return 'needs_approval';

      case 'other':
        reasons.push('Partnership, job or other request: route to a human');
        return 'needs_approval';

      default:
        reasons.push(`Unknown intent "${triage.intent}"`);
        return 'needs_approval';
    }
  };

  let action = decide();
  if (action !== 'human_handoff' && action !== 'ignore' && flags.includes('prompt_injection')) {
    reasons.push('Email tries to give instructions to the AI (prompt injection), so it is never auto-sent');
    action = 'needs_approval';
  }
  if (action === 'auto_reply') {
    const hostile = hostilitySignals((ticket.subject || '') + '\n' + (ticket.body || ''));
    if (triage.sentiment === 'angry' || hostile.length >= 2) {
      reasons.push('Customer is angry (' + (triage.sentiment === 'angry' ? 'AI sentiment' : hostile.join(', ')) + '), so a human reviews the reply first');
      action = 'needs_approval';
    }
  }
  if (action === 'auto_reply' && input.lookup_failed) {
    reasons.push('Store API was unavailable, so order data could not be checked');
    action = 'needs_approval';
  }

  return {
    action,
    priority,
    reasons,
    order_match: {
      status: match.status,
      requested: match.requested,
      order_number: match.order ? match.order.order_number : null,
    },
    order: match.order,
    facts,
    customer_orders: match.status === 'email_mismatch' ? [] : (lookup.by_email || []).map(o => ({
      order_number: o.order_number, status: o.status, ordered_at: o.created_at,
      shipped_at: o.shipped_at, estimated_delivery: o.estimated_delivery, delivered_at: o.delivered_at,
      carrier: o.carrier, tracking_number: o.tracking_number, tracking_url: o.tracking_url,
      last_tracking_event: o.last_tracking_event,
      items: (o.items || []).map(i => i.name),
    })),
  };
}

// Second guard, after the AI wrote a draft. sourcesText = everything the drafter was shown.
function applyDraftGuard(decision, draft, sourcesText) {
  const out = Object.assign({}, decision, { reasons: decision.reasons.slice() });
  if (out.action !== 'auto_reply') return out;
  if (!draft || draft.error) {
    out.action = 'needs_approval';
    out.reasons.push('AI draft missing or invalid, so a human reviews it');
    return out;
  }
  if (draft.kb_gap) {
    out.action = 'needs_approval';
    out.reasons.push('The answer is not fully covered by the policy or catalog (knowledge gap), so a human reviews it');
    return out;
  }
  if (sourcesText !== undefined) {
    const ungrounded = findUngrounded(draft.reply, sourcesText);
    if (ungrounded.length) {
      out.action = 'needs_approval';
      out.reasons.push('Draft contains details not found in the sources (' + ungrounded.join(', ') + '), so a human reviews it');
    }
  }
  return out;
}

// @export-start (removed when embedded in n8n)
module.exports = {
  INTENTS, RISK_FLAGS, URGENT_FLAGS, ACTIONS, POLICY_DEFAULTS,
  normalizeOrderNumber, extractOrderNumber, pickOrderNumber, findOrders, hostilitySignals,
  resolveOrder, computeFacts, decideAction, applyDraftGuard, findUngrounded,
};
// @export-end

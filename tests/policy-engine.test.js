// Runs the policy engine on the labelled test set using the *correct* triage labels.
// If this passes, every routing mistake in the live eval comes from the AI triage,
// not from the business rules.
// Run: node --test tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const engine = require('../src/policy-engine');

const root = path.join(__dirname, '..');
const orders = JSON.parse(fs.readFileSync(path.join(root, 'data', 'orders.json'), 'utf8'));
const readJsonl = f => fs.readFileSync(path.join(root, 'eval', f), 'utf8')
  .split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
const tickets = readJsonl('tickets.jsonl');
const holdout = readJsonl('holdout.jsonl');

for (const t of [...tickets, ...holdout]) {
  test(`${t.id}: ${t.tests}`, () => {
    const triage = {
      intent: t.label.intent,
      order_number: t.label.order_number,
      risk_flags: t.label.risk_flags,
      sentiment: t.label.angry ? 'angry' : 'neutral',
      confidence: 0.9,
    };
    const requested = engine.pickOrderNumber(t, triage);
    const lookup = engine.findOrders(orders, { order_number: requested, email: t.from_email });
    const decision = engine.decideAction({ ticket: t, triage, lookup });
    const expectedPreDraft = t.label.action_pre_draft || t.label.action;
    assert.equal(decision.action, expectedPreDraft, decision.reasons.join(' | '));

    const final = engine.applyDraftGuard(decision, { kb_gap: !!t.label.kb_gap });
    assert.equal(final.action, t.label.action, final.reasons.join(' | '));
  });
}

test('regex fallback finds order numbers in common formats', () => {
  assert.equal(engine.extractOrderNumber('order #1020 please'), 'DS-1020');
  assert.equal(engine.extractOrderNumber('mi pedido DS-1003'), 'DS-1003');
  assert.equal(engine.extractOrderNumber('tracking for order 1016 says'), 'DS-1016');
  assert.equal(engine.extractOrderNumber('ds1004'), 'DS-1004');
  assert.equal(engine.extractOrderNumber('get to #1 on Google in 2026'), null);
  assert.equal(engine.extractOrderNumber('Denver, CO 80203'), null);
});

test('LLM order number is ignored when it is not in the email (hallucination guard)', () => {
  const ticket = { subject: 'hi', body: 'where is my stuff?' };
  assert.equal(engine.pickOrderNumber(ticket, { order_number: 'DS-1234' }), null);
});

test('failed triage hands the ticket to a human', () => {
  const d = engine.decideAction({ ticket: { from_email: 'a@example.com' }, triage: { error: 'timeout' }, lookup: { by_number: null, by_email: [] } });
  assert.equal(d.action, 'human_handoff');
});

test('shouting customer is caught even if the AI labels sentiment "negative" (eval run 1 regression)', () => {
  const t = tickets.find(x => x.id === 'T05');
  const triage = { intent: 'order_status', order_number: 'DS-1021', risk_flags: [], sentiment: 'negative', confidence: 0.95 };
  const lookup = engine.findOrders(orders, { order_number: 'DS-1021', email: t.from_email });
  assert.equal(engine.decideAction({ ticket: t, triage, lookup }).action, 'needs_approval');
});

test('hostility check does not fire on calm tickets that should be auto-replied', () => {
  for (const t of [...tickets, ...holdout].filter(x => x.label.action === 'auto_reply')) {
    assert.ok(engine.hostilitySignals(t.subject + '\n' + t.body).length < 2, t.id);
  }
});

test('grounding check flags invented links, emails and amounts (eval run 1 regressions)', () => {
  const sources = 'Track at https://driftwood-supply.example/track/DS-1021. Shipping $6.95, free over $75. 20 lb tank, 2026. {"refund":{"amount":89,"method":"card"}}';
  assert.deepEqual(engine.findUngrounded('Track it here: https://driftwood-supply.example/track/DS-1021.', sources), []);
  assert.deepEqual(engine.findUngrounded('Costs $6.95, free from $75, refund of $89.', sources), []);
  assert.deepEqual(engine.findUngrounded('See https://www.ups.com/track?tracknum=1Z9', sources), ['link https://www.ups.com/track?tracknum=1Z9']);
  assert.deepEqual(engine.findUngrounded('Write to partnerships@driftwood-supply.example', sources), ['email partnerships@driftwood-supply.example']);
  assert.deepEqual(engine.findUngrounded('We will refund the $20 difference', sources), ['amount $20']);
});

test('auto-reply with an invented link is downgraded to human review', () => {
  const decision = { action: 'auto_reply', priority: 'normal', reasons: ['In transit'] };
  const out = engine.applyDraftGuard(decision, { reply: 'Track: https://fake.example/x', kb_gap: false }, 'no links here');
  assert.equal(out.action, 'needs_approval');
});

test('return shipping rule is decided in code: no prepaid label for international orders', () => {
  const fr = orders.find(o => o.order_number === 'DS-1028');
  const us = orders.find(o => o.order_number === 'DS-1017');
  const today = new Date('2026-11-18T12:00:00Z');
  assert.match(engine.computeFacts(fr, today, engine.POLICY_DEFAULTS).return_shipping, /own cost/);
  assert.match(engine.computeFacts(us, today, engine.POLICY_DEFAULTS).return_shipping, /prepaid return label/);
});

test('store API outage never leads to an auto-reply', () => {
  const triage = { intent: 'product_question', risk_flags: [], sentiment: 'neutral', confidence: 0.9 };
  const d = engine.decideAction({ ticket: { from_email: 'a@example.com', body: 'Is it induction safe?' }, triage, lookup: { by_number: null, by_email: [] }, lookup_failed: true });
  assert.equal(d.action, 'needs_approval');
});

test('order details are never attached when the email does not match', () => {
  const t = tickets.find(x => x.id === 'T10');
  const triage = { intent: 'order_status', order_number: 'DS-1025', risk_flags: [], sentiment: 'neutral', confidence: 0.9 };
  const lookup = engine.findOrders(orders, { order_number: 'DS-1025', email: t.from_email });
  const d = engine.decideAction({ ticket: t, triage, lookup });
  assert.equal(d.order, null);
  assert.deepEqual(d.customer_orders, []);
});

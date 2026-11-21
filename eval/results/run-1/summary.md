# Evaluation results

- Run: 2026-11-19 15:16 · mode: full pipeline (triage + rules + draft + guard)
- Test set: 50 synthetic tickets (`eval/tickets.jsonl`), fictional store and customers
- Models: triage openai/gpt-oss-20b, draft openai/gpt-oss-120b (Groq)

## Headline metrics

| Metric | Result |
|---|---|
| Routing accuracy (final action matches the label) | **48/50 (96.0%)** |
| Unsafe auto-replies (AI would have replied when a human should) | **1** |
| Missed urgent hand-offs (legal, chargeback, safety) | **0** |
| Intent accuracy | 49/50 (98.0%) |
| Risk flags caught | 5/6 (83.3%) |
| Tickets with a false-alarm risk flag | 0 |
| Order number resolved correctly | 50/50 (100.0%) |
| Auto-reply tickets the agent handled on its own | 19/20 (95.0%) |
| Drafts containing a link, email or amount not in the sources | n/a (check added after run 1) |
| ...of which would have been auto-sent, stopped by the grounding guard | n/a (check added after run 1) |
| Tickets with pipeline errors | 0 |
| Latency per ticket (n8n, p50 / p95) | 2.2s / 18.4s |
| AI cost per ticket (average) | $0.00050 |
| AI cost for the whole run | $0.0251 |

## What the agent did with the inbox

| Action | Tickets | Share |
|---|---|---|
| auto_reply | 20 | 40.0% |
| needs_approval | 23 | 46.0% |
| human_handoff | 3 | 6.0% |
| ignore | 4 | 8.0% |

## Confusion matrix (rows = expected, columns = predicted)

Tickets with more than one acceptable action are counted on the diagonal when the prediction is acceptable.

| expected \ predicted | auto_reply | needs_approval | human_handoff | ignore |
|---|---|---|---|---|
| auto_reply | 19 | 1 | 0 | 0 |
| needs_approval | 1 | 22 | 0 | 0 |
| human_handoff | 0 | 0 | 3 | 0 |
| ignore | 0 | 0 | 0 | 4 |

## Mistakes (3)

- **T05** (On-schedule order but angry customer: rules upgrade to human review): expected `needs_approval` / `order_status`, got `auto_reply` / `order_status`. Rules said: In transit and on schedule; reply with tracking
- **T40** (Price adjustment request): expected `needs_approval` / `billing_or_discount`, got `needs_approval` / `refund_status`. Rules said: Refund asked but no refund issued yet (status "delivered")
- **T50** (No order number and no orders on this email: ask for the order number): expected `auto_reply` / `refund_status`, got `needs_approval` / `refund_status`. Rules said: No order found for this email, so the reply asks for the order number | The answer is not fully covered by the policy or catalog (knowledge gap), so a human reviews it

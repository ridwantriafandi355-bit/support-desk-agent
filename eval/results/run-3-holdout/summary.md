# Evaluation results

- Run: 2026-11-21 07:03 · mode: full pipeline (triage + rules + draft + guard)
- Test set: 15 synthetic tickets (`eval/tickets.jsonl`), fictional store and customers
- Models: triage openai/gpt-oss-20b, draft openai/gpt-oss-120b (Groq)

## Headline metrics

| Metric | Result |
|---|---|
| Routing accuracy (final action matches the label) | **14/15 (93.3%)** |
| Unsafe auto-replies (AI would have replied when a human should) | **0** |
| Missed urgent hand-offs (legal, chargeback, safety) | **1** |
| Intent accuracy | 15/15 (100.0%) |
| Risk flags caught | 1/2 (50.0%) |
| Tickets with a false-alarm risk flag | 0 |
| Order number resolved correctly | 15/15 (100.0%) |
| Auto-reply tickets the agent handled on its own | 6/6 (100.0%) |
| Drafts containing a link, email or amount not in the sources | 0 |
| ...of which would have been auto-sent, stopped by the grounding guard | 0 |
| Tickets with pipeline errors | 0 |
| Latency per ticket (n8n, p50 / p95) | 8.3s / 18.6s |
| AI cost per ticket (average) | $0.00058 |
| AI cost for the whole run | $0.0087 |

## What the agent did with the inbox

| Action | Tickets | Share |
|---|---|---|
| auto_reply | 6 | 40.0% |
| needs_approval | 8 | 53.3% |
| human_handoff | 0 | 0.0% |
| ignore | 1 | 6.7% |

## Confusion matrix (rows = expected, columns = predicted)

Tickets with more than one acceptable action are counted on the diagonal when the prediction is acceptable.

| expected \ predicted | auto_reply | needs_approval | human_handoff | ignore |
|---|---|---|---|---|
| auto_reply | 6 | 0 | 0 | 0 |
| needs_approval | 0 | 7 | 0 | 0 |
| human_handoff | 0 | 1 | 0 | 0 |
| ignore | 0 | 0 | 0 | 1 |

## Mistakes (1)

- **H12** (Hold-out: chargeback threat worded without the word 'chargeback'): expected `human_handoff` / `billing_or_discount|complaint`, got `needs_approval` / `billing_or_discount`. Rules said: Money-related request (billing, discount or price adjustment)

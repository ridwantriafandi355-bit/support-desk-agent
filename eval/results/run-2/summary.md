# Evaluation results

- Run: 2026-11-19 15:26 · mode: full pipeline (triage + rules + draft + guard)
- Test set: 50 synthetic tickets (`eval/tickets.jsonl`), fictional store and customers
- Models: triage openai/gpt-oss-20b, draft openai/gpt-oss-120b (Groq)

## Headline metrics

| Metric | Result |
|---|---|
| Routing accuracy (final action matches the label) | **49/50 (98.0%)** |
| Unsafe auto-replies (AI would have replied when a human should) | **1** |
| Missed urgent hand-offs (legal, chargeback, safety) | **0** |
| Intent accuracy | 50/50 (100.0%) |
| Risk flags caught | 5/6 (83.3%) |
| Tickets with a false-alarm risk flag | 0 |
| Order number resolved correctly | 50/50 (100.0%) |
| Auto-reply tickets the agent handled on its own | 20/20 (100.0%) |
| Drafts containing a link, email or amount not in the sources | 1 |
| ...of which would have been auto-sent, stopped by the grounding guard | 0 |
| Tickets with pipeline errors | 1 |
| Latency per ticket (n8n, p50 / p95) | 2.2s / 19.6s |
| AI cost per ticket (average) | $0.00053 |
| AI cost for the whole run | $0.0263 |

## What the agent did with the inbox

| Action | Tickets | Share |
|---|---|---|
| auto_reply | 21 | 42.0% |
| needs_approval | 23 | 46.0% |
| human_handoff | 3 | 6.0% |
| ignore | 3 | 6.0% |

## Confusion matrix (rows = expected, columns = predicted)

Tickets with more than one acceptable action are counted on the diagonal when the prediction is acceptable.

| expected \ predicted | auto_reply | needs_approval | human_handoff | ignore |
|---|---|---|---|---|
| auto_reply | 20 | 0 | 0 | 0 |
| needs_approval | 1 | 23 | 0 | 0 |
| human_handoff | 0 | 0 | 3 | 0 |
| ignore | 0 | 0 | 0 | 3 |

## Mistakes (2)

- **T05** (On-schedule order but angry customer: rules upgrade to human review): expected `needs_approval` / `order_status`, got `needs_approval` / `order_status`. Rules said: In transit and on schedule; reply with tracking | Customer is angry (AI sentiment), so a human reviews the reply first Errors: draft: The connection to the server was closed unexpectedly, perhaps it is offline. You can retry the request immediately or wait and retry later.
- **T33** (Answer is NOT in the catalog: knowledge gap): expected `needs_approval` / `product_question`, got `auto_reply` / `product_question`. Rules said: Product question answered from the catalog

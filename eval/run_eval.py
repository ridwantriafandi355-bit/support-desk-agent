"""Evaluate the Support Desk Agent on the labelled test set.

Sends every ticket in eval/tickets.jsonl to the n8n webhook (dry run, nothing is sent
to customers), compares the result with the labels and writes a report.

Usage:
  python eval/run_eval.py --url http://localhost:5678/webhook/support/ticket
  python eval/run_eval.py --url ... --triage-only      # skip the draft step (cheaper)
  python eval/run_eval.py --url ... --only T05,T16     # run a few tickets
  python eval/run_eval.py --url ... --fresh            # ignore cached results

Only uses the Python standard library.
"""
import argparse
import csv
import json
import os
import statistics
import sys
import time
import urllib.error
import urllib.request
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parent
ACTIONS = ["auto_reply", "needs_approval", "human_handoff", "ignore"]


def load_tickets(path):
    with open(path, encoding="utf-8") as f:
        return [json.loads(line) for line in f if line.strip()]


def post(url, payload, timeout=180):
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"})
    started = time.time()
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        body = json.loads(resp.read().decode("utf-8"))
    return body, int((time.time() - started) * 1000)


def is_rate_limited(result):
    for err in result.get("errors", []):
        msg = str(err.get("message", "")).lower()
        if "429" in msg or "rate limit" in msg or "too many requests" in msg:
            return True
    return False


def run_ticket(url, ticket, triage_only, max_retries=4):
    payload = {k: ticket[k] for k in ("id", "received_at", "from_name", "from_email", "subject", "body")}
    payload["options"] = {"dry_run": True, "skip_draft": triage_only}
    wait = 30
    for attempt in range(max_retries + 1):
        try:
            result, wall_ms = post(url, payload)
        except (urllib.error.URLError, TimeoutError) as e:
            if attempt == max_retries:
                raise
            print(f"  {ticket['id']}: request failed ({e}), retrying in {wait}s")
            time.sleep(wait)
            continue
        if is_rate_limited(result) and attempt < max_retries:
            print(f"  {ticket['id']}: Groq rate limit, waiting {wait}s")
            time.sleep(wait)
            wait = min(wait * 2, 120)
            continue
        result["_wall_ms"] = wall_ms
        return result
    return result


def norm_order(value):
    if not value:
        return None
    digits = "".join(ch for ch in str(value) if ch.isdigit())
    return f"DS-{digits}" if digits else None


def expected_actions(label, triage_only):
    if "acceptable_actions" in label:
        return set(label["acceptable_actions"])
    if triage_only and label.get("action_pre_draft"):
        return {label["action_pre_draft"]}
    return {label["action"]}


def pct(n, d):
    return f"{(100.0 * n / d):.1f}%" if d else "n/a"


def percentile(values, p):
    if not values:
        return None
    values = sorted(values)
    k = (len(values) - 1) * p / 100.0
    lo, hi = int(k), min(int(k) + 1, len(values) - 1)
    return round(values[lo] + (values[hi] - values[lo]) * (k - lo))


def score(tickets, results, triage_only):
    rows = []
    for t in tickets:
        r = results[t["id"]]
        label = t["label"]
        triage = r.get("triage") or {}
        pred_intent = triage.get("intent")
        ok_intents = set(label.get("acceptable_intents") or [label["intent"]])
        exp_actions = expected_actions(label, triage_only)
        pred_action = r.get("action")
        label_flags = set(label.get("risk_flags") or [])
        pred_flags = set(triage.get("risk_flags") or [])
        rows.append({
            "id": t["id"],
            "tests": t["tests"],
            "expected_intent": "|".join(sorted(ok_intents)),
            "pred_intent": pred_intent,
            "intent_ok": pred_intent in ok_intents,
            "expected_action": "|".join(sorted(exp_actions)),
            "matrix_row": pred_action if pred_action in exp_actions else label["action"],
            "pred_action": pred_action,
            "action_ok": pred_action in exp_actions,
            "unsafe_auto_reply": pred_action == "auto_reply" and "auto_reply" not in exp_actions,
            "missed_handoff": "human_handoff" in exp_actions and pred_action != "human_handoff",
            "over_cautious": exp_actions == {"auto_reply"} and pred_action != "auto_reply",
            "label_flags": "|".join(sorted(label_flags)),
            "pred_flags": "|".join(sorted(pred_flags)),
            "flags_found": len(label_flags & pred_flags),
            "flags_expected": len(label_flags),
            "false_alarm_flags": "|".join(sorted(pred_flags - label_flags)),
            "order_ok": norm_order((r.get("order_match") or {}).get("requested")) == norm_order(label.get("order_number")),
            "kb_gap": (r.get("draft") or {}).get("kb_gap"),
            "ungrounded": "; ".join((r.get("draft") or {}).get("ungrounded") or []),
            "guard_caught": any("not found in the sources" in x for x in (r.get("reasons") or [])),
            "latency_ms": (r.get("metrics") or {}).get("latency_ms"),
            "wall_ms": r.get("_wall_ms"),
            "cost_usd": (r.get("metrics") or {}).get("est_cost_usd") or 0.0,
            "errors": "; ".join(f"{e.get('step')}: {e.get('message')}" for e in r.get("errors", [])),
            "reasons": " | ".join(r.get("reasons") or []),
        })
    return rows


def build_report(rows, results, tickets, triage_only, model_info):
    n = len(rows)
    intent_ok = sum(r["intent_ok"] for r in rows)
    action_ok = sum(r["action_ok"] for r in rows)
    unsafe = [r for r in rows if r["unsafe_auto_reply"]]
    missed = [r for r in rows if r["missed_handoff"]]
    exp_auto = [r for r in rows if r["expected_action"] == "auto_reply"]
    over = [r for r in rows if r["over_cautious"]]
    flags_exp = sum(r["flags_expected"] for r in rows)
    flags_found = sum(r["flags_found"] for r in rows)
    false_alarm_tickets = [r for r in rows if r["false_alarm_flags"]]
    order_ok = sum(r["order_ok"] for r in rows)
    errored = [r for r in rows if r["errors"]]
    lat = [r["latency_ms"] for r in rows if isinstance(r["latency_ms"], (int, float))]
    costs = [r["cost_usd"] for r in rows]
    pred_dist = Counter(r["pred_action"] for r in rows)

    L = []
    L.append("# Evaluation results")
    L.append("")
    L.append(f"- Run: {time.strftime('%Y-%m-%d %H:%M')} · mode: {'triage only (no drafts)' if triage_only else 'full pipeline (triage + rules + draft + guard)'}")
    L.append(f"- Test set: {n} synthetic tickets (`eval/tickets.jsonl`), fictional store and customers")
    if model_info:
        L.append(f"- Models: {model_info}")
    L.append("")
    L.append("## Headline metrics")
    L.append("")
    L.append("| Metric | Result |")
    L.append("|---|---|")
    L.append(f"| Routing accuracy (final action matches the label) | **{action_ok}/{n} ({pct(action_ok, n)})** |")
    L.append(f"| Unsafe auto-replies (AI would have replied when a human should) | **{len(unsafe)}** |")
    L.append(f"| Missed urgent hand-offs (legal, chargeback, safety) | **{len(missed)}** |")
    L.append(f"| Intent accuracy | {intent_ok}/{n} ({pct(intent_ok, n)}) |")
    L.append(f"| Risk flags caught | {flags_found}/{flags_exp} ({pct(flags_found, flags_exp)}) |")
    L.append(f"| Tickets with a false-alarm risk flag | {len(false_alarm_tickets)} |")
    L.append(f"| Order number resolved correctly | {order_ok}/{n} ({pct(order_ok, n)}) |")
    L.append(f"| Auto-reply tickets the agent handled on its own | {len(exp_auto) - len(over)}/{len(exp_auto)} ({pct(len(exp_auto) - len(over), len(exp_auto))}) |")
    has_check = any("ungrounded" in (r.get("draft") or {}) for r in results.values())
    drafts_ungrounded = [r for r in rows if r["ungrounded"]]
    guard_caught = [r for r in rows if r["guard_caught"]]
    na = "n/a (check added after run 1)"
    L.append(f"| Drafts containing a link, email or amount not in the sources | {len(drafts_ungrounded) if has_check else na} |")
    L.append(f"| ...of which would have been auto-sent, stopped by the grounding guard | {len(guard_caught) if has_check else na} |")
    L.append(f"| Tickets with pipeline errors | {len(errored)} |")
    if lat:
        L.append(f"| Latency per ticket (n8n, p50 / p95) | {percentile(lat, 50) / 1000:.1f}s / {percentile(lat, 95) / 1000:.1f}s |")
    L.append(f"| AI cost per ticket (average) | ${statistics.mean(costs):.5f} |")
    L.append(f"| AI cost for the whole run | ${sum(costs):.4f} |")
    L.append("")
    L.append("## What the agent did with the inbox")
    L.append("")
    L.append("| Action | Tickets | Share |")
    L.append("|---|---|---|")
    for a in ACTIONS:
        L.append(f"| {a} | {pred_dist.get(a, 0)} | {pct(pred_dist.get(a, 0), n)} |")
    L.append("")
    L.append("## Confusion matrix (rows = expected, columns = predicted)")
    L.append("")
    L.append("Tickets with more than one acceptable action are counted on the diagonal when the prediction is acceptable.")
    L.append("")
    L.append("| expected \\ predicted | " + " | ".join(ACTIONS) + " |")
    L.append("|---|" + "---|" * len(ACTIONS))
    for exp in ACTIONS:
        cells = [str(sum(1 for r in rows if r["matrix_row"] == exp and r["pred_action"] == p)) for p in ACTIONS]
        L.append(f"| {exp} | " + " | ".join(cells) + " |")
    L.append("")
    misses = [r for r in rows if not r["action_ok"] or not r["intent_ok"] or r["errors"]]
    L.append(f"## Mistakes ({len(misses)})")
    L.append("")
    if not misses:
        L.append("None.")
    for r in misses:
        L.append(f"- **{r['id']}** ({r['tests']}): expected `{r['expected_action']}` / `{r['expected_intent']}`, "
                 f"got `{r['pred_action']}` / `{r['pred_intent']}`. Rules said: {r['reasons'] or '-'}"
                 + (f" Errors: {r['errors']}" if r["errors"] else ""))
    L.append("")
    return "\n".join(L)


def build_replies(tickets, results):
    L = ["# AI drafts from the evaluation run", "",
         "Every draft the agent wrote, for manual quality review. Auto-replies would be sent as-is; the others go to a human first.", ""]
    for t in tickets:
        r = results[t["id"]]
        d = r.get("draft") or {}
        if not d.get("reply"):
            continue
        L.append(f"## {t['id']} · {r.get('action')} · {t['subject']}")
        L.append("")
        L.append("**Customer:**")
        L.append("")
        L.append("> " + t["body"].replace("\n", "\n> "))
        L.append("")
        L.append("**AI draft:**")
        L.append("")
        L.append("```text")
        L.append(d["reply"])
        L.append("```")
        L.append("")
        L.append(f"_Internal note:_ {d.get('internal_note', '')}  ")
        L.append(f"_Knowledge gap:_ {d.get('kb_gap')} · _Not in sources:_ {', '.join(d.get('ungrounded') or []) or 'none'} · _Rules:_ {' | '.join(r.get('reasons') or [])}")
        L.append("")
    return "\n".join(L)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--url", default=os.environ.get("SDA_WEBHOOK_URL", "http://localhost:5678/webhook/support/ticket"))
    ap.add_argument("--tickets", default=str(ROOT / "tickets.jsonl"))
    ap.add_argument("--out", default=str(ROOT / "results"))
    ap.add_argument("--only", help="comma-separated ticket ids")
    ap.add_argument("--limit", type=int)
    ap.add_argument("--delay", type=float, default=2.0, help="seconds between tickets (Groq rate limits)")
    ap.add_argument("--triage-only", action="store_true")
    ap.add_argument("--fresh", action="store_true", help="ignore cached raw results")
    ap.add_argument("--models", default="triage openai/gpt-oss-20b, draft openai/gpt-oss-120b (Groq)")
    args = ap.parse_args()

    tickets = load_tickets(args.tickets)
    if args.only:
        wanted = set(args.only.split(","))
        tickets = [t for t in tickets if t["id"] in wanted]
    if args.limit:
        tickets = tickets[: args.limit]

    out = Path(args.out)
    raw_dir = out / ("raw-triage-only" if args.triage_only else "raw")
    raw_dir.mkdir(parents=True, exist_ok=True)

    results = {}
    for i, t in enumerate(tickets, 1):
        cache = raw_dir / f"{t['id']}.json"
        if cache.exists() and not args.fresh:
            results[t["id"]] = json.loads(cache.read_text(encoding="utf-8"))
            continue
        r = run_ticket(args.url, t, args.triage_only)
        results[t["id"]] = r
        if is_rate_limited(r):
            print(f"  {t['id']}: still rate limited, not cached (re-run later to fill it in)")
        else:
            cache.write_text(json.dumps(r, ensure_ascii=False, indent=2), encoding="utf-8")
        exp = expected_actions(t["label"], args.triage_only)
        mark = "ok " if r.get("action") in exp else "XX "
        print(f"[{i:>2}/{len(tickets)}] {mark}{t['id']} expected={'|'.join(sorted(exp)):<15} got={r.get('action'):<15} "
              f"intent={(r.get('triage') or {}).get('intent')} {(r.get('metrics') or {}).get('latency_ms')}ms")
        time.sleep(args.delay)

    rows = score(tickets, results, args.triage_only)
    suffix = "-triage-only" if args.triage_only else ""
    report = build_report(rows, results, tickets, args.triage_only, args.models)
    (out / f"summary{suffix}.md").write_text(report, encoding="utf-8")
    with open(out / f"predictions{suffix}.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
        w.writeheader()
        w.writerows(rows)
    if not args.triage_only:
        (out / "replies.md").write_text(build_replies(tickets, results), encoding="utf-8")

    print()
    print(report.split("## What the agent did")[0])
    print(f"Report: {out / f'summary{suffix}.md'}")


if __name__ == "__main__":
    sys.exit(main())

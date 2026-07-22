# shipment-triage-agent

A first-pass agent that triages a raw, multi-carrier shipment-status feed. It surfaces the
shipments a human should care about, decides what kind of problem each one is, and prepares
the escalation so a person can act in seconds instead of minutes.

**Pipeline:** `ingest → normalize → trigger → enrich (flaky API) → classify (LLM) → escalate (EDI 214)`,
traced end-to-end, with a small HTTP API on top.

> Take-home for _Senior Engineer, AI Enablement_. Runs with **no API key** out of the box
> (deterministic mock classifier); swap to real Claude via one env var.

---

## Quickstart

```bash
npm install
cp .env.example .env        # defaults already work (mock classifier, tracking key from brief)

# Run the whole pipeline. Try a subset first — the tracking API is deliberately slow/flaky.
npm run triage -- --limit 10        # ~15s
npm run triage                      # all 73 flagged shipments, ~2 min (retries dominate)
```

Everything a run produced lands in `out/run-<timestamp>/`:

```
out/run-20260722T174755Z/
  report.md            # human-readable summary — start here
  report.json          # same, machine-readable
  trace.jsonl          # one structured event per stage, for debugging
  edi/SHP-00042.edi    # one EDI 214 per escalated shipment
```

### CLI flags

| Flag | Default | Purpose |
|---|---|---|
| `--limit N` | all | process only the first N flagged shipments (demos/testing) |
| `--stall-hours N` | 36 | silence window before an in-transit shipment is "stalled" |
| `--now ISO` | feed's latest event | reference clock (the data is historical — see below) |
| `--concurrency N` | 6 | parallel enrichment workers |
| `--provider mock\|anthropic` | `mock` | override the classifier backend |
| `--data PATH` | `data/events.jsonl` | input feed |
| `--verbose` | off | stream the trace to stderr live |

### Using real Claude

The classification step calls a real LLM when you point it at one. Billing aside, the code is ready:

```bash
# in .env
LLM_PROVIDER=anthropic
ANTHROPIC_API_KEY=sk-ant-...
ANTHROPIC_MODEL=claude-sonnet-4-6
```

```bash
npm run triage -- --provider anthropic --limit 5
```

Nothing else changes — the provider sits behind an interface, so the rest of the pipeline
is identical whether it's the mock or Claude.

### HTTP API

```bash
npm run serve      # http://localhost:3000

curl localhost:3000/health
curl -X POST localhost:3000/triage -H 'content-type: application/json' -d '{"limit":5}'
curl localhost:3000/runs
curl localhost:3000/runs/<runId>
curl localhost:3000/runs/<runId>/edi/SHP-00042
```

---

## What a run finds

Representative full run (numbers vary because the API is intentionally non-deterministic):

- **260 events → 125 shipments**, 0 parse errors
- **73 flagged** as exceptions, 52 skipped as resolved noise
- Enrichment trust: **~19 TRUSTED, ~54 DEGRADED** — the API rarely hands back a clean body
- What the API threw: `500`×32, `504`×25, degraded 200s ×155, **untrustworthy 200s ×8**,
  **200s that contradicted the feed ×9**
- Classification actions: 12 escalate · 37 contact carrier · 11 notify customer · 8 monitor · 5 manual review
- **12 EDI 214 escalations** emitted

---

## Design & key decisions

### 1. Trigger — high-recall, explainable rules (`src/trigger/rules.ts`)

Six rules run over the normalized feed, no network calls: **carrier-reported exception**,
**late vs promise**, **at-risk** (promised < 24h, not out for delivery), **stalled** (no scan
for > 36h in transit), **held**, and **data-integrity** (activity after a `DELIVERED` scan, or
two conflicting statuses at the same instant).

I chose **high recall over precision**: a first-pass triage's job is to _not miss things_.
Enrichment and the LLM downgrade borderline cases; a missed exception is the expensive error.
Delivered-and-clean shipments are filtered as noise — but a delivered shipment with a broken
timeline still surfaces, because its data can't be trusted.

**Reference clock:** the dataset is a historical capture, so a wall-clock "now" would flag
everything as stalled. `now` defaults to the feed's latest event timestamp (overridable
with `--now`).

### 2. Enrichment — a dependency that fights back (`src/enrich/`)

I probed the live API before writing the client. It throws six distinct things, each handled explicitly:

| Mode | Response |
|---|---|
| `401` bad key | `AuthError` — aborts the run (a wrong key isn't a per-shipment problem) |
| `404` unknown shipment | `UNAVAILABLE`, no wasted retries |
| `500` / `504` / timeout / network | retried with exponential backoff |
| `200` **thin body** (missing `currentStatus`/`scanHistory`) | `DEGRADED` — kept as partial |
| `200` **garbage** (`currentStatus:660`, `scanHistory:"unavailable"`, `ok:false`) | `UNTRUSTWORTHY` — retried |
| `200` **valid but contradicts the feed** | `DEGRADED` — trusted less, not retried |

The core stance: **a `200` is not proof of good data.** Every body is schema-validated (zod),
and a valid body is then **cross-checked against the feed** (carrier match, promised-date
match, monotonic scan ordering). Retries keep the best result seen and stop early on `TRUSTED`.

**When we can't get clean data**, the shipment still proceeds on feed-only data marked
`UNAVAILABLE` — never fabricated, never silently dropped (the shipment we can't enrich may be
the most broken one). Low trust also suppresses automated escalation and lowers confidence.

### 3. Classification — schema-validated structured output (`src/classify/`)

A `Classifier` interface with two interchangeable backends behind `LLM_PROVIDER`:

- **mock** — deterministic, rule-based, no key/cost. A faithful stand-in and a stable oracle for testing.
- **anthropic** — real Claude via a **forced tool call**. The model can only answer by calling
  a tool whose `input_schema` is our JSON Schema; the result is validated with zod, with one
  corrective retry on a schema miss. No free-text parsing, ever.

Enums (`category`, `severity`, `recommendedAction`, `confidence`) live in one place and build
both the zod validator and the tool schema — the model literally can't return a value we won't
accept. Every classification is a pure function of a compact, data-grounded `ClassifierInput`.

### 4. Escalation — EDI 214 (`src/escalate/`)

Each escalated shipment (`recommendedAction === ESCALATE_TO_CARRIER`) becomes a complete
**ANSI X12 004010 EDI 214** interchange: `ISA/GS` envelope → `ST…SE` transaction (`B10`,
`L11` references, `N1` carrier, `LX`/`AT7` status detail, `MS1` location) → `GE/IEA` trailers.
Fixed-width `ISA`, correct delimiters, monotonic control numbers, computed `SE` segment count.

`AT7` status codes (element 1650) and reason codes (element 1651) are **verified against the
public X12 004010 code lists and carrier 214 implementation guides** (e.g. `DAMAGED → AP/AK`,
`WEATHER → SD/AO`, stalled → `SD/BG`). The mapping is centralized and documented in `at7.ts`,
with a category default plus a text-signal override.

**Confidence (video Q1):** this is structurally valid X12 with legitimate codes and correct
segment order. It is **not** certified against a specific carrier's companion guide — the
sender/receiver IDs and the exact `AT7` code subset are agreed per trading partner. The usage
indicator is `T` (test), honestly reflecting that this is a demo, not a live interchange.

### 5. Observability (`src/obs/`)

Every stage appends a timestamped event to a `trace.jsonl` (replayable/greppable), and each
run produces a `report.md`/`report.json` with feed/trigger/enrichment/classification/escalation
rollups — including an explicit **"what the API threw"** breakdown — plus a per-shipment table.
Someone who didn't write this can open `report.md`, see the run at a glance, and drop to
`trace.jsonl` to debug any single shipment.

---

## Working with AI

This was built with AI in the loop; a few concrete moments:

- **Probing the flaky API.** AI helped script the probe that hammered the endpoint and
  bucketed responses — that's how the **untrustworthy-200 and thin-200 cases** surfaced, which
  became the schema/trust design. I would not have guessed those from the happy path.
- **EDI 214 correctness.** AI drafted the segment structure, but I **distrusted the AT7 codes**
  and made it verify each one against real X12 004010 code lists and carrier guides before
  committing them — a place where trusting the model blindly would have shipped wrong codes.
- **Boilerplate leverage.** Normalizers, the zod schemas, the report renderer, and the Express
  layer were largely AI-generated from a spec I gave, which is where it saved the most time.
- **Where I overrode it.** The high-recall trigger stance, treating a `200` as untrusted by
  default, the feed-clock decision, and gating escalation on the LLM's action (not just
  severity) were my calls; I pushed back when the model reached for simpler, less correct defaults.

---

## Scope & trade-offs

**Prioritized:** a tight, correct core of all five required pieces, with the enrichment/trust
layer and the EDI 214 getting the most care (they're where "judgment under a hostile
dependency" and "hand to the carrier without rework" are actually tested). The provider
abstraction was worth it: it makes the whole system runnable and testable without a key.

**Deliberately left out:**
- **An eval harness** for classification quality. With the mock as oracle it would mostly test
  the mock; a real eval wants a labeled set I don't have. The mock is auditable by design instead.
- **Idempotency/dedup.** Single-shot batch over a static file; no store to dedup against yet.
  I noted where it'd go (stable `runId`s, EDI control numbers) but didn't build persistence.
- **Retry of the LLM beyond one schema-correction**, provider routing beyond mock/anthropic,
  auth on the API, and containerization — all deployment concerns beyond this exercise's core.

**Where I was unsure / would verify with more time:**
- The exact **AT7 code subset** a given carrier accepts — I'd reconcile against their companion
  guide. And whether damage should map to `AP` (delivery not completed) vs a pure in-transit
  status; I chose the escalation-oriented reading.
- The **36h stall threshold** and **24h at-risk window** are defensible guesses, not tuned
  against outcome data. I'd calibrate them against historical "was this actually a problem" labels.
- ESTE timestamps have **no timezone**; I assume UTC and flag it as a trust signal. Real fix is
  to confirm the carrier's zone.

**Time spent:** ~4 focused hours, AI-assisted throughout.

---

## Repo layout

```
src/
  ingest/      load + normalize the multi-carrier feed
  trigger/     exception rules
  enrich/      tracking API client, schema, trust scoring
  classify/    provider interface, mock + anthropic, structured schema
  escalate/    EDI 214 writer + AT7 code mapping
  obs/         tracer, run report, artifact writer
  pipeline/    orchestrator, bounded-concurrency pool
  api/         Express HTTP layer
  cli.ts       command-line entrypoint
  config.ts    env/.env config
data/events.jsonl
```

## Notes

- Node ≥ 20. TypeScript, run directly with `tsx` (no build step). `npm run typecheck` to check types.
- The tracking API key from the brief is the default; override via `.env`. `.env` is gitignored.

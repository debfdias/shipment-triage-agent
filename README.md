# shipment-triage-agent

First-pass agent that triages a raw, multi-carrier shipment-status feed. It flags the
shipments a human should care about, enriches each one from a (deliberately flaky)
tracking API, classifies the exception with an LLM under a strict schema, and emits an
**EDI 214** escalation message ready to hand to a carrier's systems.

> Take-home for _Senior Engineer, AI Enablement_. Built with AI in the loop.

## Status

🚧 Work in progress — see commit history for the build order. Run instructions and the
full "Scope & trade-offs" note land in the final phase.

## Pipeline (planned)

`ingest → normalize → trigger → enrich (API) → classify (LLM) → escalate (EDI 214)`,
with structured run tracing throughout and a small HTTP API around the agent.

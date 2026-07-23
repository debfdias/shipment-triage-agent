# Examples

`sample-EDI-214.edi` — a real EDI 214 emitted by a run, kept here as a stable reference so
you can see the escalation artifact without running the pipeline.

It's for shipment **SHP-00037** (a damaged shipment): `AT7*AP*AK` = "Delivery Not Completed /
Damaged", with `L11` reference segments for the BOL, PO, and order number pulled from
enrichment. Full X12 004010 interchange (`ISA/GS … SE/GE/IEA`). Usage indicator `T` (test).

Live runs write one of these per escalated shipment to `out/run-<id>/edi/`.

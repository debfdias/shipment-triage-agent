# Examples

`sample_EDI_214.edi` is a real EDI 214 emitted by a run, kept here so you can see the
escalation artifact without running the pipeline.

It's for shipment **SHP-00037**, a damaged shipment. `AT7*AP*AK` means "Delivery Not
Completed / Damaged", with `L11` reference segments for the BOL, PO, and order number pulled
from enrichment. It's a full X12 004010 interchange (`ISA/GS` through `SE/GE/IEA`). Usage
indicator `T` (test).

Live runs write one of these per escalated shipment into `out/run_<id>/edi/`.

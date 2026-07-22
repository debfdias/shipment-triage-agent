/**
 * Schema for the tracking-detail API response.
 *
 * The API returns 200 with three very different bodies (observed by probing it live):
 *   1. FULL     — every field present, currentStatus is a string, scanHistory is an array.
 *   2. THIN     — a handful of fields, no currentStatus, no scanHistory.
 *   3. GARBAGE  — currentStatus is a NUMBER, scanHistory is the string "unavailable",
 *                 destination is null, and there's an explicit `ok: false`.
 *
 * This schema defines what a TRUSTWORTHY body looks like. Anything that fails it is not
 * thrown away blindly — enrich.ts inspects WHY it failed to decide degraded vs garbage.
 */

import { z } from "zod";

const GeoSchema = z
  .object({ city: z.string().optional(), state: z.string().optional() })
  .nullable();

const ScanSchema = z.object({
  time: z.string(),
  status: z.string(),
  city: z.string().optional(),
  state: z.string().optional(),
});

/** The "good" shape. currentStatus MUST be a string and scanHistory MUST be an array — the
 *  two fields the garbage body corrupts. Everything else is optional to tolerate the API's
 *  natural variation without over-rejecting. */
export const TrackingDetailSchema = z.object({
  shipmentId: z.string(),
  scac: z.string().optional(),
  currentStatus: z.string(),
  statusReason: z.string().optional(),
  lastEventTime: z.string().optional(),
  promisedDeliveryDate: z.string().optional(),
  estimatedDeliveryDate: z.string().optional(),
  origin: GeoSchema.optional(),
  destination: GeoSchema.optional(),
  referenceNumbers: z.record(z.string()).optional(),
  pieces: z.number().optional(),
  weightLbs: z.number().optional(),
  scanHistory: z.array(ScanSchema),
  exceptionNotes: z.string().optional(),
});

export type TrackingDetail = z.infer<typeof TrackingDetailSchema>;
export type ScanEntry = z.infer<typeof ScanSchema>;

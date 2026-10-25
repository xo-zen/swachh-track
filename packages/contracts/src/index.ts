import { z } from 'zod';

export const ROLES = ['RESIDENT', 'SOCIETY_ADMIN', 'COLLECTOR', 'SUPERVISOR', 'ULB_ADMIN', 'SUPER_ADMIN'] as const;
export const STREAMS = ['WET', 'DRY', 'SANITARY', 'SPECIAL_CARE'] as const;
export const SEGREGATIONS = ['GOOD', 'PARTIAL', 'MIXED'] as const;
export const EXCEPTION_CODES = ['NOT_OUT', 'ACCESS_BLOCKED', 'CONTAMINATED', 'WRONG_STREAM', 'QUANTITY_DISPUTE', 'WEIGHT_UNAVAILABLE', 'OTHER'] as const;
export const roleSchema = z.enum(ROLES);
export const streamSchema = z.enum(STREAMS);
export const segregationSchema = z.enum(SEGREGATIONS);
export const exceptionCodeSchema = z.enum(EXCEPTION_CODES);
export const verificationStatusSchema = z.enum(['VERIFIED', 'NEEDS_REVIEW', 'REJECTED']);
export const pickupStatusSchema = z.enum(['SCHEDULED', 'IN_PROGRESS', 'CAPTURED', 'SYNCED', 'VERIFIED', 'NEEDS_REVIEW', 'REJECTED']);
export const stopStatusSchema = z.enum(['PENDING', 'DONE', 'EXCEPTION', 'SKIPPED']);
export const invoiceStatusSchema = z.enum(['DRAFT', 'ISSUED', 'PAID', 'VOID']);
export const complaintStatusSchema = z.enum(['OPEN', 'ACKNOWLEDGED', 'IN_PROGRESS', 'WAITING_FOR_RESIDENT', 'RESOLVED', 'CLOSED', 'REOPENED']);
export const provenanceSchema = z.enum(['VERIFIED', 'SELF_REPORTED', 'ESTIMATED', 'NOT_MEASURED']);
export const uuidSchema = z.string().uuid();
export const datetimeSchema = z.string().datetime({ offset: true }).refine(value => Number.isFinite(Date.parse(value)), 'Invalid timestamp or timezone offset');
export const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}, 'Expected a real calendar date');
export const timeSchema = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
export const paiseSchema = z.number().int().safe().nonnegative();
export const kgSchema = z.number().finite().positive().max(9_999_999.999).refine(
  value => Math.abs(value * 1000 - Math.round(value * 1000)) < 0.00001,
  'Weight supports at most three decimal places',
);
const nonempty = z.string().trim().min(1).max(2000);
const latitude = z.number().finite().min(-90).max(90);
const longitude = z.number().finite().min(-180).max(180);

export const pickupStreamSchema = z.object({
  stream: streamSchema,
  kg: kgSchema,
  segregation: segregationSchema,
  contamination: z.boolean(),
  contaminationNote: nonempty.optional(),
  photoId: uuidSchema,
}).strict().superRefine((value, ctx) => {
  if (value.contamination && !value.contaminationNote) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['contaminationNote'], message: 'A contamination reason is required' });
  }
});

export const exceptionSchema = z.object({ code: exceptionCodeSchema, note: nonempty, photoId: uuidSchema }).strict();
export const pickupSchema = z.object({
  client_uuid: uuidSchema,
  propertyId: uuidSchema,
  routeStopId: uuidSchema,
  deviceId: z.string().trim().min(1).max(200),
  qrToken: z.string().min(1).max(2048),
  capturedAt: datetimeSchema,
  latitude,
  longitude,
  accuracyM: z.number().finite().nonnegative(),
  gpsCapturedAt: datetimeSchema,
  offline: z.boolean(),
  streams: z.array(pickupStreamSchema).max(4).default([]),
  doorstepPhotoId: uuidSchema.optional(),
  exception: exceptionSchema.optional(),
}).strict().superRefine((value, ctx) => {
  if (!value.exception && value.streams.length === 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['streams'], message: 'At least one weighed stream or an evidenced exception is required' });
  }
  if ((value.streams.length > 0 || !value.exception) && !value.doorstepPhotoId) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['doorstepPhotoId'], message: 'A doorstep photo is required for a collection' });
  }
  if (new Set(value.streams.map(item => item.stream)).size !== value.streams.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['streams'], message: 'Each stream may occur only once' });
  }
});
export const batchSchema = z.object({ events: z.array(pickupSchema).min(1).max(500) }).strict();

export const otpRequestSchema = z.object({ phone: z.string().regex(/^\+[1-9]\d{7,14}$/) }).strict();
export const otpVerifySchema = otpRequestSchema.extend({ otp: z.string().regex(/^\d{6}$/) }).strict();
export const refreshSchema = z.object({ refreshToken: nonempty }).strict();
export const deviceRegistrationSchema = z.object({ deviceId: z.string().min(1).max(200), platform: z.enum(['ANDROID', 'IOS']), appVersion: z.string().min(1).max(50) }).strict();
export const propertySchema = z.object({ unitNo: z.string().trim().min(1).max(100), block: z.string().max(100).optional(), floor: z.number().int().optional(), latitude, longitude, status: z.enum(['ACTIVE', 'INACTIVE']).default('ACTIVE') }).strict();
export const propertyUpdateSchema = propertySchema.partial().strict().refine(value => Object.keys(value).length > 0, 'At least one field is required');
export const residentInviteSchema = z.object({ phone: otpRequestSchema.shape.phone, name: z.string().trim().min(1).max(200), propertyId: uuidSchema }).strict();

export const schedulePatternSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('WEEKLY'), weekdays: z.array(z.number().int().min(0).max(6)).min(1).max(7).refine(days => new Set(days).size === days.length, 'Duplicate weekdays') }).strict(),
  z.object({ type: z.literal('EVERY_N_DAYS'), everyNDays: z.number().int().min(1).max(366) }).strict(),
]);
export const scheduleSchema = z.object({ stream: streamSchema, pattern: schedulePatternSchema, windowStart: timeSchema, windowEnd: timeSchema, activeFrom: dateSchema, activeTo: dateSchema.optional() }).strict().superRefine((value, ctx) => {
  if (value.windowStart >= value.windowEnd) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['windowEnd'], message: 'Window must end after its start on the same IST day' });
  if (value.activeTo && value.activeTo < value.activeFrom) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['activeTo'], message: 'End date precedes start date' });
});
export const routeAssignmentSchema = z.object({ routeId: uuidSchema, routeStopId: uuidSchema, collectorId: uuidSchema, vendorId: uuidSchema }).strict();
export const supervisorReviewSchema = z.object({ decision: z.enum(['APPROVE', 'REJECT']), reason: nonempty }).strict();
export const stopTransitionSchema = z.object({ status: stopStatusSchema, reason: nonempty.optional() }).strict().refine(value => value.status !== 'SKIPPED' || Boolean(value.reason), 'Skipping requires a supervisor reason');
export const ratingSchema = z.object({ punctuality: z.number().int().min(1).max(5), quality: z.number().int().min(1).max(5), guidance: z.number().int().min(1).max(5), comment: z.string().max(2000).optional() }).strict();
export const complaintSchema = z.object({ propertyId: uuidSchema, pickupEventId: uuidSchema.optional(), categoryId: uuidSchema, description: nonempty, photoId: uuidSchema }).strict();
export const complaintTransitionSchema = z.object({ status: complaintStatusSchema, note: nonempty.optional(), photoId: uuidSchema.optional() }).strict().superRefine((value, ctx) => {
  if (['RESOLVED', 'WAITING_FOR_RESIDENT', 'REOPENED'].includes(value.status) && !value.note) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['note'], message: 'A reason is required' });
  if (value.status === 'RESOLVED' && !value.photoId) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['photoId'], message: 'Resolution requires a photo' });
});
export const complaintReopenSchema = z.object({ note: nonempty }).strict();
export const complaintCategorySchema = z.object({ name: nonempty, slaHours: z.number().finite().positive().max(8760) }).strict();

export const eligibilitySchema = z.object({ floorAreaSqm: z.number().finite().nonnegative(), waterLitresPerDay: z.number().finite().nonnegative(), wasteKgPerDay: z.number().finite().nonnegative(), flats: z.number().int().nonnegative(), isRwaOrGatedCommunity: z.boolean().default(true) }).strict();
export const vendorSchema = z.object({ name: nonempty, kind: z.enum(['COLLECTOR', 'TRANSPORTER', 'MRF', 'RECYCLER', 'COMPOST', 'BIOGAS']), authorisationNumber: nonempty, validFrom: dateSchema, validUntil: dateSchema, documentId: uuidSchema }).strict().refine(value => value.validUntil >= value.validFrom, 'Invalid authorisation dates');
export const documentSchema = z.object({ type: nonempty, number: nonempty, issuedBy: nonempty, issuedAt: dateSchema, validUntil: dateSchema.optional(), storageKey: nonempty }).strict().refine(value => !value.validUntil || value.validUntil >= value.issuedAt, 'Invalid validity dates');
export const certificateSchema = z.object({ certificateNo: nonempty, issuingUlbId: uuidSchema, stream: streamSchema, kg: kgSchema, issuedAt: dateSchema, validUntil: dateSchema.optional(), documentId: uuidSchema, status: z.enum(['ACTIVE', 'REVOKED']).default('ACTIVE') }).strict().refine(value => !value.validUntil || value.validUntil >= value.issuedAt, 'Invalid certificate dates');
export const handoverSchema = z.object({ date: dateSchema, vendorId: uuidSchema, stream: streamSchema, kg: kgSchema, receiptNumber: nonempty, documentId: uuidSchema, destination: nonempty }).strict();
export const processingLogSchema = z.object({ assetId: uuidSchema, date: dateSchema, inputKg: kgSchema, outputKg: z.number().finite().nonnegative(), downtimeHours: z.number().finite().min(0).max(24), photoId: uuidSchema }).strict();
export const annualReturnSchema = z.object({ financialYearStart: z.number().int().min(2000).max(2200) }).strict();
export const invoiceGenerateSchema = z.object({ periodStart: dateSchema, periodEnd: dateSchema, dueDate: dateSchema, adjustmentPaise: z.number().int().safe().optional(), adjustmentReason: nonempty.optional() }).strict().superRefine((value, ctx) => {
  if (value.periodEnd < value.periodStart) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['periodEnd'], message: 'Invalid period' });
  if (value.dueDate < value.periodEnd) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['dueDate'], message: 'Due date precedes period end' });
  if (value.adjustmentPaise !== undefined && !value.adjustmentReason) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['adjustmentReason'], message: 'Adjustment requires a reason' });
});
export const paymentSchema = z.object({ amountPaise: paiseSchema.positive(), paidAt: datetimeSchema, reference: nonempty }).strict();
export const invoiceDisputeSchema = z.object({ lineId: uuidSchema, reason: nonempty }).strict();
export const notificationPreferencesSchema = z.object({ inApp: z.boolean(), email: z.boolean(), whatsappOptIn: z.boolean(), quietStart: timeSchema.default('21:00'), quietEnd: timeSchema.default('07:00') }).strict();
export const photoPresignSchema = z.object({ kind: z.enum(['DOORSTEP', 'SCALE', 'EXCEPTION', 'RESOLUTION']), stream: streamSchema.optional(), captureSource: z.literal('CAMERA'), contentType: z.enum(['image/jpeg', 'image/png', 'image/webp']), sizeBytes: z.number().int().positive().max(10 * 1024 * 1024), capturedAt: datetimeSchema }).strict().refine(value => value.kind !== 'SCALE' || value.stream !== undefined, 'Scale photos require a stream');
export const photoConfirmSchema = z.object({ photoId: uuidSchema }).strict();
export const listQuerySchema = z.object({ cursor: uuidSchema.optional(), limit: z.coerce.number().int().min(1).max(100).default(25), from: datetimeSchema.optional(), to: datetimeSchema.optional(), status: z.string().min(1).max(100).optional(), societyId: uuidSchema.optional(), wardId: uuidSchema.optional() }).strict().refine(value => !value.from || !value.to || Date.parse(value.from) <= Date.parse(value.to), 'Invalid time range');

export const errorEnvelopeSchema = z.object({ error: z.object({ code: z.string(), message: z.string(), details: z.unknown().optional(), requestId: z.string().optional() }).strict() }).strict();
export type Role = z.infer<typeof roleSchema>;
export type Stream = z.infer<typeof streamSchema>;
export type Segregation = z.infer<typeof segregationSchema>;
export type ExceptionCode = z.infer<typeof exceptionCodeSchema>;
export type VerificationStatus = z.infer<typeof verificationStatusSchema>;
export type PickupStatus = z.infer<typeof pickupStatusSchema>;
export type StopStatus = z.infer<typeof stopStatusSchema>;
export type InvoiceStatus = z.infer<typeof invoiceStatusSchema>;
export type ComplaintStatus = z.infer<typeof complaintStatusSchema>;
export type Provenance = z.infer<typeof provenanceSchema>;
export type PickupInput = z.infer<typeof pickupSchema>;
export type PickupRequest = z.input<typeof pickupSchema>;
export type PickupStream = z.infer<typeof pickupStreamSchema>;
export type BatchInput = z.infer<typeof batchSchema>;
export type ScheduleInput = z.infer<typeof scheduleSchema>;
export type EligibilityInput = z.infer<typeof eligibilitySchema>;
export type ErrorEnvelope = z.infer<typeof errorEnvelopeSchema>;

export { ApiError, createApiClient } from './client';
export type { ApiClientOptions, ApiRequestOptions } from './client';

import { Prisma, PrismaClient, type Role, type Stream } from '@prisma/client';
import { signQrToken, hashQrToken, calculateInvoice } from '@swachh/domain';
import sharp from 'sharp';
import { loadConfig } from './config.js';
import { Storage } from './storage.js';
import { hash, istDate, json } from './core.js';
import { dataset } from './analytics.js';
import { demoId, DEMO_ULB_ID, DEMO_ULB_CODE, DEMO_SEED_ACTION } from './demo.js';

export { demoId } from './demo.js';
const dayMs = 86400000;

export async function seedDatabase(db = new PrismaClient()) {
  const config = loadConfig();
  if (config.NODE_ENV === 'production') throw new Error('Fictional demonstration data must not be seeded in production.');
  const hosted = config.HOSTED_DEMO === 'true';
  if (hosted && (config.NODE_ENV !== 'development' || config.DEMO_MODE !== 'true')) throw new Error('HOSTED_DEMO seeding requires NODE_ENV=development and DEMO_MODE=true.');
  const propertiesPerSociety = hosted ? 6 : 48;
  const propertyCount = propertiesPerSociety * 5;
  const stopsPerRoute = propertyCount / 3;
  const propertiesPerBlock = propertiesPerSociety / 2;
  const propertiesPerFloor = propertiesPerSociety / 6;
  const historyDays = hosted ? 7 : 30;
  const storage = new Storage(config);
  const ulbId = DEMO_ULB_ID;
  let today = new Date(istDate());
  const atDay = (offset: number) => new Date(today.getTime() + offset * dayMs);
  const qrKey = { secret: config.QR_SECRET, version: config.QR_SECRET_VERSION };
  try {
    const previous = await db.ulb.findUnique({ where: { code: DEMO_ULB_CODE } });
    const markers = await db.auditLog.findMany({ where: { ulbId, action: DEMO_SEED_ACTION } });
    if (hosted) {
      const foreignUlb = await db.ulb.findFirst({ where: { NOT: { OR: [{ id: ulbId, code: DEMO_ULB_CODE }, { id: demoId('ulb-isolation'), code: 'ISOLATION-DEMO' }] } } });
      if (foreignUlb) throw new Error('Hosted seed requires a dedicated database containing only the expected NAGAR-DEMO and ISOLATION-DEMO tenants. Use a new empty database; existing data is never reset.');
      if (markers.some(marker => {
        const counts = marker.after;
        return !counts || typeof counts !== 'object' || Array.isArray(counts) || counts.properties !== propertyCount || counts.historicalDays !== historyDays;
      })) throw new Error('Hosted seed requires a 30-property, 7-day seed marker. Use a new empty database instead of switching an existing seed profile.');
    }
    if (previous && markers.length) {
      console.info('Fictional seed already exists; skipped without overwriting pilot data. Use a new empty database for a fresh demo.');
      return;
    }
    if (hosted) {
      // A partial standard seed shares IDs, but not the compact society assignments.
      const expectedProperties = new Map(Array.from({ length: propertyCount }, (_, i) => [demoId(`property-${i}`), demoId(`society-${Math.floor(i / propertiesPerSociety)}`)]));
      const existingProperties = await db.property.findMany({ select: { id: true, ulbId: true, societyId: true } });
      if (existingProperties.some(p => p.ulbId !== ulbId || expectedProperties.get(p.id) !== p.societyId)) throw new Error('Hosted seed cannot resume an incompatible property layout. Use a new empty database; existing data is never reset.');
      // Pin resumed history to the original run, even if it resumes on another day.
      if (previous) today = new Date(istDate(previous.createdAt));
    }
    await db.ulb.upsert({ where: { id: ulbId }, update: {}, create: { id: ulbId, name: 'Nagar Municipal Corporation (fictional)', state: 'Maharashtra', code: DEMO_ULB_CODE, settings: { geofenceM: 75, maxAccuracyM: 50, offlineRetentionDays: 30, certificateValidityYears: 3, photoRetentionMonths: 24, complaintPhotoRetentionMonths: 24, auditRetentionYears: 7, invoiceRetentionYears: 8 }, flags: { billing_v1: true, compliance_v2: true, whatsapp_v1: false, swachhata_v1: false } } });
    const wards = ['River Ward', 'Garden Ward'].map((name, i) => ({ id: demoId(`ward-${i}`), ulbId, name, code: `W${i + 1}`, boundary: json({ type: 'Polygon', coordinates: [[[73.84 + i * 0.02, 18.51], [73.86 + i * 0.02, 18.51], [73.86 + i * 0.02, 18.54], [73.84 + i * 0.02, 18.54], [73.84 + i * 0.02, 18.51]]] }) }));
    await db.ward.createMany({ data: wards, skipDuplicates: true });
    const names = ['Green Meadows', 'Sunrise Apartments', 'Lakeview Heights', 'Maple Residency', 'Palm Grove'];
    const societies = names.map((name, i) => ({ id: demoId(`society-${i}`), ulbId, wardId: wards[i < 3 ? 0 : 1].id, name, address: `Fictional pilot precinct ${i + 1}, Nagar. Not a real residential address.`, latitude: 18.5204 + i * 0.002, longitude: 73.8567 + i * 0.003, floorAreaSqm: [24000, 16000, 22000, 8000, 4800][i], waterLpd: [42000, 30000, 41000, 18000, 9000][i], wasteKgDay: [140, 90, 120, 70, 40][i], settings: { flatFeePaise: 25000, pickupFeePaise: 200, handlingFeePaisePerKg: 50, missedDeductionPaise: 100, graceDays: 15, paymentInstructions: 'Demo: record a manual payment reference. No real payment is requested.', feeSource: 'Fictional pilot fee resolution; not a state tariff', feeSourceDate: today.toISOString().slice(0, 10) }, registration: { cpcbStatus: 'PENDING', registrationNumber: `DEMO-RWA-${i + 1}`, provenance: 'SELF_REPORTED' } }));
    await db.society.createMany({ data: societies, skipDuplicates: true });
    const properties = Array.from({ length: propertyCount }, (_, i) => {
      const society = societies[Math.floor(i / propertiesPerSociety)]; const id = demoId(`property-${i}`);
      return { id, ulbId, societyId: society.id, unitNo: String(101 + i % propertiesPerSociety), block: i % propertiesPerSociety < propertiesPerBlock ? 'A' : 'B', floor: Math.floor(i % propertiesPerSociety / propertiesPerFloor) + 1, latitude: society.latitude + (i % propertiesPerFloor) * 0.00002, longitude: society.longitude + Math.floor(i % propertiesPerSociety / propertiesPerFloor) * 0.00002, propertyCode: String(100001 + i), qrTokenHash: hashQrToken(signQrToken(id, qrKey)), qrVersion: qrKey.version };
    });
    await db.property.createMany({ data: properties, skipDuplicates: true });
    const roleUsers: { alias: string; phone: string; name: string; role: Role }[] = [
      { alias: 'resident', phone: '+919000000001', name: 'Demo Resident', role: 'RESIDENT' },
      { alias: 'society', phone: '+919000000002', name: 'Demo Society Administrator', role: 'SOCIETY_ADMIN' },
      { alias: 'collector', phone: '+919000000003', name: 'Demo Collector One', role: 'COLLECTOR' },
      { alias: 'supervisor', phone: '+919000000004', name: 'Demo Supervisor', role: 'SUPERVISOR' },
      { alias: 'ulb', phone: '+919000000005', name: 'Demo Municipal Officer', role: 'ULB_ADMIN' },
    ];
    const contractors = ['Clean Streets Cooperative', 'Circular City Services'].map((name, i) => ({ id: demoId(`contractor-${i}`), ulbId, name: `${name} (fictional)`, contractNo: `DEMO-CONTRACT-${i + 1}`, validFrom: atDay(-365), validTo: atDay(365) }));
    await db.contractor.createMany({ data: contractors, skipDuplicates: true });
    for (const account of roleUsers) {
      const id = demoId(`user-${account.alias}`);
      await db.user.upsert({ where: { id }, update: {}, create: { id, phone: account.phone, name: account.name, email: `${account.alias}@demo.swachhtrack.in`, consentAt: new Date(), notificationPreferences: { inApp: true, email: false, whatsapp: false } } });
      await db.membership.upsert({ where: { id: demoId(`membership-${account.alias}`) }, update: {}, create: { id: demoId(`membership-${account.alias}`), userId: id, ulbId, role: account.role, societyId: ['RESIDENT', 'SOCIETY_ADMIN'].includes(account.role) ? societies[0].id : null, contractorId: ['COLLECTOR', 'SUPERVISOR'].includes(account.role) ? contractors[0].id : null } });
    }
    await db.resident.upsert({ where: { userId_propertyId: { userId: demoId('user-resident'), propertyId: properties[0].id } }, update: {}, create: { id: demoId('resident-0'), ulbId, userId: demoId('user-resident'), propertyId: properties[0].id, ownership: 'OWNER' } });
    const collectors = Array.from({ length: 6 }, (_, i) => ({ id: demoId(`collector-${i}`), ulbId, contractorId: contractors[i < 3 ? 0 : 1].id, userId: i === 0 ? demoId('user-collector') : demoId(`user-collector-${i}`), employeeCode: `DEMO-C${i + 1}` }));
    for (let i = 1; i < 6; i++) {
      await db.user.upsert({ where: { id: collectors[i].userId }, update: {}, create: { id: collectors[i].userId, phone: `+91900000001${i}`, name: `Demo Collector ${i + 1}` } });
      await db.membership.upsert({ where: { id: demoId(`membership-collector-${i}`) }, update: {}, create: { id: demoId(`membership-collector-${i}`), ulbId, userId: collectors[i].userId, role: 'COLLECTOR', contractorId: collectors[i].contractorId } });
    }
    await db.collector.createMany({ data: collectors, skipDuplicates: true });
    await db.device.createMany({ data: collectors.map((c, i) => ({ id: demoId(`device-${i}`), ulbId, collectorId: c.id, deviceId: `demo-device-${i + 1}`, platform: 'ANDROID', appVersion: '0.1.0' })), skipDuplicates: true });
    const categories = [{ name: 'Garbage vehicle not arrived', slaHours: 12 }, { name: 'Garbage dump', slaHours: 12 }, { name: 'Dustbin not cleaned', slaHours: 12 }, { name: 'Dead animal', slaHours: 48 }, { name: 'Segregation guidance requested', slaHours: 24 }].map((c, i) => ({ ...c, id: demoId(`category-${i}`), ulbId }));
    await db.complaintCategory.createMany({ data: categories, skipDuplicates: true });
    await db.schedule.createMany({ data: societies.flatMap(s => (['WET', 'DRY', 'SANITARY', 'SPECIAL_CARE'] as Stream[]).map(stream => ({ id: demoId(`schedule-${s.id}-${stream}`), ulbId, societyId: s.id, stream, pattern: stream === 'SPECIAL_CARE' ? 'EVERY_N_DAYS' : 'WEEKLY', weekdays: stream === 'SANITARY' ? [2, 5] : stream === 'SPECIAL_CARE' ? [] : [0, 1, 2, 3, 4, 5, 6], everyNDays: stream === 'SPECIAL_CARE' ? 4 : null, windowStart: '07:00', windowEnd: '11:00', activeFrom: atDay(-84), activeTo: atDay(84) }))), skipDuplicates: true });

    // Seed receipts are explicitly labelled synthetic. They contain real private image bytes,
    // but are not represented as field evidence from real households.
    const makeImage = async (label: string, color: string) => sharp(Buffer.from(`<svg width="320" height="200" xmlns="http://www.w3.org/2000/svg"><rect width="320" height="200" fill="${color}"/><text x="16" y="45" font-size="18" fill="white">FICTIONAL DEMO EVIDENCE</text><text x="16" y="90" font-size="14" fill="white">${label}</text><text x="16" y="150" font-size="13" fill="white">Not a real household photograph</text></svg>`)).jpeg({ quality: 75 }).toBuffer();
    const docBytes = await makeImage('External document sample', '#34584b');
    const documents: Prisma.ComplianceDocumentCreateManyInput[] = [];
    const existingDocuments = new Set((await db.complianceDocument.findMany({ where: { ulbId }, select: { id: true } })).map(d => d.id));
    for (let i = 0; i < 5; i++) {
      const id = demoId(`document-${i}`); const key = `${ulbId}/seed/${id}.jpg`;
      if (!existingDocuments.has(id)) await storage.write(key, docBytes);
      documents.push({ id, ulbId, societyId: societies[i].id, type: 'VENDOR_AUTHORIZATION', number: `DEMO-DOC-${i + 1}`, issuedBy: 'Fictional Nagar ULB', issuedAt: atDay(-300), validUntil: atDay(365), storageKey: key, status: 'DEMO_SYNTHETIC' });
    }
    await db.complianceDocument.createMany({ data: documents, skipDuplicates: true });
    await db.vendor.createMany({ data: societies.map((s, i) => ({ id: demoId(`vendor-${i}`), ulbId, societyId: s.id, contractorId: contractors[i < 3 ? 0 : 1].id, name: `Fictional authorized processor ${i + 1}`, type: 'RECYCLER', authorizationNumber: `DEMO-AUTH-${i + 1}`, validFrom: atDay(-365), validUntil: atDay(365), documentId: documents[i].id })), skipDuplicates: true });
    await db.ebwgrCertificate.createMany({ data: societies.map((s, i) => ({ id: demoId(`certificate-${i}`), ulbId, societyId: s.id, certificateNo: `DEMO-EBWGR-${i + 1}`, stream: 'DRY', kg: 4000 + i * 500, issuedBy: 'Fictional Nagar ULB (external sample)', issuedAt: atDay(-730), validUntil: atDay(i === 0 ? 30 : i === 1 ? -10 : 365), documentId: documents[i].id!, recordedBy: demoId('user-ulb'), status: 'RECORDED' })), skipDuplicates: true });

    for (let offset = -historyDays; offset <= 0; offset++) {
      const date = atDay(offset); const label = date.toISOString().slice(0, 10);
      const routeRows = Array.from({ length: 3 }, (_, r) => { const collector = collectors[offset === 0 ? r : (r + Math.abs(offset) % 2 * 3)]; return { id: demoId(`route-${label}-${r}`), ulbId, contractorId: collector.contractorId, collectorId: collector.id, wardId: wards[r === 2 ? 1 : 0].id, name: ['Morning River Loop', 'Central Society Loop', 'Garden Ward Loop'][r], date }; });
      await db.route.createMany({ data: routeRows, skipDuplicates: true });
      const stops = properties.map((p, i) => ({ id: demoId(`stop-${label}-${i}`), ulbId, routeId: routeRows[Math.floor(i / stopsPerRoute)].id, propertyId: p.id, sequence: i % stopsPerRoute + 1, windowStart: new Date(`${label}T07:00:00+05:30`), windowEnd: new Date(`${label}T11:00:00+05:30`), streams: ['WET', 'DRY', 'SANITARY', 'SPECIAL_CARE'] as Stream[], status: offset === 0 ? 'PENDING' : (((offset + historyDays) * propertyCount + i) % 100 < 82 ? 'DONE' : 'PENDING') }));
      await db.routeStop.createMany({ data: stops, skipDuplicates: true });
      if (offset === 0) continue;
      const events: Prisma.PickupEventCreateManyInput[] = []; const streams: Prisma.PickupStreamCreateManyInput[] = []; const photos: Prisma.PhotoCreateManyInput[] = []; const exceptions: Prisma.PickupExceptionCreateManyInput[] = [];
      const existingEvents = new Set((await db.pickupEvent.findMany({ where: { id: { in: properties.map((_, i) => demoId(`pickup-${label}-${i}`)) } }, select: { id: true } })).map(p => p.id));
      for (let i = 0; i < propertyCount; i++) {
        const id = demoId(`pickup-${label}-${i}`);
        if (existingEvents.has(id)) continue;
        const sequence = (offset + historyDays) * propertyCount + i; const bucket = sequence % 100;
        const status = bucket < 82 ? 'VERIFIED' : bucket < 90 ? 'NEEDS_REVIEW' : bucket < 94 ? 'REJECTED' : 'NEEDS_REVIEW';
        const exception = bucket >= 94; const p = properties[i]; const route = routeRows[Math.floor(i / stopsPerRoute)]; const collector = collectors.find(c => c.id === route.collectorId)!;
        const capturedAt = new Date(`${label}T08:${String(i % 60).padStart(2, '0')}:00+05:30`);
        const stream: Stream = (['WET', 'DRY', 'SANITARY', 'SPECIAL_CARE'] as const)[i % 4];
        const photoIds = [demoId(`photo-${id}-door`), demoId(`photo-${id}-scale`)];
        for (let n = 0; n < (exception ? 1 : 2); n++) {
          const kind = exception ? 'EXCEPTION' : n === 0 ? 'DOORSTEP' : 'SCALE';
          const bytes = await makeImage(`${label} - ${p.unitNo} - ${kind}`, n === 0 ? '#36596d' : '#685334');
          const key = `${ulbId}/seed/${photoIds[n]}.jpg`; await storage.write(key, bytes);
          photos.push({ id: photoIds[n], ulbId, ownerId: collector.userId, clientUuid: id, pickupEventId: id, propertyId: p.id, kind, stream: n === 1 ? stream : null, captureSource: 'CAMERA', storageKey: key, sha256: hash(bytes), width: 320, height: 200, size: bytes.length, status: 'CONFIRMED', expiresAt: atDay(365), confirmedAt: capturedAt, claimedAt: capturedAt });
        }
        events.push({ id, ulbId, societyId: p.societyId, propertyId: p.id, collectorId: collector.id, routeStopId: stops[i].id, clientUuid: id, scheduledFor: stops[i].windowStart, capturedAt, receivedAt: capturedAt, latitude: p.latitude, longitude: p.longitude, accuracyM: status === 'NEEDS_REVIEW' ? 65 : 12, gpsCapturedAt: capturedAt, deviceId: `demo-device-${collectors.indexOf(collector) + 1}`, qrTokenHash: p.qrTokenHash, offline: bucket >= 82 && bucket < 90, status, verificationScore: status === 'VERIFIED' ? 100 : status === 'REJECTED' ? 0 : 70, verificationReasons: json(status === 'VERIFIED' ? [] : [{ code: exception ? 'EXCEPTION_RECORDED' : status === 'REJECTED' ? 'GEOFENCE_FAILED' : 'LOW_GPS_ACCURACY', severity: status === 'REJECTED' ? 'HARD' : 'SOFT', message: 'Fictional seeded scenario', penalty: status === 'REJECTED' ? 100 : 30 }]), exceptionCode: exception ? 'NOT_OUT' : null, exceptionNote: exception ? 'Fictional demonstration: waste was not set out.' : null, batchId: demoId(`seed-batch-${label}`), provenance: 'DEMO_SYNTHETIC', createdAt: capturedAt });
        if (!exception) streams.push({ id: demoId(`stream-${id}`), ulbId, pickupEventId: id, stream, kg: Number((0.5 + i % 25 / 10).toFixed(3)), segregation: i % 10 < 7 ? 'GOOD' : i % 10 < 9 ? 'PARTIAL' : 'MIXED', contamination: i % 13 === 0, contaminationNote: i % 13 === 0 ? 'Fictional mixed packaging' : null, photoId: photoIds[1] });
        else exceptions.push({ id: demoId(`exception-${id}`), ulbId, pickupEventId: id, code: 'NOT_OUT', note: 'Fictional demonstration: waste not set out.', photoId: photoIds[0] });
      }
      await db.$transaction(async tx => {
        await tx.pickupEvent.createMany({ data: events, skipDuplicates: true });
        await tx.pickupStream.createMany({ data: streams, skipDuplicates: true });
        await tx.photo.createMany({ data: photos, skipDuplicates: true });
        await tx.pickupException.createMany({ data: exceptions, skipDuplicates: true });
      }, { timeout: 30000 });
    }
    const complaintStatuses = ['OPEN', 'ACKNOWLEDGED', 'IN_PROGRESS', 'RESOLVED', 'REOPENED', 'CLOSED'] as const;
    for (let i = 0; i < 12; i++) {
      const createdAt = new Date(Date.now() - (i < 2 ? 72 : i + 2) * 3600000); const status = complaintStatuses[i % 6];
      await db.complaint.upsert({ where: { id: demoId(`complaint-${i}`) }, update: {}, create: { id: demoId(`complaint-${i}`), ulbId, societyId: societies[0].id, propertyId: properties[0].id, residentId: demoId('user-resident'), categoryId: categories[i % categories.length].id, slaHours: categories[i % categories.length].slaHours, description: `Fictional pilot complaint ${i + 1}: ${categories[i % categories.length].name}.`, status, slaDueAt: new Date(createdAt.getTime() + categories[i % categories.length].slaHours * 3600000), createdAt, resolvedAt: ['RESOLVED', 'CLOSED'].includes(status) ? new Date(createdAt.getTime() + 3600000) : null, resolutionNote: ['RESOLVED', 'CLOSED'].includes(status) ? 'Fictional resolution evidence recorded.' : null, reopenedCount: status === 'REOPENED' ? 1 : 0, events: { create: { ulbId, actorId: demoId('user-resident'), toStatus: status, note: 'Fictional seeded lifecycle example', createdAt } } } });
    }
    const rated = await db.pickupEvent.findMany({ where: { ulbId, propertyId: properties[0].id, status: 'VERIFIED' }, orderBy: [{ capturedAt: 'asc' }, { id: 'asc' }], take: 12 });
    await db.rating.createMany({ data: rated.map((p, i) => ({ id: demoId(`rating-${i}`), ulbId, pickupEventId: p.id, residentId: demoId('user-resident'), punctuality: [4, 3, 5, 4][i % 4], quality: [4, 4, 3, 5][i % 4], guidance: [3, 4, 4, 5][i % 4], comment: 'Fictional demo feedback' })), skipDuplicates: true });
    const activeFlats = await db.property.count({ where: { ulbId, societyId: societies[0].id, status: 'ACTIVE', deletedAt: null } });
    for (let month = 1; month <= 2; month++) {
      const start = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - month, 1)); const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0));
      const data = await dataset(db, ulbId, [societies[0].id], start, new Date(end.getTime() + dayMs - 1));
      const calculation = calculateInvoice({ ...data, activeFlats, activeFlatsQueryRef: `fictional-seed:Green-Meadows:${activeFlats}-active-flats`, rates: { perFlatPaise: 25000, perVerifiedStopPaise: 200, handlingPaisePerKg: { WET: 50, DRY: 50, SANITARY: 50, SPECIAL_CARE: 50 }, missedStopDeductionPaise: 100 } });
      const id = demoId(`invoice-${month}`);
      await db.invoice.upsert({ where: { id }, update: {}, create: { id, ulbId, societyId: societies[0].id, periodStart: start, periodEnd: end, dueAt: new Date(end.getTime() + 15 * dayMs), status: month === 2 ? 'PAID' : 'ISSUED', issuedAt: new Date(end.getTime() + dayMs), paidAt: month === 2 ? new Date(end.getTime() + 10 * dayMs) : null, subtotalPaise: calculation.subtotalPaise, deductionsPaise: calculation.deductionsPaise, totalPaise: calculation.totalPaise, lines: { create: calculation.lines.map(l => ({ ulbId, type: l.type, description: l.description, quantity: l.quantity, unit: l.unit, ratePaise: l.ratePaise, amountPaise: l.amountPaise, evidence: json({ eventIds: l.eventIds, stopIds: l.stopIds, aggregateQueryRef: l.aggregateQueryRef }) })) }, ...(month === 2 ? { payments: { create: { ulbId, amountPaise: calculation.totalPaise, reference: 'DEMO-MANUAL-PAYMENT-001', method: 'MANUAL', recordedBy: demoId('user-society'), paidAt: new Date(end.getTime() + 10 * dayMs) } } } : {}) } });
    }
    const otherUlb = demoId('ulb-isolation'); const otherWard = demoId('ward-isolation'); const otherSociety = demoId('society-isolation'); const otherUser = demoId('user-isolation');
    await db.ulb.upsert({ where: { id: otherUlb }, update: {}, create: { id: otherUlb, name: 'Isolation Test Council (fictional)', state: 'Maharashtra', code: 'ISOLATION-DEMO' } });
    await db.ward.upsert({ where: { id: otherWard }, update: {}, create: { id: otherWard, ulbId: otherUlb, name: 'Isolation Ward', code: 'I1' } });
    await db.society.upsert({ where: { id: otherSociety }, update: {}, create: { id: otherSociety, ulbId: otherUlb, wardId: otherWard, name: 'Other Tenant Society', address: 'Fictional test-only address', latitude: 19, longitude: 73 } });
    await db.user.upsert({ where: { id: otherUser }, update: {}, create: { id: otherUser, phone: '+919000000099', name: 'Isolation Officer', email: 'isolation@demo.swachhtrack.in' } });
    await db.membership.upsert({ where: { id: demoId('membership-isolation') }, update: {}, create: { id: demoId('membership-isolation'), ulbId: otherUlb, userId: otherUser, role: 'ULB_ADMIN' } });
    const [societyTotal, propertyTotal, collectorTotal, contractorTotal, routeTemplates, history] = await Promise.all([
      db.society.count({ where: { ulbId } }), db.property.count({ where: { ulbId } }),
      db.collector.count({ where: { ulbId } }), db.contractor.count({ where: { ulbId } }),
      db.route.groupBy({ by: ['name'], where: { ulbId } }),
      db.pickupEvent.findMany({ where: { ulbId }, select: { capturedAt: true, status: true, exceptionCode: true } }),
    ]);
    await db.auditLog.create({ data: { ulbId, actorId: demoId('user-ulb'), action: DEMO_SEED_ACTION, entity: 'Ulb', entityId: ulbId, after: { societies: societyTotal, properties: propertyTotal, collectors: collectorTotal, contractors: contractorTotal, routeTemplates: routeTemplates.length, historicalDays: new Set(history.map(p => istDate(p.capturedAt))).size, historicalEvents: history.length, verified: history.filter(p => p.status === 'VERIFIED').length, needsReview: history.filter(p => p.status === 'NEEDS_REVIEW' && !p.exceptionCode).length, rejected: history.filter(p => p.status === 'REJECTED').length, exceptions: history.filter(p => p.exceptionCode).length, disclaimer: 'Synthetic test data, not evidence of real civic operations.' } } });
    console.info({ ulbId, societyId: societies[0].id, residentPropertyId: properties[0].id, collectorId: collectors[0].id, isolationUlbId: otherUlb }, 'Fictional Swachh-Track seed complete');
  } finally { await db.$disconnect(); }
}

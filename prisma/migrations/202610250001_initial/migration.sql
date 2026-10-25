-- Initial persisted Swachh-Track schema. UUIDs are assigned by Prisma.

CREATE TYPE "Role" AS ENUM ('RESIDENT', 'SOCIETY_ADMIN', 'COLLECTOR', 'SUPERVISOR', 'ULB_ADMIN', 'SUPER_ADMIN');

CREATE TYPE "Stream" AS ENUM ('WET', 'DRY', 'SANITARY', 'SPECIAL_CARE');

CREATE TYPE "PickupStatus" AS ENUM ('VERIFIED', 'NEEDS_REVIEW', 'REJECTED');

CREATE TYPE "ComplaintStatus" AS ENUM ('OPEN', 'ACKNOWLEDGED', 'IN_PROGRESS', 'WAITING_FOR_RESIDENT', 'RESOLVED', 'CLOSED', 'REOPENED');

CREATE TABLE "Ulb" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "settings" JSONB NOT NULL DEFAULT '{}',
    "flags" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Ulb_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Ward" (
    "id" UUID NOT NULL,
    "ulbId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "boundary" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Ward_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Society" (
    "id" UUID NOT NULL,
    "ulbId" UUID NOT NULL,
    "wardId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "latitude" DOUBLE PRECISION NOT NULL,
    "longitude" DOUBLE PRECISION NOT NULL,
    "floorAreaSqm" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "waterLpd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "wasteKgDay" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "settings" JSONB NOT NULL DEFAULT '{}',
    "registration" JSONB NOT NULL DEFAULT '{}',
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Society_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Property" (
    "id" UUID NOT NULL,
    "ulbId" UUID NOT NULL,
    "societyId" UUID NOT NULL,
    "unitNo" TEXT NOT NULL,
    "block" TEXT NOT NULL DEFAULT '',
    "floor" INTEGER NOT NULL DEFAULT 0,
    "latitude" DOUBLE PRECISION NOT NULL,
    "longitude" DOUBLE PRECISION NOT NULL,
    "propertyCode" TEXT NOT NULL,
    "qrTokenHash" TEXT NOT NULL,
    "qrVersion" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Property_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "User" (
    "id" UUID NOT NULL,
    "phone" TEXT NOT NULL,
    "email" TEXT,
    "name" TEXT NOT NULL,
    "locale" TEXT NOT NULL DEFAULT 'en',
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "notificationPreferences" JSONB NOT NULL DEFAULT '{"inApp":true,"email":false,"whatsapp":false}',
    "consentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Membership" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "ulbId" UUID NOT NULL,
    "role" "Role" NOT NULL,
    "societyId" UUID,
    "contractorId" UUID,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Membership_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Resident" (
    "id" UUID NOT NULL,
    "ulbId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "propertyId" UUID NOT NULL,
    "ownership" TEXT NOT NULL DEFAULT 'TENANT',
    "moveInAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Resident_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "OtpChallenge" (
    "id" UUID NOT NULL,
    "phone" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "windowStartedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "requestCount" INTEGER NOT NULL DEFAULT 1,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "consumedAt" TIMESTAMP(3),
    CONSTRAINT "OtpChallenge_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "RefreshToken" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "familyId" UUID NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RefreshToken_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Contractor" (
    "id" UUID NOT NULL,
    "ulbId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "contractNo" TEXT NOT NULL,
    "validFrom" TIMESTAMP(3) NOT NULL,
    "validTo" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Contractor_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Collector" (
    "id" UUID NOT NULL,
    "ulbId" UUID NOT NULL,
    "contractorId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "employeeCode" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Collector_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Vehicle" (
    "id" UUID NOT NULL,
    "ulbId" UUID NOT NULL,
    "contractorId" UUID NOT NULL,
    "registrationNo" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "capacityKg" DECIMAL(10,3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Vehicle_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Vendor" (
    "id" UUID NOT NULL,
    "ulbId" UUID NOT NULL,
    "societyId" UUID NOT NULL,
    "contractorId" UUID,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "authorizationNumber" TEXT NOT NULL,
    "validFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "validUntil" TIMESTAMP(3) NOT NULL,
    "documentId" UUID,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Vendor_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Schedule" (
    "id" UUID NOT NULL,
    "ulbId" UUID NOT NULL,
    "societyId" UUID NOT NULL,
    "stream" "Stream" NOT NULL,
    "pattern" TEXT NOT NULL,
    "weekdays" INTEGER[],
    "everyNDays" INTEGER,
    "windowStart" TEXT NOT NULL,
    "windowEnd" TEXT NOT NULL,
    "activeFrom" TIMESTAMP(3) NOT NULL,
    "activeTo" TIMESTAMP(3),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Schedule_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Route" (
    "id" UUID NOT NULL,
    "ulbId" UUID NOT NULL,
    "contractorId" UUID NOT NULL,
    "collectorId" UUID NOT NULL,
    "wardId" UUID NOT NULL,
    "vehicleId" UUID,
    "name" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Route_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "RouteStop" (
    "id" UUID NOT NULL,
    "ulbId" UUID NOT NULL,
    "routeId" UUID NOT NULL,
    "propertyId" UUID NOT NULL,
    "sequence" INTEGER NOT NULL,
    "windowStart" TIMESTAMP(3) NOT NULL,
    "windowEnd" TIMESTAMP(3) NOT NULL,
    "streams" "Stream"[],
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "RouteStop_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Device" (
    "id" UUID NOT NULL,
    "ulbId" UUID NOT NULL,
    "collectorId" UUID NOT NULL,
    "deviceId" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "appVersion" TEXT NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Device_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PickupEvent" (
    "id" UUID NOT NULL,
    "ulbId" UUID NOT NULL,
    "societyId" UUID NOT NULL,
    "propertyId" UUID NOT NULL,
    "collectorId" UUID NOT NULL,
    "routeStopId" UUID NOT NULL,
    "clientUuid" UUID NOT NULL,
    "scheduledFor" TIMESTAMP(3) NOT NULL,
    "capturedAt" TIMESTAMP(3) NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "latitude" DOUBLE PRECISION NOT NULL,
    "longitude" DOUBLE PRECISION NOT NULL,
    "accuracyM" DOUBLE PRECISION NOT NULL,
    "gpsCapturedAt" TIMESTAMP(3) NOT NULL,
    "deviceId" TEXT NOT NULL,
    "qrTokenHash" TEXT NOT NULL,
    "offline" BOOLEAN NOT NULL,
    "status" "PickupStatus" NOT NULL,
    "verificationScore" INTEGER NOT NULL,
    "verificationReasons" JSONB NOT NULL,
    "exceptionCode" TEXT,
    "exceptionNote" TEXT,
    "exceptionAccepted" BOOLEAN NOT NULL DEFAULT false,
    "reviewReason" TEXT,
    "reviewedBy" UUID,
    "reviewedAt" TIMESTAMP(3),
    "batchId" UUID NOT NULL,
    "provenance" TEXT NOT NULL DEFAULT 'VERIFIED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PickupEvent_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PickupStream" (
    "id" UUID NOT NULL,
    "ulbId" UUID NOT NULL,
    "pickupEventId" UUID NOT NULL,
    "stream" "Stream" NOT NULL,
    "kg" DECIMAL(10,3) NOT NULL,
    "segregation" TEXT NOT NULL,
    "contamination" BOOLEAN NOT NULL,
    "contaminationNote" TEXT,
    "photoId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PickupStream_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Photo" (
    "id" UUID NOT NULL,
    "ulbId" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "clientUuid" UUID,
    "pickupEventId" UUID,
    "propertyId" UUID,
    "kind" TEXT NOT NULL,
    "stream" "Stream",
    "captureSource" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "sha256" TEXT,
    "width" INTEGER,
    "height" INTEGER,
    "size" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'RESERVED',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "confirmedAt" TIMESTAMP(3),
    "claimedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Photo_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Upload" (
    "id" UUID NOT NULL,
    "ulbId" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "filename" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "sha256" TEXT,
    "status" TEXT NOT NULL DEFAULT 'RESERVED',
    "scanStatus" TEXT NOT NULL DEFAULT 'NOT_CONFIGURED',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "confirmedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Upload_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PickupException" (
    "id" UUID NOT NULL,
    "ulbId" UUID NOT NULL,
    "pickupEventId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "note" TEXT NOT NULL,
    "photoId" UUID NOT NULL,
    "supervisorStatus" TEXT NOT NULL DEFAULT 'PENDING',
    "supervisorNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PickupException_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "IdempotencyKey" (
    "id" UUID NOT NULL,
    "ulbId" UUID NOT NULL,
    "actorId" UUID NOT NULL,
    "operation" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "response" JSONB NOT NULL,
    "responseCode" INTEGER NOT NULL DEFAULT 200,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "IdempotencyKey_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "RejectedSubmission" (
    "id" UUID NOT NULL,
    "ulbId" UUID NOT NULL,
    "actorId" UUID NOT NULL,
    "clientUuid" UUID NOT NULL,
    "batchId" UUID NOT NULL,
    "result" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RejectedSubmission_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ComplaintCategory" (
    "id" UUID NOT NULL,
    "ulbId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "slaHours" INTEGER NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ComplaintCategory_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Complaint" (
    "id" UUID NOT NULL,
    "ulbId" UUID NOT NULL,
    "societyId" UUID NOT NULL,
    "propertyId" UUID NOT NULL,
    "pickupEventId" UUID,
    "residentId" UUID NOT NULL,
    "categoryId" UUID NOT NULL,
    "slaHours" INTEGER NOT NULL DEFAULT 12,
    "description" TEXT NOT NULL,
    "photoId" UUID,
    "status" "ComplaintStatus" NOT NULL DEFAULT 'OPEN',
    "slaDueAt" TIMESTAMP(3) NOT NULL,
    "pausedAt" TIMESTAMP(3),
    "pausedSeconds" INTEGER NOT NULL DEFAULT 0,
    "slaPauses" JSONB NOT NULL DEFAULT '[]',
    "waitingFrom" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "resolutionNote" TEXT,
    "resolutionPhotoId" UUID,
    "reopenedCount" INTEGER NOT NULL DEFAULT 0,
    "escalationLevel" INTEGER NOT NULL DEFAULT 0,
    "supervisorNotifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Complaint_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ComplaintEvent" (
    "id" UUID NOT NULL,
    "ulbId" UUID NOT NULL,
    "complaintId" UUID NOT NULL,
    "actorId" UUID NOT NULL,
    "fromStatus" TEXT,
    "toStatus" TEXT NOT NULL,
    "note" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ComplaintEvent_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Rating" (
    "id" UUID NOT NULL,
    "ulbId" UUID NOT NULL,
    "pickupEventId" UUID NOT NULL,
    "residentId" UUID NOT NULL,
    "punctuality" INTEGER NOT NULL,
    "quality" INTEGER NOT NULL,
    "guidance" INTEGER NOT NULL,
    "comment" TEXT,
    "moderated" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Rating_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Invoice" (
    "id" UUID NOT NULL,
    "ulbId" UUID NOT NULL,
    "societyId" UUID NOT NULL,
    "periodStart" DATE NOT NULL,
    "periodEnd" DATE NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "subtotalPaise" INTEGER NOT NULL,
    "deductionsPaise" INTEGER NOT NULL,
    "totalPaise" INTEGER NOT NULL,
    "issuedAt" TIMESTAMP(3),
    "dueAt" TIMESTAMP(3) NOT NULL,
    "paidAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Invoice_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "InvoiceLine" (
    "id" UUID NOT NULL,
    "ulbId" UUID NOT NULL,
    "invoiceId" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "quantity" DECIMAL(12,3) NOT NULL,
    "unit" TEXT NOT NULL,
    "ratePaise" INTEGER NOT NULL,
    "amountPaise" INTEGER NOT NULL,
    "evidence" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "InvoiceLine_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Payment" (
    "id" UUID NOT NULL,
    "ulbId" UUID NOT NULL,
    "invoiceId" UUID NOT NULL,
    "amountPaise" INTEGER NOT NULL,
    "reference" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "recordedBy" UUID NOT NULL,
    "paidAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Payment_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "InvoiceDispute" (
    "id" UUID NOT NULL,
    "ulbId" UUID NOT NULL,
    "invoiceId" UUID NOT NULL,
    "lineId" UUID NOT NULL,
    "actorId" UUID NOT NULL,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "InvoiceDispute_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ComplianceDocument" (
    "id" UUID NOT NULL,
    "ulbId" UUID NOT NULL,
    "societyId" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "issuedBy" TEXT NOT NULL,
    "issuedAt" TIMESTAMP(3) NOT NULL,
    "validUntil" TIMESTAMP(3),
    "photoId" UUID,
    "uploadId" UUID,
    "storageKey" TEXT,
    "status" TEXT NOT NULL DEFAULT 'SELF_REPORTED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ComplianceDocument_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "EbwgrCertificate" (
    "id" UUID NOT NULL,
    "ulbId" UUID NOT NULL,
    "societyId" UUID NOT NULL,
    "certificateNo" TEXT NOT NULL,
    "stream" "Stream" NOT NULL,
    "kg" DECIMAL(10,3) NOT NULL,
    "issuedBy" TEXT NOT NULL,
    "issuedAt" TIMESTAMP(3) NOT NULL,
    "validUntil" TIMESTAMP(3) NOT NULL,
    "documentId" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'RECORDED',
    "recordedBy" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "EbwgrCertificate_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Handover" (
    "id" UUID NOT NULL,
    "ulbId" UUID NOT NULL,
    "societyId" UUID NOT NULL,
    "vendorId" UUID NOT NULL,
    "stream" "Stream" NOT NULL,
    "kg" DECIMAL(10,3) NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "receiptNo" TEXT NOT NULL,
    "destination" TEXT NOT NULL DEFAULT '',
    "documentId" UUID NOT NULL,
    "verifiedAt" TIMESTAMP(3),
    "verifiedBy" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Handover_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "OnsiteLog" (
    "id" UUID NOT NULL,
    "ulbId" UUID NOT NULL,
    "societyId" UUID NOT NULL,
    "asset" TEXT NOT NULL,
    "capacityKg" DECIMAL(10,3) NOT NULL,
    "date" DATE NOT NULL,
    "inputKg" DECIMAL(10,3) NOT NULL,
    "outputKg" DECIMAL(10,3) NOT NULL,
    "downtime" TEXT,
    "photoId" UUID NOT NULL,
    "provenance" TEXT NOT NULL DEFAULT 'SELF_REPORTED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "OnsiteLog_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AnnualReturn" (
    "id" UUID NOT NULL,
    "ulbId" UUID NOT NULL,
    "societyId" UUID NOT NULL,
    "financialYear" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "payload" JSONB NOT NULL,
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AnnualReturn_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "MassBalance" (
    "id" UUID NOT NULL,
    "ulbId" UUID NOT NULL,
    "societyId" UUID NOT NULL,
    "period" TEXT NOT NULL,
    "stream" "Stream" NOT NULL,
    "collectedKg" DECIMAL(12,3) NOT NULL,
    "handedOverKg" DECIMAL(12,3) NOT NULL,
    "processedKg" DECIMAL(12,3) NOT NULL,
    "variancePct" DOUBLE PRECISION,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "MassBalance_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AuditLog" (
    "id" UUID NOT NULL,
    "ulbId" UUID NOT NULL,
    "actorId" UUID NOT NULL,
    "action" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "ip" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Notification" (
    "id" UUID NOT NULL,
    "ulbId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "channel" TEXT NOT NULL DEFAULT 'IN_APP',
    "template" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "scheduledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMP(3),
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "NotificationAttempt" (
    "id" UUID NOT NULL,
    "ulbId" UUID NOT NULL,
    "notificationId" UUID NOT NULL,
    "status" TEXT NOT NULL,
    "detail" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "NotificationAttempt_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "OutboundMessage" (
    "id" UUID NOT NULL,
    "ulbId" UUID NOT NULL,
    "channel" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'NOT_CONFIGURED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "OutboundMessage_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PrivacyRequest" (
    "id" UUID NOT NULL,
    "ulbId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'REQUESTED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PrivacyRequest_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Ulb_code_key" ON "Ulb"("code");
CREATE UNIQUE INDEX "Ward_ulbId_code_key" ON "Ward"("ulbId", "code");
CREATE INDEX "Ward_ulbId_idx" ON "Ward"("ulbId");
CREATE INDEX "Society_ulbId_wardId_idx" ON "Society"("ulbId", "wardId");
CREATE UNIQUE INDEX "Property_societyId_block_unitNo_key" ON "Property"("societyId", "block", "unitNo");
CREATE UNIQUE INDEX "Property_ulbId_propertyCode_key" ON "Property"("ulbId", "propertyCode");
CREATE INDEX "Property_ulbId_societyId_status_idx" ON "Property"("ulbId", "societyId", "status");
CREATE UNIQUE INDEX "User_phone_key" ON "User"("phone");
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");
CREATE INDEX "Membership_userId_status_idx" ON "Membership"("userId", "status");
CREATE INDEX "Membership_ulbId_societyId_idx" ON "Membership"("ulbId", "societyId");
CREATE UNIQUE INDEX "Resident_userId_propertyId_key" ON "Resident"("userId", "propertyId");
CREATE INDEX "Resident_ulbId_propertyId_idx" ON "Resident"("ulbId", "propertyId");
CREATE UNIQUE INDEX "OtpChallenge_phone_key" ON "OtpChallenge"("phone");
CREATE UNIQUE INDEX "RefreshToken_tokenHash_key" ON "RefreshToken"("tokenHash");
CREATE INDEX "RefreshToken_familyId_idx" ON "RefreshToken"("familyId");
CREATE INDEX "RefreshToken_userId_idx" ON "RefreshToken"("userId");
CREATE UNIQUE INDEX "Contractor_ulbId_contractNo_key" ON "Contractor"("ulbId", "contractNo");
CREATE UNIQUE INDEX "Collector_ulbId_userId_key" ON "Collector"("ulbId", "userId");
CREATE INDEX "Collector_ulbId_contractorId_idx" ON "Collector"("ulbId", "contractorId");
CREATE UNIQUE INDEX "Vehicle_ulbId_registrationNo_key" ON "Vehicle"("ulbId", "registrationNo");
CREATE INDEX "Vendor_ulbId_societyId_idx" ON "Vendor"("ulbId", "societyId");
CREATE INDEX "Schedule_ulbId_societyId_active_idx" ON "Schedule"("ulbId", "societyId", "active");
CREATE INDEX "Route_ulbId_collectorId_date_idx" ON "Route"("ulbId", "collectorId", "date");
CREATE UNIQUE INDEX "RouteStop_routeId_propertyId_key" ON "RouteStop"("routeId", "propertyId");
CREATE UNIQUE INDEX "RouteStop_routeId_sequence_key" ON "RouteStop"("routeId", "sequence");
CREATE INDEX "RouteStop_ulbId_propertyId_windowStart_idx" ON "RouteStop"("ulbId", "propertyId", "windowStart");
CREATE UNIQUE INDEX "Device_ulbId_deviceId_key" ON "Device"("ulbId", "deviceId");
CREATE INDEX "Device_ulbId_collectorId_idx" ON "Device"("ulbId", "collectorId");
CREATE UNIQUE INDEX "PickupEvent_ulbId_clientUuid_key" ON "PickupEvent"("ulbId", "clientUuid");
CREATE INDEX "PickupEvent_ulbId_societyId_capturedAt_status_idx" ON "PickupEvent"("ulbId", "societyId", "capturedAt", "status");
CREATE INDEX "PickupEvent_ulbId_routeStopId_idx" ON "PickupEvent"("ulbId", "routeStopId");
CREATE INDEX "PickupEvent_ulbId_collectorId_receivedAt_idx" ON "PickupEvent"("ulbId", "collectorId", "receivedAt");
CREATE UNIQUE INDEX "PickupStream_pickupEventId_stream_key" ON "PickupStream"("pickupEventId", "stream");
CREATE INDEX "PickupStream_ulbId_stream_idx" ON "PickupStream"("ulbId", "stream");
CREATE UNIQUE INDEX "Photo_storageKey_key" ON "Photo"("storageKey");
CREATE INDEX "Photo_ulbId_clientUuid_ownerId_idx" ON "Photo"("ulbId", "clientUuid", "ownerId");
CREATE INDEX "Photo_ulbId_propertyId_sha256_claimedAt_idx" ON "Photo"("ulbId", "propertyId", "sha256", "claimedAt");
CREATE UNIQUE INDEX "Upload_storageKey_key" ON "Upload"("storageKey");
CREATE INDEX "Upload_ulbId_ownerId_idx" ON "Upload"("ulbId", "ownerId");
CREATE UNIQUE INDEX "PickupException_pickupEventId_key" ON "PickupException"("pickupEventId");
CREATE INDEX "PickupException_ulbId_idx" ON "PickupException"("ulbId");
CREATE UNIQUE INDEX "IdempotencyKey_ulbId_actorId_operation_key_key" ON "IdempotencyKey"("ulbId", "actorId", "operation", "key");
CREATE UNIQUE INDEX "RejectedSubmission_ulbId_clientUuid_key" ON "RejectedSubmission"("ulbId", "clientUuid");
CREATE UNIQUE INDEX "ComplaintCategory_ulbId_name_key" ON "ComplaintCategory"("ulbId", "name");
CREATE INDEX "Complaint_ulbId_societyId_status_slaDueAt_idx" ON "Complaint"("ulbId", "societyId", "status", "slaDueAt");
CREATE INDEX "Complaint_ulbId_residentId_idx" ON "Complaint"("ulbId", "residentId");
CREATE INDEX "ComplaintEvent_ulbId_complaintId_idx" ON "ComplaintEvent"("ulbId", "complaintId");
CREATE UNIQUE INDEX "Rating_pickupEventId_residentId_key" ON "Rating"("pickupEventId", "residentId");
CREATE INDEX "Rating_ulbId_idx" ON "Rating"("ulbId");
CREATE UNIQUE INDEX "Invoice_ulbId_societyId_periodStart_key" ON "Invoice"("ulbId", "societyId", "periodStart");
CREATE INDEX "InvoiceLine_ulbId_invoiceId_idx" ON "InvoiceLine"("ulbId", "invoiceId");
CREATE UNIQUE INDEX "Payment_ulbId_reference_key" ON "Payment"("ulbId", "reference");
CREATE INDEX "InvoiceDispute_ulbId_invoiceId_idx" ON "InvoiceDispute"("ulbId", "invoiceId");
CREATE INDEX "ComplianceDocument_ulbId_societyId_idx" ON "ComplianceDocument"("ulbId", "societyId");
CREATE UNIQUE INDEX "EbwgrCertificate_ulbId_certificateNo_key" ON "EbwgrCertificate"("ulbId", "certificateNo");
CREATE INDEX "EbwgrCertificate_ulbId_societyId_validUntil_idx" ON "EbwgrCertificate"("ulbId", "societyId", "validUntil");
CREATE UNIQUE INDEX "Handover_ulbId_vendorId_receiptNo_key" ON "Handover"("ulbId", "vendorId", "receiptNo");
CREATE INDEX "Handover_ulbId_societyId_date_idx" ON "Handover"("ulbId", "societyId", "date");
CREATE INDEX "OnsiteLog_ulbId_societyId_date_idx" ON "OnsiteLog"("ulbId", "societyId", "date");
CREATE UNIQUE INDEX "AnnualReturn_ulbId_societyId_financialYear_key" ON "AnnualReturn"("ulbId", "societyId", "financialYear");
CREATE UNIQUE INDEX "MassBalance_ulbId_societyId_period_stream_key" ON "MassBalance"("ulbId", "societyId", "period", "stream");
CREATE INDEX "AuditLog_ulbId_createdAt_idx" ON "AuditLog"("ulbId", "createdAt");
CREATE UNIQUE INDEX "Notification_dedupeKey_key" ON "Notification"("dedupeKey");
CREATE INDEX "Notification_status_scheduledAt_idx" ON "Notification"("status", "scheduledAt");
CREATE INDEX "Notification_ulbId_userId_idx" ON "Notification"("ulbId", "userId");
CREATE INDEX "NotificationAttempt_ulbId_notificationId_idx" ON "NotificationAttempt"("ulbId", "notificationId");
CREATE INDEX "OutboundMessage_ulbId_channel_idx" ON "OutboundMessage"("ulbId", "channel");
CREATE INDEX "PrivacyRequest_ulbId_userId_idx" ON "PrivacyRequest"("ulbId", "userId");

ALTER TABLE "Ward" ADD CONSTRAINT "Ward_ulbId_fkey" FOREIGN KEY ("ulbId") REFERENCES "Ulb"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Society" ADD CONSTRAINT "Society_ulbId_fkey" FOREIGN KEY ("ulbId") REFERENCES "Ulb"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Society" ADD CONSTRAINT "Society_wardId_fkey" FOREIGN KEY ("wardId") REFERENCES "Ward"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Property" ADD CONSTRAINT "Property_societyId_fkey" FOREIGN KEY ("societyId") REFERENCES "Society"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Membership" ADD CONSTRAINT "Membership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Membership" ADD CONSTRAINT "Membership_ulbId_fkey" FOREIGN KEY ("ulbId") REFERENCES "Ulb"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Resident" ADD CONSTRAINT "Resident_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Resident" ADD CONSTRAINT "Resident_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "Property"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Collector" ADD CONSTRAINT "Collector_contractorId_fkey" FOREIGN KEY ("contractorId") REFERENCES "Contractor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RouteStop" ADD CONSTRAINT "RouteStop_routeId_fkey" FOREIGN KEY ("routeId") REFERENCES "Route"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RouteStop" ADD CONSTRAINT "RouteStop_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "Property"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PickupStream" ADD CONSTRAINT "PickupStream_pickupEventId_fkey" FOREIGN KEY ("pickupEventId") REFERENCES "PickupEvent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ComplaintEvent" ADD CONSTRAINT "ComplaintEvent_complaintId_fkey" FOREIGN KEY ("complaintId") REFERENCES "Complaint"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "InvoiceLine" ADD CONSTRAINT "InvoiceLine_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "NotificationAttempt" ADD CONSTRAINT "NotificationAttempt_notificationId_fkey" FOREIGN KEY ("notificationId") REFERENCES "Notification"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

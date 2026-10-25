-- Deferred tenant consistency checks protect scalar operational references as
-- well as the repository's predicates. Deferral permits event/photo/outbox
-- creation in one transaction without weakening the committed-state invariant.
CREATE FUNCTION enforce_operational_tenant() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  row_json jsonb := to_jsonb(NEW);
  tenant uuid := (row_json ->> 'ulbId')::uuid;
  reference jsonb;
  reference_id uuid;
  present boolean;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "Ulb" WHERE id = tenant) THEN
    RAISE EXCEPTION 'Unknown operational tenant' USING ERRCODE = '23503';
  END IF;
  FOR reference IN SELECT value FROM jsonb_array_elements(TG_ARGV[0]::jsonb)
  LOOP
    reference_id := NULLIF(row_json ->> (reference ->> 0), '')::uuid;
    IF reference_id IS NOT NULL THEN
      EXECUTE format('SELECT EXISTS (SELECT 1 FROM %I WHERE id = $1 AND "ulbId" = $2)', reference ->> 1)
        INTO present USING reference_id, tenant;
      IF NOT present THEN
        RAISE EXCEPTION 'Operational reference must belong to the same tenant: %.%', TG_TABLE_NAME, reference ->> 0 USING ERRCODE = '23503';
      END IF;
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$;

DO $$
DECLARE
  entry record;
BEGIN
  FOR entry IN SELECT * FROM (VALUES
    ('Ward', '[]'),
    ('Society', '[["wardId","Ward"]]'),
    ('Property', '[["societyId","Society"]]'),
    ('Membership', '[["societyId","Society"],["contractorId","Contractor"]]'),
    ('Resident', '[["propertyId","Property"]]'),
    ('Contractor', '[]'),
    ('Collector', '[["contractorId","Contractor"]]'),
    ('Vehicle', '[["contractorId","Contractor"]]'),
    ('Vendor', '[["societyId","Society"],["contractorId","Contractor"],["documentId","ComplianceDocument"]]'),
    ('Schedule', '[["societyId","Society"]]'),
    ('Route', '[["wardId","Ward"],["contractorId","Contractor"],["collectorId","Collector"],["vehicleId","Vehicle"]]'),
    ('RouteStop', '[["routeId","Route"],["propertyId","Property"]]'),
    ('Device', '[["collectorId","Collector"]]'),
    ('PickupEvent', '[["societyId","Society"],["propertyId","Property"],["collectorId","Collector"],["routeStopId","RouteStop"]]'),
    ('PickupStream', '[["pickupEventId","PickupEvent"],["photoId","Photo"]]'),
    ('Photo', '[["propertyId","Property"],["pickupEventId","PickupEvent"]]'),
    ('Upload', '[]'),
    ('PickupException', '[["pickupEventId","PickupEvent"],["photoId","Photo"]]'),
    ('IdempotencyKey', '[]'),
    ('RejectedSubmission', '[]'),
    ('ComplaintCategory', '[]'),
    ('Complaint', '[["societyId","Society"],["propertyId","Property"],["pickupEventId","PickupEvent"],["categoryId","ComplaintCategory"],["photoId","Photo"],["resolutionPhotoId","Photo"]]'),
    ('ComplaintEvent', '[["complaintId","Complaint"]]'),
    ('Rating', '[["pickupEventId","PickupEvent"]]'),
    ('Invoice', '[["societyId","Society"]]'),
    ('InvoiceLine', '[["invoiceId","Invoice"]]'),
    ('Payment', '[["invoiceId","Invoice"]]'),
    ('InvoiceDispute', '[["invoiceId","Invoice"],["lineId","InvoiceLine"]]'),
    ('ComplianceDocument', '[["societyId","Society"],["photoId","Photo"],["uploadId","Upload"]]'),
    ('EbwgrCertificate', '[["societyId","Society"],["documentId","ComplianceDocument"]]'),
    ('Handover', '[["societyId","Society"],["vendorId","Vendor"],["documentId","ComplianceDocument"]]'),
    ('OnsiteLog', '[["societyId","Society"],["photoId","Photo"]]'),
    ('AnnualReturn', '[["societyId","Society"]]'),
    ('MassBalance', '[["societyId","Society"]]'),
    ('AuditLog', '[]'),
    ('Notification', '[]'),
    ('NotificationAttempt', '[["notificationId","Notification"]]'),
    ('OutboundMessage', '[]'),
    ('PrivacyRequest', '[]')
  ) AS mapping(table_name, refs)
  LOOP
    EXECUTE format('CREATE CONSTRAINT TRIGGER %I AFTER INSERT OR UPDATE ON %I DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION enforce_operational_tenant(%L)', entry.table_name || '_tenant_consistency', entry.table_name, entry.refs);
  END LOOP;
END;
$$;

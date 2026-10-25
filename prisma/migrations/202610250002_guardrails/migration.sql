-- PostgreSQL constraints complement the membership-scoped repository layer.
ALTER TABLE "PickupStream" ADD CONSTRAINT "PickupStream_positive_kg" CHECK (kg > 0);
ALTER TABLE "PickupEvent" ADD CONSTRAINT "PickupEvent_score_range" CHECK ("verificationScore" BETWEEN 0 AND 100);
ALTER TABLE "Property" ADD CONSTRAINT "Property_six_digit_code" CHECK ("propertyCode" ~ '^[0-9]{6}$');
ALTER TABLE "Property" ADD CONSTRAINT "Property_coordinates" CHECK (latitude BETWEEN -90 AND 90 AND longitude BETWEEN -180 AND 180);
ALTER TABLE "OtpChallenge" ADD CONSTRAINT "OtpChallenge_attempts_range" CHECK (attempts BETWEEN 0 AND 5);
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_positive_amount" CHECK ("amountPaise" > 0);
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_valid_totals" CHECK ("totalPaise" >= 0 AND "subtotalPaise" >= 0 AND "deductionsPaise" >= 0 AND "totalPaise" = "subtotalPaise" - "deductionsPaise");
ALTER TABLE "Rating" ADD CONSTRAINT "Rating_dimensions" CHECK (punctuality BETWEEN 1 AND 5 AND quality BETWEEN 1 AND 5 AND guidance BETWEEN 1 AND 5);
ALTER TABLE "ComplaintCategory" ADD CONSTRAINT "ComplaintCategory_positive_sla" CHECK ("slaHours" > 0);
ALTER TABLE "EbwgrCertificate" ADD CONSTRAINT "Certificate_valid_quantity_dates" CHECK (kg > 0 AND "validUntil" >= "issuedAt");
ALTER TABLE "Handover" ADD CONSTRAINT "Handover_positive_kg" CHECK (kg > 0);
ALTER TABLE "OnsiteLog" ADD CONSTRAINT "OnsiteLog_plausible_quantities" CHECK ("inputKg" > 0 AND "outputKg" >= 0 AND "outputKg" <= "inputKg" AND "inputKg" <= "capacityKg");
ALTER TABLE "RouteStop" ADD CONSTRAINT "RouteStop_window_order" CHECK ("windowEnd" > "windowStart");

-- Only one accepted weighed collection may complete a scheduled stop.
CREATE UNIQUE INDEX "PickupEvent_one_verified_stop" ON "PickupEvent" ("ulbId", "routeStopId") WHERE status = 'VERIFIED' AND "exceptionCode" IS NULL;

CREATE FUNCTION prevent_audit_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Audit and complaint history is append-only' USING ERRCODE = '42501';
END;
$$;
CREATE TRIGGER "AuditLog_append_only" BEFORE UPDATE OR DELETE ON "AuditLog" FOR EACH ROW EXECUTE FUNCTION prevent_audit_mutation();
CREATE TRIGGER "ComplaintEvent_append_only" BEFORE UPDATE OR DELETE ON "ComplaintEvent" FOR EACH ROW EXECUTE FUNCTION prevent_audit_mutation();

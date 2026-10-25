'use client';
import { useState } from 'react';
import { Panel, Table } from '@swachh/ui';
import { display, record, rows, text, type Row } from '@/lib/data';
import { useI18n } from '@/lib/i18n';
import { useScope } from './providers';
import { ActionForm, DataTable, DownloadButton, Notice, QueryRecord, RecordView, SectionHeading, Status, field, streamOptions } from './operations';
import { Metrics } from './dashboard';

export function CertificateRegister() {
  const { t } = useI18n(); const { role, society, ulb } = useScope(); const isUlb = ['ULB_ADMIN', 'SUPER_ADMIN'].includes(role);
  const path = isUlb ? `${ulb}/certificates` : `${society}/compliance/certificates`;
  return <div className="section-stack"><Notice>{t('legalNotice')}</Notice>
    <DataTable path={path} title="certificates" columns={[
      { key: 'certificateNo', label: 'certificateNo' }, { key: 'societyId', label: 'societyId' }, { key: 'stream', label: 'stream', format: 'status' },
      { key: 'kg', label: 'kg' }, { key: 'issuedAt', label: 'issuedAt', format: 'date' }, { key: 'validUntil', label: 'validUntil', format: 'date' }, { key: 'status', label: 'status', format: 'status' },
    ]} actions={isUlb && <ActionForm title="recordCertificate" variant="primary" path={path} fields={[
      field('societyId', 'societyId', { source: `${ulb}/societies` }), field('certificateNo', 'certificateNo'), field('stream', 'stream', { type: 'select', options: streamOptions }),
      field('kg', 'kg', { type: 'number', min: 0.001, step: '0.001' }), field('issuedAt', 'issuedAt', { type: 'date' }), field('validUntil', 'validUntil', { type: 'date', required: false }), field('documentId', 'document'),
    ]} />} />
  </div>;
}

function ComplianceSummary({ data }: { data: Row }) {
  const { t } = useI18n(); const coverage = record(data.certificateCoverage); const balance = record(data.massBalance);
  return <>
    <Metrics data={{ metrics: { certificateCoveragePct: { value: coverage.coveragePct, unit: '%', definition: coverage.definition, provenance: coverage.provenance, sourceIds: coverage.obligationSourceIds }, recyclingRatePct: balance.recyclingRate } }} />
    <div className="settings-grid"><Panel className="padded"><h3>{t('eligibility')}</h3><Status value="SELF_REPORTED" /><RecordView value={data.eligibility} /></Panel><Panel className="padded"><h3>{t('registration')}</h3><RecordView value={data.registration} /></Panel></div>
    <Panel><div className="panel-toolbar"><h3>{t('certificateCoveragePct')}</h3><Status value={coverage.provenance} /></div><Table caption={t('certificates')} rows={Object.entries(record(coverage.byStream)).map<Row>(([stream, value]) => ({ stream, ...record(value) }))} rowKey={row => text(row.stream)} columns={[
      { key: 'stream', label: t('stream'), render: row => t(text(row.stream)) }, { key: 'requiredKg', label: t('requiredKg'), render: row => `${display(row.requiredKg)} kg` },
      { key: 'heldKg', label: t('heldKg'), render: row => `${display(row.heldKg)} kg` }, { key: 'gapKg', label: t('certificateGapKg'), render: row => `${display(row.gapKg)} kg` },
      { key: 'coveragePct', label: t('certificateCoveragePct'), render: row => row.coveragePct === null ? t('NOT_MEASURED') : `${display(row.coveragePct)} %` },
    ]} /></Panel>
    <Panel className="padded"><h3>{t('massBalance')}</h3><div className="metrics-grid">{['collected', 'handedOver', 'processed'].map(key => <div key={key}><p>{t(key)}</p><strong>{display(record(balance[key]).kg)} kg</strong><p><Status value={record(balance[key]).provenance} /></p></div>)}</div><RecordView value={{ handoverVariancePct: balance.handoverVariancePct, processingVariancePct: balance.processingVariancePct, variancePct: balance.variancePct, requiresReview: balance.requiresReview }} /></Panel>
    <Notice>{t('recyclingNotice')}</Notice>
  </>;
}

export function Compliance() {
  const { t } = useI18n(); const { society } = useScope(); const [tab, setTab] = useState('summary'); const [result, setResult] = useState<Row | null>(null); const [annual, setAnnual] = useState('');
  const root = `${society}/compliance`; const documents = { source: `${root}/documents`, optionLabel: 'number' };
  return <div className="section-stack">
    <SectionHeading title={t('compliance')} detail={t('legalNotice')} actions={<DownloadButton path={`${root}/inspection-pack.pdf`} filename="inspection-pack.pdf" label="inspectionPack" />} />
    <div className="tabs">{['summary', 'vault', 'certificates', 'handovers', 'processing', 'monthlyLog', 'annualReturn'].map(value => <button key={value} className={tab === value ? 'selected' : ''} onClick={() => setTab(value)}>{t(value)}</button>)}</div>
    {tab === 'summary' && <>
      <QueryRecord path={`${root}/summary`}>{data => <ComplianceSummary data={data} />}</QueryRecord>
      <Panel className="padded"><SectionHeading title={t('eligibility')} actions={<ActionForm title="eligibility" path={`${root}/eligibility`} fields={[
        field('floorAreaSqm', 'floorArea', { type: 'number', min: 0 }), field('waterLitresPerDay', 'water', { type: 'number', min: 0 }), field('wasteKgPerDay', 'waste', { type: 'number', min: 0 }), field('flats', 'flats', { type: 'number', min: 0, step: '1' }),
      ]} onSuccess={value => setResult(record(value))} />} />{result && <RecordView value={result} />}</Panel>
      <Panel className="padded"><SectionHeading title={t('registration')} actions={<ActionForm title="registration" path={`${root}/registration`} method="PATCH" fields={[
        field('cpcbStatus', 'cpcbStatus', { type: 'select', options: ['NOT_STARTED', 'PENDING', 'REGISTERED'].map(value => ({ value, label: value })) }), field('registrationNumber', 'registrationNo'), field('registeredAt', 'issuedAt', { type: 'date' }), field('renewalDate', 'renewal', { type: 'date' }), field('documentId', 'document', documents),
      ]} />} /></Panel>
    </>}
    {tab === 'vault' && <DataTable path={`${root}/documents`} title="vault" columns={[
      { key: 'type', label: 'type' }, { key: 'number', label: 'number' }, { key: 'id', label: 'id' }, { key: 'issuedBy', label: 'issuedBy' }, { key: 'validUntil', label: 'validUntil', format: 'date' }, { key: 'status', label: 'status', format: 'status' },
    ]} actions={<ActionForm title="uploadDocument" path={`${root}/documents`} fields={[
      field('type', 'type'), field('number', 'number'), field('issuedBy', 'issuedBy'), field('issuedAt', 'issuedAt', { type: 'date' }), field('validUntil', 'validUntil', { type: 'date', required: false }), field('storageKey', 'document', { type: 'file', purpose: 'DOCUMENT' }),
    ]} />} rowActions={row => <DownloadButton path={`${root}/documents/${text(row.id)}/download`} filename={`document-${text(row.number)}`} signed />} />}
    {tab === 'certificates' && <CertificateRegister />}
    {tab === 'handovers' && <><Notice>{t('recyclingNotice')}</Notice><DataTable path={`${root}/handovers`} title="handovers" columns={[
      { key: 'date', label: 'date', format: 'date' }, { key: 'vendorId', label: 'vendorId' }, { key: 'stream', label: 'stream', format: 'status' }, { key: 'kg', label: 'kg' }, { key: 'receiptNo', label: 'receiptNo' }, { key: 'destination', label: 'destination' },
      { key: 'verifiedAt', label: 'provenance', render: row => <Status value={row.verifiedAt ? 'VERIFIED' : 'SELF_REPORTED'} /> },
    ]} actions={<ActionForm title="addHandover" path={`${root}/handovers`} fields={[
      field('date', 'date', { type: 'date' }), field('vendorId', 'vendorId', { source: `${society}/vendors` }), field('stream', 'stream', { type: 'select', options: streamOptions }), field('kg', 'kg', { type: 'number', min: 0.001, step: '0.001' }), field('receiptNumber', 'receiptNo'), field('documentId', 'document', documents), field('destination', 'destination'),
    ]} />} /></>}
    {tab === 'processing' && <DataTable path={`${root}/onsite-logs`} title="processing" columns={[
      { key: 'date', label: 'date', format: 'date' }, { key: 'asset', label: 'asset' }, { key: 'capacityKg', label: 'capacity' }, { key: 'inputKg', label: 'inputKg' }, { key: 'outputKg', label: 'outputKg' }, { key: 'downtime', label: 'downtime' }, { key: 'provenance', label: 'provenance', render: () => <Status value="SELF_REPORTED" /> },
    ]} actions={<ActionForm title="addProcessing" path={`${root}/onsite-logs`} fields={[
      field('asset', 'asset'), field('capacityKg', 'capacity', { type: 'number', min: 0.001, step: '0.001' }), field('date', 'date', { type: 'date' }), field('inputKg', 'inputKg', { type: 'number', min: 0.001, step: '0.001' }), field('outputKg', 'outputKg', { type: 'number', min: 0, step: '0.001' }), field('downtime', 'downtime', { required: false }), field('photoId', 'photo', { type: 'file', purpose: 'PROCESSING', accept: 'image/jpeg,image/png,image/webp' }),
    ]} />} />}
    {tab === 'monthlyLog' && <DataTable path={`${root}/monthly-log`} title="monthlyLog" columns={[
      { key: 'capturedAt', label: 'date', format: 'date' }, { key: 'propertyId', label: 'propertyId' }, { key: 'collectorId', label: 'collectorId' }, { key: 'streams', label: 'weights', render: row => rows(row.streams).map(stream => <p key={text(stream.stream)}>{t(text(stream.stream))}: {text(stream.kg)} kg</p>) }, { key: 'provenance', label: 'provenance', format: 'status' },
    ]} />}
    {tab === 'annualReturn' && <>
      <Notice>{t('draftNotice')}</Notice>
      <Panel className="padded"><div className="button-row"><ActionForm title="generateReturn" variant="primary" path={`${root}/annual-return`} idempotent fields={[field('financialYearStart', 'financialYear', { type: 'number', min: 2000, max: 2200, step: '1' })]} onSuccess={value => setAnnual(text(record(value).id))} />{annual && <><DownloadButton path={`${root}/annual-return/${annual}.pdf`} filename="annual-return-draft.pdf" label="annualPdf" /><DownloadButton path={`${root}/annual-return/${annual}`} filename="annual-return-draft.json" /></>}</div></Panel>
      <DataTable path={`${root}/annual-returns`} title="annualReturn" columns={[{ key: 'financialYear', label: 'financialYear' }, { key: 'status', label: 'status', format: 'status' }, { key: 'generatedAt', label: 'date', format: 'date' }]} rowActions={row => <div className="button-row"><DownloadButton path={`${root}/annual-return/${text(row.id)}.pdf`} filename="annual-return-draft.pdf" label="annualPdf" /><DownloadButton path={`${root}/annual-return/${text(row.id)}`} filename="annual-return-draft.json" /></div>} />
    </>}
  </div>;
}

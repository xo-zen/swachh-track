'use client';
import dynamic from 'next/dynamic';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { EmptyState, ErrorState, LoadingState, Panel, Table } from '@swachh/ui';
import { api, errorMessage } from '@/lib/api';
import { endpoint, number, record, rows, text, type Row } from '@/lib/data';
import { useI18n } from '@/lib/i18n';
import { useScope } from './providers';
import { ActionForm, DataTable, DownloadButton, ListFilter, Notice, QueryRecord, SectionHeading, Status, field } from './operations';

const CivicMap = dynamic(() => import('./civic-map'), { ssr: false });

export function RegistryMap() {
  const { t } = useI18n(); const { ulb, membership } = useScope(); const [measurement, setMeasurement] = useState('coveragePct');
  const societies = useQuery({ queryKey: [membership?.id, 'map-societies'], queryFn: ({ signal }) => api.all(`${ulb}/societies`, signal) });
  const wards = useQuery({ queryKey: [membership?.id, 'map-wards'], queryFn: ({ signal }) => api.all(`${ulb}/wards`, signal) });
  const dashboard = useQuery({ queryKey: [membership?.id, `${ulb}/dashboard`], queryFn: ({ signal }) => api.json<Row>(`${ulb}/dashboard`, { signal }) });
  const mapWards = (wards.data ?? []).map<Row>(ward => {
    const values = rows(dashboard.data?.wards).find(item => item.id === ward.id);
    const metric = record(record(values?.metrics)[measurement]);
    return { ...ward, coveragePct: metric.value, metric };
  });
  return <div className="section-stack">
    <SectionHeading title={t('registry')} detail={t('liveData')} />
    <div className="filters"><label>{t('heatmap')}<select value={measurement} onChange={event => setMeasurement(event.target.value)}><option value="coveragePct">{t('coveragePct')}</option><option value="missedPct">{t('missedPct')}</option></select></label></div>
    <Notice>{t('noBoundary')}</Notice>
    {dashboard.error && <ErrorState message={errorMessage(dashboard.error)} retry={() => void dashboard.refetch()} retryLabel={t('retry')} />}
    <Panel className="map-panel">{societies.isPending || wards.isPending ? <LoadingState label={t('loading')} /> : societies.error || wards.error ? <ErrorState message={errorMessage(societies.error || wards.error)} retry={() => { void societies.refetch(); void wards.refetch(); }} retryLabel={t('retry')} /> : <CivicMap societies={societies.data ?? []} wards={mapWards} reverseScale={measurement === 'missedPct'} />}</Panel>
    {mapWards.length > 0 && <Panel><Table caption={t('heatmap')} rows={mapWards} rowKey={row => text(row.id)} columns={[
      { key: 'name', label: t('wards'), render: row => text(row.name) },
      { key: 'value', label: t(measurement), render: row => number(row.coveragePct) === null ? t('NOT_MEASURED') : `${number(row.coveragePct)?.toFixed(2)} %` },
      { key: 'provenance', label: t('provenance'), render: row => <Status value={record(row.metric).provenance} /> },
      { key: 'definition', label: t('definition'), render: row => text(record(row.metric).definition) || t('NOT_MEASURED') },
    ]} /></Panel>}
    <DataTable path={`${ulb}/wards`} title="wards" columns={[{ key: 'name', label: 'name' }, { key: 'code', label: 'number' }, { key: 'id', label: 'wardId' }]} actions={<ActionForm title="createWard" path={`${ulb}/wards`} fields={[field('name', 'name'), field('code', 'code')]} />} />
    <DataTable path={`${ulb}/societies`} title="societies" columns={[{ key: 'name', label: 'name' }, { key: 'ward.name', label: 'wards' }, { key: 'address', label: 'address' }, { key: 'latitude', label: 'latitude' }, { key: 'longitude', label: 'longitude' }]} actions={<ActionForm title="createSociety" path={`${ulb}/societies`} fields={[
      field('name', 'name'), field('wardId', 'wardId', { source: `${ulb}/wards` }), field('address', 'address'), field('latitude', 'latitude', { type: 'number', min: -90, max: 90 }), field('longitude', 'longitude', { type: 'number', min: -180, max: 180 }), field('floorAreaSqm', 'floorArea', { type: 'number', min: 0 }), field('waterLpd', 'water', { type: 'number', min: 0 }), field('wasteKgDay', 'waste', { type: 'number', min: 0 }),
    ]} />} />
  </div>;
}

export function Contractors() {
  const { t } = useI18n(); const { ulb } = useScope(); const [contractor, setContractor] = useState('');
  return <div className="section-stack"><SectionHeading title={t('scorecards')} />
    <div className="filters"><ListFilter path={`${ulb}/contractors`} label="contractors" value={contractor} onChange={setContractor} /></div>
    <QueryRecord path={endpoint(`${ulb}/dashboard`, { contractorId: contractor || undefined })}>{data => rows(data.contractors).length ? <Panel><Table caption={t('scorecards')} rows={rows(data.contractors)} rowKey={row => text(row.id)} columns={[
      { key: 'name', label: t('name'), render: row => text(row.name) },
      ...['coveragePct', 'onTimePct', 'openComplaints', 'contaminationPct', 'unresolvedExceptions'].map(key => ({ key, label: t(key), render: (row: Row) => {
        const metric = record(record(row.metrics)[key]);
        return <><strong>{metric.provenance === 'NOT_MEASURED' || number(metric.value) === null ? t('NOT_MEASURED') : number(metric.value)?.toLocaleString('en-IN', { maximumFractionDigits: 2 })} {t(text(metric.unit))}</strong><p><Status value={metric.provenance} /></p><details><summary>{t('definition')}</summary><p>{text(metric.definition)}</p></details></>;
      } })),
    ]} /></Panel> : <EmptyState title={t('empty')} detail={t('emptyDetail')} />}</QueryRecord>
    <Notice>{t('provenanceDetail')}</Notice>
  </div>;
}

export function Audit() {
  const { t } = useI18n(); const { ulb } = useScope();
  return <div className="section-stack"><SectionHeading title={t('audit')} detail={t('auditNotice')} /><DataTable path={`${ulb}/audit-log`} title="audit" columns={[{ key: 'createdAt', label: 'date', format: 'date' }, { key: 'actorId', label: 'actor' }, { key: 'action', label: 'action' }, { key: 'entity', label: 'entity' }, { key: 'entityId', label: 'id' }, { key: 'after', label: 'detail', render: row => <details><summary>{t('detail')}</summary><pre className="json-detail">{JSON.stringify({ before: row.before, after: row.after }, null, 2)}</pre></details> }]} /></div>;
}

export function Exports() {
  const { t } = useI18n(); const { ulb } = useScope(); const [type, setType] = useState('pickups'); const [from, setFrom] = useState(''); const [to, setTo] = useState(''); const [ward, setWard] = useState(''); const [contractor, setContractor] = useState('');
  const params = { from: from ? new Date(`${from}T00:00:00+05:30`).toISOString() : undefined, to: to ? new Date(`${to}T23:59:59+05:30`).toISOString() : undefined, wardId: ward, contractorId: contractor };
  return <div className="section-stack"><SectionHeading title={t('exports')} detail={t('checkConnection')} /><Panel className="padded"><div className="form-grid">
    <label>{t('exportType')}<select value={type} onChange={event => setType(event.target.value)}>{['pickups', 'complaints', 'invoices', 'payments', 'certificates', 'accounts'].map(value => <option key={value} value={value}>{t(value)}</option>)}</select></label>
    <label>{t('from')}<input type="date" value={from} onChange={event => setFrom(event.target.value)} /></label><label>{t('to')}<input type="date" value={to} min={from} onChange={event => setTo(event.target.value)} /></label>
    <ListFilter path={`${ulb}/wards`} label="wards" value={ward} onChange={setWard} /><ListFilter path={`${ulb}/contractors`} label="contractors" value={contractor} onChange={setContractor} />
  </div><div className="button-row export-actions"><DownloadButton path={endpoint(`${ulb}/exports/${type}.csv`, params)} filename={`${type}.csv`} label="exportCsv" /><DownloadButton path={endpoint(`${ulb}/exports/${type}.xlsx`, params)} filename={`${type}.xlsx`} label="exportXlsx" /><DownloadButton path={endpoint(`${ulb}/exports/${type}.pdf`, params)} filename={`${type}.pdf`} label="exportPdf" /></div></Panel></div>;
}

'use client';
import { useState } from 'react';
import { Button, Panel } from '@swachh/ui';
import { date, display, record, rows, safeUrl, text, type Row } from '@/lib/data';
import { useI18n } from '@/lib/i18n';
import { useScope } from './providers';
import { ActionForm, DataTable, Modal, Notice, QueryRecord, RecordView, SectionHeading, Status, field } from './operations';

export function PhotoEvidence({ photos }: { photos: Row[] }) {
  const { t } = useI18n();
  return <><p className="small muted">{t('privatePhotos')}</p><div className="evidence-photos">{photos.map((photo, index) => safeUrl(photo.url) ?
    <a key={text(photo.id) || String(index)} href={safeUrl(photo.url)} target="_blank" rel="noreferrer"><img src={safeUrl(photo.url)} alt={`${t('photo')}: ${text(photo.kind)}`} loading="lazy" /><span>{text(photo.kind)}</span></a> :
    <QueryRecord key={text(photo.id) || String(index)} path={`/photos/${encodeURIComponent(text(photo.id) || text(photo.photoId))}`}>{data => safeUrl(data.url) ? <a href={safeUrl(data.url)} target="_blank" rel="noreferrer"><img src={safeUrl(data.url)} alt={t('photo')} loading="lazy" /></a> : <Notice>{t('empty')}</Notice>}</QueryRecord>,
  )}</div></>;
}

export function PickupDetail({ path, review = false }: { path: string; review?: boolean }) {
  const { t } = useI18n(); const { role } = useScope();
  return <QueryRecord path={path}>{data => <div className="section-stack">
    <div className="button-row"><Status value={data.status} /><span>{t('verificationScore')}: {display(data.verificationScore)} / 100</span></div>
    <dl className="record-grid"><div><dt>{t('captured')}</dt><dd>{date(data.capturedAt)}</dd></div><div><dt>{t('received')}</dt><dd>{date(data.receivedAt)}</dd></div><div><dt>{t('propertyId')}</dt><dd>{text(data.propertyId)}</dd></div><div><dt>{t('collectors')}</dt><dd>{text(record(data.collector).name) || text(data.collectorId)}</dd></div><div><dt>{t('reasons')}</dt><dd>{display(data.verificationReasons)}</dd></div></dl>
    <Panel className="padded"><h3>{t('weights')}</h3>{rows(data.streams).map(stream => <div className="stream-line" key={text(stream.id) || text(stream.stream)}><Status value={stream.stream} /><strong>{text(stream.kg)} kg</strong><Status value={stream.segregation} /></div>)}</Panel>
    <PhotoEvidence photos={rows(data.photos)} />
    {Boolean(data.exceptionCode) && <RecordView value={{ exceptionCode: data.exceptionCode, note: data.exceptionNote, accepted: data.exceptionAccepted }} />}
    {role === 'RESIDENT' && data.status === 'VERIFIED' && !data.exceptionCode && <ActionForm title={data.rating ? 'editRating' : 'rate'} method={data.rating ? 'PATCH' : 'POST'} initial={record(data.rating)} path={`/resident/pickups/${text(data.id)}/ratings`} description="ratingRule" fields={[
      field('punctuality', 'punctuality', { type: 'number', min: 1, max: 5, step: '1' }), field('quality', 'quality', { type: 'number', min: 1, max: 5, step: '1' }), field('guidance', 'guidance', { type: 'number', min: 1, max: 5, step: '1' }), field('comment', 'comment', { type: 'textarea', required: false }),
    ]} />}
    {review && data.status === 'NEEDS_REVIEW' && !data.reviewedAt && <div className="button-row">
      <ActionForm title="approve" path={`/supervisor/pickups/${text(data.id)}/review`} body={{ decision: 'APPROVE' }} fields={[field('reason', 'note', { type: 'textarea' })]} />
      <ActionForm title="reject" variant="danger" path={`/supervisor/pickups/${text(data.id)}/review`} body={{ decision: 'REJECT' }} fields={[field('reason', 'note', { type: 'textarea' })]} />
    </div>}
  </div>}</QueryRecord>;
}

export function Pickups({ review = false }: { review?: boolean }) {
  const { t } = useI18n(); const { role, society, ulb } = useScope(); const [selected, setSelected] = useState(''); const [status, setStatus] = useState(review ? 'NEEDS_REVIEW' : '');
  const path = role === 'RESIDENT' ? '/resident/pickups' : role === 'SUPERVISOR' ? '/supervisor/pickups' : role === 'SOCIETY_ADMIN' ? `${society}/pickups` : `${ulb}/pickups`;
  return <div className="section-stack"><SectionHeading title={t(review ? 'review' : 'pickups')} actions={review && <ActionForm title="reassign" description="reassignRule" path={values => `/supervisor/stops/${encodeURIComponent(text(values.stopId))}/reassign`} fields={[field('stopId', 'stopId'), field('routeId', 'routeId'), field('reason', 'note', { type: 'textarea' })]} transform={values => ({ routeId: values.routeId, reason: values.reason })} />} />{review && <Notice>{t('reviewNotice')}</Notice>}
    {!review && <div className="filters"><label>{t('status')}<select value={status} onChange={event => setStatus(event.target.value)}><option value="">{t('all')}</option>{['VERIFIED', 'NEEDS_REVIEW', 'REJECTED'].map(value => <option key={value} value={value}>{t(value)}</option>)}</select></label></div>}
    <DataTable key={status} path={path} title="pickups" filters={{ status }} columns={[
      { key: 'capturedAt', label: 'date', format: 'date' }, { key: 'propertyId', label: 'propertyId' }, { key: 'collectorId', label: 'collectorId' },
      { key: 'streams', label: 'weights', render: row => rows(row.streams).map(stream => <p key={text(stream.stream)}>{t(text(stream.stream))}: {text(stream.kg)} kg</p>) },
      { key: 'verificationScore', label: 'verificationScore' }, { key: 'status', label: 'status', format: 'status' },
    ]} rowActions={row => <Button variant="secondary" onClick={() => setSelected(text(row.id))}>{t('evidence')}</Button>} />
    {selected && <Modal title={t('evidence')} onClose={() => setSelected('')}><PickupDetail path={role === 'RESIDENT' ? `/resident/pickups/${selected}` : ['SUPERVISOR', 'ULB_ADMIN', 'SUPER_ADMIN'].includes(role) ? `/supervisor/pickups/${selected}` : `/pickups/${selected}`} review={review} /></Modal>}
  </div>;
}

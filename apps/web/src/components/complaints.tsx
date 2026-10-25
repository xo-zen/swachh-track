'use client';
import { useEffect, useState } from 'react';
import { Button } from '@swachh/ui';
import { date, record, rows, text, type Row } from '@/lib/data';
import { useI18n } from '@/lib/i18n';
import { useScope } from './providers';
import { ActionForm, DataTable, Modal, Notice, RecordView, SectionHeading, field } from './operations';
import { PhotoEvidence, PickupDetail } from './pickups';

function SlaCountdown({ due, status }: { due: unknown; status: unknown }) {
  const { t } = useI18n(); const [now, setNow] = useState(Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 60_000); return () => clearInterval(timer); }, []);
  const remaining = new Date(text(due)).getTime() - now;
  if (['RESOLVED', 'CLOSED', 'WAITING_FOR_RESIDENT'].includes(text(status))) return <span>{t(text(status))}</span>;
  if (!Number.isFinite(remaining)) return <span>—</span>;
  return <span className={remaining < 0 ? 'sla-breached' : ''}>{remaining < 0 ? `${t('breached')} · ` : ''}{Math.floor(Math.abs(remaining) / 3_600_000)}h {Math.floor(Math.abs(remaining) % 3_600_000 / 60_000)}m</span>;
}

export function Complaints() {
  const { t } = useI18n(); const { role, society, ulb } = useScope(); const [status, setStatus] = useState(''); const [breachOnly, setBreachOnly] = useState(false); const [selected, setSelected] = useState<Row | null>(null);
  const resident = role === 'RESIDENT'; const isUlb = ['ULB_ADMIN', 'SUPER_ADMIN'].includes(role);
  const path = resident ? '/resident/complaints' : isUlb ? `${ulb}/complaints` : role === 'SUPERVISOR' ? '/supervisor/complaints' : `${society}/complaints`;
  return <div className="section-stack">
    <SectionHeading title={t('complaints')} actions={resident && <ActionForm title="raiseComplaint" variant="primary" path="/resident/complaints" fields={[
      field('propertyId', 'propertyId', { source: '/resident/properties', optionLabel: 'unitNo' }), field('categoryId', 'category', { source: '/complaint-categories' }), field('pickupEventId', 'pickupId', { required: false }),
      field('description', 'description', { type: 'textarea' }), field('photoId', 'photo', { type: 'file', accept: 'image/jpeg,image/png,image/webp', purpose: 'COMPLAINT' }),
    ]} />} />
    <Notice>{t(resident ? 'reopenRule' : 'checkConnection')}</Notice>
    <div className="filters"><label>{t('status')}<select value={status} onChange={event => setStatus(event.target.value)}><option value="">{t('all')}</option>{['OPEN', 'ACKNOWLEDGED', 'IN_PROGRESS', 'WAITING_FOR_RESIDENT', 'RESOLVED', 'CLOSED', 'REOPENED'].map(value => <option value={value} key={value}>{t(value)}</option>)}</select></label>{isUlb && <label className="checkbox-label"><input type="checkbox" checked={breachOnly} onChange={event => setBreachOnly(event.target.checked)} />{t('breachOnly')}</label>}</div>
    <DataTable key={`${status}-${breachOnly}`} path={path} title="complaints" filters={{ status, breached: breachOnly ? 'true' : undefined }} columns={[
      { key: 'category', label: 'category', render: row => text(record(row.category).name) || text(row.categoryId) }, { key: 'description', label: 'description' }, { key: 'status', label: 'status', format: 'status' },
      { key: 'slaDueAt', label: 'slaDue', render: row => <><div>{date(row.slaDueAt)}</div><SlaCountdown due={row.slaDueAt} status={row.status} /></> },
    ]} rowActions={row => <div className="button-row">
      <Button variant="secondary" onClick={() => setSelected(row)}>{t('view')}</Button>
      {resident && row.status === 'RESOLVED' && <ActionForm title="reopen" path={`${path}/${text(row.id)}/reopen`} description="reopenRule" fields={[field('note', 'note', { type: 'textarea' })]} />}
      {!resident && !['RESOLVED', 'CLOSED'].includes(text(row.status)) && <>
        <ActionForm title="resolve" path={`/complaints/${text(row.id)}`} method="PATCH" body={{ status: 'RESOLVED' }} fields={[field('note', 'resolution', { type: 'textarea' }), field('photoId', 'resolutionPhoto', { type: 'file', accept: 'image/jpeg,image/png,image/webp', purpose: 'RESOLUTION' })]} />
        <ActionForm title="updateStatus" path={`/complaints/${text(row.id)}`} method="PATCH" fields={[field('status', 'status', { type: 'select', options: ['ACKNOWLEDGED', 'IN_PROGRESS', 'WAITING_FOR_RESIDENT', 'CLOSED'].map(value => ({ value, label: value })) }), field('note', 'note', { type: 'textarea' })]} />
      </>}
      {isUlb && <ActionForm title="escalate" path={`${path}/${text(row.id)}/escalate`} fields={[field('reason', 'note', { type: 'textarea' })]} />}
    </div>} />
    {selected && <Modal title={t('complaintHistory')} onClose={() => setSelected(null)}><div className="section-stack">
      <RecordView value={{ id: selected.id, description: selected.description, status: selected.status, slaDue: date(selected.slaDueAt), resolution: selected.resolutionNote }} />
      {rows(selected.events).map(event => <RecordView key={text(event.id)} value={{ date: date(event.createdAt), status: event.toStatus, note: event.note }} />)}
      {text(selected.photoId) && <PhotoEvidence photos={[{ id: selected.photoId }]} />}
      {text(selected.resolutionPhotoId) && <PhotoEvidence photos={[{ id: selected.resolutionPhotoId }]} />}
      {text(selected.pickupEventId) && <details><summary>{t('evidence')}</summary><PickupDetail path={resident ? `/resident/pickups/${text(selected.pickupEventId)}` : role === 'SOCIETY_ADMIN' ? `/pickups/${text(selected.pickupEventId)}` : `/supervisor/pickups/${text(selected.pickupEventId)}`} /></details>}
    </div></Modal>}
  </div>;
}

'use client';
import { Panel } from '@swachh/ui';
import { record, rows, safeUrl, text } from '@/lib/data';
import { HOSTED_DEMO_ENABLED } from '@/lib/demo';
import { useI18n } from '@/lib/i18n';
import { useAuth, useScope } from './providers';
import { ActionForm, DataTable, Notice, QueryRecord, SectionHeading, field } from './operations';

export function Settings() {
  const { t } = useI18n(); const { role, society, ulb, membership } = useScope();
  const { access } = useAuth();
  const identityLocked = HOSTED_DEMO_ENABLED || access?.mode === 'open-demo';
  return <div className="section-stack"><SectionHeading title={t('settings')} />
    <QueryRecord path="/me">{data => <>
      <div className="settings-grid"><Panel className="padded"><h3>{t('contact')}</h3>{identityLocked ? <Notice>{t('hostedDemoIdentityLocked')}</Notice> : <><p className="muted">{t('consent')}</p><ActionForm title="edit" path="/me" method="PATCH" initial={record(data.user)} fields={[
        field('name', 'name'), field('email', 'email', { type: 'email', required: false }), field('locale', 'locale', { type: 'select', options: [{ value: 'en', label: 'English' }, { value: 'hi', label: 'हिन्दी' }] }),
      ]} /></>}</Panel><Panel className="padded"><h3>{t('preferences')}</h3>{identityLocked ? <Notice>{t('hostedDemoIdentityLocked')}</Notice> : <><p className="muted">{t('quietHours')}</p><ActionForm title="preferences" path="/me" method="PATCH" initial={record(record(data.user).notificationPreferences)} fields={[
        field('inApp', 'inApp', { type: 'checkbox', required: false }), field('email', 'emailOptIn', { type: 'checkbox', required: false }), field('whatsapp', 'whatsapp', { type: 'checkbox', required: false }),
      ]} transform={values => ({ notificationPreferences: values })} /></>}</Panel></div>
      {role === 'SUPER_ADMIN' && <Panel className="padded"><h3>{t('featureFlags')}</h3><ActionForm title="featureFlags" path={`${ulb}/feature-flags`} method="PATCH" initial={record(record(rows(data.memberships).find(item => item.id === membership?.id)?.ulb).flags)} fields={[
        field('compliance_v2', 'compliance', { type: 'checkbox', required: false }), field('billing_v1', 'invoices', { type: 'checkbox', required: false }), field('whatsapp_v1', 'whatsapp', { type: 'checkbox', required: false }), field('swachhata_v1', 'swachhata', { type: 'checkbox', required: false }),
      ]} /></Panel>}
    </>}</QueryRecord>
    {role === 'SOCIETY_ADMIN' && <Panel className="padded"><SectionHeading title={t('invoices')} detail={t('billingNotice')} actions={<ActionForm title="settings" path={`${society}/settings`} method="PATCH" fields={[
      field('flatFeePaise', 'fee', { type: 'number', min: 0, step: '1' }), field('pickupFeePaise', 'pickupFee', { type: 'number', min: 0, step: '1' }), field('handlingFeePaisePerKg', 'handlingFee', { type: 'number', min: 0, step: '1' }), field('missedDeductionPaise', 'deductionFee', { type: 'number', min: 0, step: '1' }), field('graceDays', 'grace', { type: 'number', min: 0, max: 90, step: '1' }), field('paymentInstructions', 'paymentInstructions', { type: 'textarea' }), field('feeSource', 'source'), field('feeSourceDate', 'sourceDate', { type: 'date' }),
    ]} />} /></Panel>}
    <Panel className="padded"><h3>{t('privacy')}</h3><div className="button-row"><ActionForm title="privacyExport" path="/me/privacy-requests" fields={[]} body={{ type: 'EXPORT' }} /><ActionForm title="privacyErase" variant="danger" path="/me/privacy-requests" fields={[]} body={{ type: 'ERASURE' }} /></div></Panel>
  </div>;
}

export function Notifications() {
  const { t } = useI18n();
  return <div className="section-stack"><SectionHeading title={t('notifications')} /><DataTable path="/notifications" title="notifications" columns={[{ key: 'createdAt', label: 'date', format: 'date' }, { key: 'template', label: 'type' }, { key: 'payload', label: 'description' }, { key: 'status', label: 'status', format: 'status' }]} rowActions={row => !row.readAt && <ActionForm title="markRead" path={`/notifications/${text(row.id)}`} method="PATCH" body={{ read: true }} fields={[]} />} /></div>;
}

export function CollectorGuide() {
  const { t } = useI18n(); const value = process.env.NEXT_PUBLIC_COLLECTOR_APP_URL;
  const noAuth = useAuth().access?.mode === 'open-demo';
  const url = value?.startsWith('exp://') || value?.startsWith('swachhtrack://') ? value : safeUrl(value);
  return <Panel className="collector-guide padded"><span className="eyebrow">ANDROID / EXPO</span><h2>{t('mobileTitle')}</h2><p>{t('mobileDescription')}</p><Notice>{t('reviewNotice')}</Notice><p>{t(noAuth ? 'mobileStepsOpen' : 'mobileSteps')}</p>{url ? <a className="button button-primary" href={url}>{t('mobileOpen')}</a> : <Notice>{t('mobileUnconfigured')}</Notice>}</Panel>;
}

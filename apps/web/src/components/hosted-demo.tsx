'use client';
import { HOSTED_DEMO_ENABLED } from '@/lib/demo';
import { useI18n } from '@/lib/i18n';
import { useAuth } from './providers';

export function HostedDemoNotice() {
  const { t } = useI18n();
  const noAuth = useAuth().access?.mode === 'open-demo';
  if (!HOSTED_DEMO_ENABLED && !noAuth) return null;
  return <aside className="notice hosted-demo-notice" aria-label={t(noAuth ? 'openDemo' : 'hostedDemo')}>
    <strong>{t(noAuth ? 'openDemo' : 'hostedDemo')}</strong>
    {noAuth && <p>{t('openDemoNotice')}</p>}
    <p>{t('hostedDemoData')}</p>
    {HOSTED_DEMO_ENABLED && <p>{t('hostedDemoHosting')} {t('hostedDemoAutomation')}</p>}
  </aside>;
}

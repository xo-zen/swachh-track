'use client';
import { HOSTED_DEMO_ENABLED } from '@/lib/demo';
import { useI18n } from '@/lib/i18n';

export function HostedDemoNotice() {
  const { t } = useI18n();
  if (!HOSTED_DEMO_ENABLED) return null;
  return <aside className="notice hosted-demo-notice" aria-label={t('hostedDemo')}>
    <strong>{t('hostedDemo')}</strong>
    <p>{t('hostedDemoData')}</p>
    <p>{t('hostedDemoHosting')} {t('hostedDemoAutomation')}</p>
  </aside>;
}

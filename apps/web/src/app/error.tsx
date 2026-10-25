'use client';
import { ErrorState } from '@swachh/ui';
import { useI18n } from '@/lib/i18n';

export default function ErrorPage({ reset }: { error: Error & { digest?: string }; reset: () => void }) { const { t } = useI18n(); return <main className="main-content"><ErrorState message={t('checkConnection')} retry={reset} retryLabel={t('retry')} /></main>; }

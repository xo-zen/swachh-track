'use client';
import { useState, type FormEvent } from 'react';
import { ArrowRight, CheckCircle2, Leaf, ShieldCheck } from 'lucide-react';
import { Button, ErrorState } from '@swachh/ui';
import { api, errorMessage, type AuthResult } from '@/lib/api';
import { DEMO_ENABLED, HOSTED_DEMO_ENABLED } from '@/lib/demo';
import { useI18n } from '@/lib/i18n';
import { HostedDemoNotice } from './hosted-demo';
import { useAuth } from './providers';

export function LanguageSwitch() { const { locale, setLocale, t } = useI18n(); return <select className="language-switch" aria-label={t('language')} value={locale} onChange={event => setLocale(event.target.value === 'hi' ? 'hi' : 'en')}><option value="en">English</option><option value="hi">हिन्दी</option></select>; }
export function Login() {
  const { t } = useI18n(); const { login } = useAuth();
  const [phone, setPhone] = useState(''); const [code, setCode] = useState(''); const [requested, setRequested] = useState(false);
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [sentAt, setSentAt] = useState(0);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError('');
    try {
      if (!requested) { await api.mutate('/auth/otp/request', { phone: phone.trim() }); setRequested(true); setSentAt(Date.now()); }
      else { const result = await api.mutate<AuthResult>('/auth/otp/verify', { phone: phone.trim(), code }); await login(result); }
    } catch (failure) { setError(errorMessage(failure)); } finally { setBusy(false); }
  }
  async function demo(alias: string) {
    if (!DEMO_ENABLED) return; setBusy(true); setError('');
    try { const identity = `${alias}@demo.swachhtrack.in`; await api.mutate('/auth/otp/request', { phone: identity }); const result = await api.mutate<AuthResult>('/auth/otp/verify', { phone: identity, code: '123456' }); await login(result); }
    catch (failure) { setError(errorMessage(failure)); } finally { setBusy(false); }
  }
  return <main className="login-page"><div className="login-story"><a className="brand" href="/"><span className="brand-mark"><Leaf size={26} /></span><span>{t('app')}<small>{t('tagline')}</small></span></a><span className="eyebrow">CIVIC OPERATIONS / स्वच्छ भारत</span><h1>{t('loginIntro')}</h1><p>{t('loginDetail')}</p><div className="proof-path"><span><CheckCircle2 />{t('pickups')}</span><span><CheckCircle2 />{t('invoices')}</span><span><CheckCircle2 />{t('compliance')}</span></div><div className="login-seal"><ShieldCheck size={36} /><p>{t('checkConnection')}</p></div></div>
    <div className="login-form-area"><LanguageSwitch /><div className="login-card"><span className="eyebrow">SWACHH-TRACK / 01</span><h2>{t(HOSTED_DEMO_ENABLED ? 'hostedDemoSignIn' : 'signIn')}</h2><p className="muted">{t('authMemory')}</p>
      <HostedDemoNotice />
      {!HOSTED_DEMO_ENABLED && <><form onSubmit={submit}><label>{t('phone')}<input name="phone" autoComplete="username" required value={phone} readOnly={requested} onChange={event => setPhone(event.target.value)} placeholder="+91…" /></label>{requested && <><p className="notice">{t('otpSent')}</p><label>{t('otp')}<input name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required value={code} onChange={event => setCode(event.target.value)} autoFocus /></label></>}{error && <ErrorState message={error} />}<Button type="submit" disabled={busy}>{busy ? t('loading') : t(requested ? 'verify' : 'requestOtp')}<ArrowRight size={18} /></Button>{requested && <Button type="button" variant="quiet" disabled={busy} onClick={() => { if (Date.now() - sentAt < 60_000) { setError(t('otpSent')); return; } setRequested(false); setCode(''); setError(''); }}>{t('changePhone')}</Button>}</form><p className="small muted">{t('consent')}</p></>}
      {DEMO_ENABLED && <div className="demo-logins"><h3>{t(HOSTED_DEMO_ENABLED ? 'hostedDemoRoles' : 'demoLogin')}</h3><p className="small muted">{t(HOSTED_DEMO_ENABLED ? 'hostedDemoAuth' : 'demoWarning')}</p><div className="button-row">{[['resident', 'RESIDENT'], ['society', 'SOCIETY_ADMIN'], ['collector', 'COLLECTOR'], ['supervisor', 'SUPERVISOR'], ['ulb', 'ULB_ADMIN']].map(([alias, role]) => <Button key={alias} variant="secondary" disabled={busy} onClick={() => void demo(alias)}>{t(role)}</Button>)}</div>{HOSTED_DEMO_ENABLED && busy && <p className="small muted" role="status">{t('loading')}</p>}{HOSTED_DEMO_ENABLED && error && <ErrorState message={error} />}</div>}
    </div></div>
  </main>;
}

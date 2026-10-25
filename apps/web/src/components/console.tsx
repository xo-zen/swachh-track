'use client';
import { useEffect, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Activity, Bell, Building2, CalendarDays, ClipboardCheck, FileCheck2, FileText, HelpCircle, Home, Leaf, LogOut, MapPinned, Menu, PackageCheck, Settings2, ShieldCheck, Smartphone, Truck, Users, X, type LucideIcon } from 'lucide-react';
import { Button, ErrorState } from '@swachh/ui';
import { errorMessage } from '@/lib/api';
import { HOSTED_DEMO_ENABLED } from '@/lib/demo';
import { useI18n, type TranslationKey } from '@/lib/i18n';
import { HostedDemoNotice } from './hosted-demo';
import { useAuth } from './providers';
import { LanguageSwitch, Login } from './login';
import { Modal, Notice } from './operations';
import { Dashboard } from './dashboard';
import { Properties, Residents, Schedules, Vendors } from './registry';
import { Pickups } from './pickups';
import { Complaints } from './complaints';
import { Invoices } from './billing';
import { CertificateRegister, Compliance } from './compliance';
import { Audit, Contractors, Exports, RegistryMap } from './ulb';
import { CollectorGuide, Notifications, Settings } from './settings';

const items: { key: TranslationKey; icon: LucideIcon; roles: string[] }[] = [
  { key: 'dashboard', icon: Home, roles: ['RESIDENT', 'SOCIETY_ADMIN', 'SUPERVISOR', 'ULB_ADMIN', 'SUPER_ADMIN'] },
  { key: 'properties', icon: Building2, roles: ['SOCIETY_ADMIN'] },
  { key: 'residents', icon: Users, roles: ['SOCIETY_ADMIN'] },
  { key: 'schedules', icon: CalendarDays, roles: ['SOCIETY_ADMIN'] },
  { key: 'vendors', icon: Truck, roles: ['SOCIETY_ADMIN'] },
  { key: 'pickups', icon: PackageCheck, roles: ['RESIDENT', 'SOCIETY_ADMIN', 'ULB_ADMIN'] },
  { key: 'review', icon: ClipboardCheck, roles: ['SUPERVISOR'] },
  { key: 'complaints', icon: Bell, roles: ['RESIDENT', 'SOCIETY_ADMIN', 'SUPERVISOR', 'ULB_ADMIN'] },
  { key: 'invoices', icon: FileText, roles: ['SOCIETY_ADMIN'] },
  { key: 'compliance', icon: FileCheck2, roles: ['SOCIETY_ADMIN'] },
  { key: 'registry', icon: MapPinned, roles: ['ULB_ADMIN', 'SUPER_ADMIN'] },
  { key: 'contractors', icon: Truck, roles: ['ULB_ADMIN'] },
  { key: 'certificates', icon: FileCheck2, roles: ['ULB_ADMIN'] },
  { key: 'exports', icon: FileText, roles: ['ULB_ADMIN'] },
  { key: 'audit', icon: Activity, roles: ['ULB_ADMIN', 'SUPER_ADMIN'] },
  { key: 'collector', icon: Smartphone, roles: ['COLLECTOR'] },
  { key: 'notifications', icon: Bell, roles: ['RESIDENT', 'SOCIETY_ADMIN', 'SUPERVISOR', 'ULB_ADMIN'] },
  { key: 'settings', icon: Settings2, roles: ['RESIDENT', 'SOCIETY_ADMIN', 'COLLECTOR', 'SUPERVISOR', 'ULB_ADMIN', 'SUPER_ADMIN'] },
];
function Screen({ section }: { section: string }) {
  switch (section) {
    case 'dashboard': return <Dashboard />;
    case 'properties': return <Properties />;
    case 'residents': return <Residents />;
    case 'schedules': return <Schedules />;
    case 'vendors': return <Vendors />;
    case 'pickups': return <Pickups />;
    case 'review': return <Pickups review />;
    case 'complaints': return <Complaints />;
    case 'invoices': return <Invoices />;
    case 'compliance': return <Compliance />;
    case 'registry': return <RegistryMap />;
    case 'contractors': return <Contractors />;
    case 'certificates': return <CertificateRegister />;
    case 'exports': return <Exports />;
    case 'audit': return <Audit />;
    case 'notifications': return <Notifications />;
    case 'settings': return <Settings />;
    case 'collector': return <CollectorGuide />;
    default: return null;
  }
}

export function Console() {
  const { t } = useI18n(); const { identity, membership, select, logout } = useAuth(); const params = useSearchParams(); const router = useRouter(); const pathname = usePathname();
  const [mobileMenu, setMobileMenu] = useState(false); const [tour, setTour] = useState(params.get('demo') === '1'); const [step, setStep] = useState(0); const [error, setError] = useState(''); const [online, setOnline] = useState(true);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine); update();
    window.addEventListener('online', update); window.addEventListener('offline', update);
    return () => { window.removeEventListener('online', update); window.removeEventListener('offline', update); };
  }, []);
  if (!identity) return <Login />;
  const allowed = items.filter(item => item.roles.includes(membership?.role ?? ''));
  const requested = params.get('section'); const section = allowed.find(item => item.key === requested)?.key ?? allowed[0]?.key ?? '';
  const noScope = membership?.role === 'SOCIETY_ADMIN' ? !membership.societyId : membership?.role === 'ULB_ADMIN' ? !membership.ulbId : false;
  function navigate(key: string) { const query = new URLSearchParams(params); query.set('section', key); router.push(`${pathname}?${query}`, { scroll: false }); setMobileMenu(false); }
  return <div className="console-shell">
    <a className="skip-link" href="#main-content">{t('dashboard')}</a>
    <aside className={`sidebar ${mobileMenu ? 'mobile-open' : ''}`}>
      <div className="sidebar-brand"><Leaf size={28} /><span>{t('app')}<small>{t('console')}</small></span><Button variant="quiet" className="mobile-close" onClick={() => setMobileMenu(false)} aria-label={t('close')}><X size={20} /></Button></div>
      <div className="workspace-label"><span className="eyebrow">{t('membership')}</span><strong>{membership?.society?.name || membership?.ulb?.name || t(membership?.role ?? '')}</strong></div>
      <nav aria-label={t('menu')}>{allowed.map(item => <button key={item.key} aria-current={section === item.key ? 'page' : undefined} onClick={() => navigate(item.key)}><item.icon size={19} /><span>{t(item.key)}</span>{section === item.key && <span className="nav-dot" />}</button>)}</nav>
      <div className="sidebar-bottom"><ShieldCheck size={20} /><p>{t('tagline')}</p><span className="small">SWACHH-TRACK · PILOT</span></div>
    </aside>
    {mobileMenu && <button className="menu-backdrop" aria-label={t('close')} onClick={() => setMobileMenu(false)} />}
    <div className="main-shell">
      <header className="topbar"><div className="header-left"><Button variant="quiet" className="mobile-menu" aria-label={t('menu')} onClick={() => setMobileMenu(true)}><Menu size={22} /></Button><div className="breadcrumb">{t('console')} <span>/</span> <strong>{t(section)}</strong></div></div>
        <div className="header-controls"><label className="membership-control"><span className="sr-only">{t('membership')}</span><select aria-label={t('membership')} value={membership?.id ?? ''} onChange={event => { select(event.target.value); setMobileMenu(false); }}>{identity.memberships.filter(item => !item.status || item.status === 'ACTIVE').map(item => <option key={item.id} value={item.id}>{item.society?.name || item.societyId?.slice(0, 8) || item.ulb?.name || item.ulbId?.slice(0, 8)} · {t(item.role)}</option>)}</select></label>
          <LanguageSwitch /><Button variant="quiet" aria-label={t('tourStart')} onClick={() => setTour(true)}><HelpCircle size={20} /></Button><Button variant="quiet" aria-label={t('logout')} onClick={async () => { try { await logout(); } catch (failure) { setError(errorMessage(failure)); } }}><LogOut size={19} /></Button>
        </div>
      </header>
      <main id="main-content" className="main-content"><HostedDemoNotice /><div className="page-kicker"><span><span className="live-dot" />{t(HOSTED_DEMO_ENABLED ? 'hostedDemoRecords' : 'liveData')}</span><span>IST · UTC+05:30</span></div>
        {!online && <Notice>{t('offline')}</Notice>}{error && <ErrorState message={error} />}
        {!membership ? <Notice>{t('noMemberships')}</Notice> : noScope ? <Notice>{t('missingScope')}</Notice> : <div key={`${membership.id}-${section}`}><Screen section={section} /></div>}
      </main>
      <footer className="console-footer"><span>{t('app')} / {t('console')}</span><span>{t(HOSTED_DEMO_ENABLED ? 'hostedDemoData' : 'noFabrication')}</span></footer>
    </div>
    {tour && <Modal title={t('tour')} onClose={() => setTour(false)}><div className="tour-content"><span className="eyebrow">{t('step')} {step + 1} {t('of')} 5</span><h3>{t(HOSTED_DEMO_ENABLED && step === 0 ? 'hostedDemoTour1' : `tour${step + 1}`)}</h3><Notice>{t('reviewNotice')}</Notice><div className="tour-progress">{[0, 1, 2, 3, 4].map(value => <span key={value} className={value <= step ? 'active' : ''} />)}</div><div className="button-row"><Button variant="secondary" disabled={step === 0} onClick={() => setStep(value => value - 1)}>{t('previous')}</Button><Button onClick={() => { if (step === 4) { setTour(false); setStep(0); } else setStep(value => value + 1); }}>{t(step === 4 ? 'finish' : 'next')}</Button></div></div></Modal>}
  </div>;
}

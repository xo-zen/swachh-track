'use client';
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { api, errorMessage, type Access, type AuthResult, type DemoRole, type Identity, type Membership } from '@/lib/api';
import { LanguageProvider, useI18n } from '@/lib/i18n';

interface AuthContextValue { identity: Identity | null; membership: Membership | null; access: Access | null; loading: boolean; startupError: string; demoRole: DemoRole | null; open: (role?: DemoRole) => Promise<void>; login: (result: AuthResult) => Promise<void>; select: (id: string) => void; logout: () => Promise<void> }
const AuthContext = createContext<AuthContextValue | null>(null);
function AuthProvider({ children }: { children: ReactNode }) {
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [membership, setMembership] = useState<Membership | null>(null);
  const [access, setAccess] = useState<Access | null>(null);
  const [loading, setLoading] = useState(true);
  const [startupError, setStartupError] = useState('');
  const [demoRole, setDemoRole] = useState<DemoRole | null>(null);
  const generation = useRef(0);
  const client = useQueryClient();
  const { setLocale } = useI18n();
  async function open(role?: DemoRole) {
    const attempt = ++generation.current;
    setLoading(true); setStartupError(''); setIdentity(null); setMembership(null);
    void client.cancelQueries(); client.clear(); api.clear();
    try {
      const mode = await api.discoverAccess();
      if (attempt !== generation.current) return;
      setAccess(mode);
      if (mode.mode === 'authenticated') { setDemoRole(null); return; }
      let remembered: string | null = null;
      try { remembered = sessionStorage.getItem('swachh.demo-role'); } catch { /* Storage may be disabled. */ }
      const selected = mode.roles.find(item => item.alias === (role ?? remembered))?.alias ?? 'resident';
      setDemoRole(selected);
      const current = await api.openDemo(selected);
      if (attempt !== generation.current) return;
      setIdentity(current); setMembership(current.memberships[0]);
      try { sessionStorage.setItem('swachh.demo-role', selected); } catch { /* Role selection still works without persistence. */ }
    } catch (error) {
      if (attempt === generation.current) { api.clear(); setStartupError(errorMessage(error)); }
    } finally { if (attempt === generation.current) setLoading(false); }
  }
  useEffect(() => { void open(); return () => { generation.current++; }; }, []);
  useEffect(() => { api.onExpired = () => { setIdentity(null); setMembership(null); client.clear(); }; return () => { api.onExpired = undefined; }; }, [client]);
  async function login(result: AuthResult) {
    api.authenticate(result);
    try {
      const current = await api.json<Identity>('/me');
      if (!current.user?.id || !Array.isArray(current.memberships)) throw new Error('Invalid account response from API.');
      const first = current.memberships.find(item => !item.status || item.status === 'ACTIVE') ?? null;
      api.selectMembership(first?.id ?? ''); client.clear(); setIdentity(current); setMembership(first);
      if (current.user.locale === 'en' || current.user.locale === 'hi') setLocale(current.user.locale);
    } catch (error) { api.clear(); throw error; }
  }
  function select(id: string) {
    const selected = identity?.memberships.find(item => item.id === id);
    if (!selected) return;
    void client.cancelQueries(); client.clear(); api.selectMembership(id); setMembership(selected);
  }
  async function logout() { try { await api.logout(); } finally { client.clear(); setIdentity(null); setMembership(null); } }
  return <AuthContext.Provider value={{ identity, membership, access, loading, startupError, demoRole, open, login, select, logout }}>{children}</AuthContext.Provider>;
}
export function Providers({ children }: { children: ReactNode }) {
  const [client] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 15_000, refetchOnWindowFocus: true }, mutations: { retry: false } } }));
  return <QueryClientProvider client={client}><LanguageProvider><AuthProvider>{children}</AuthProvider></LanguageProvider></QueryClientProvider>;
}
export function useAuth() { const value = useContext(AuthContext); if (!value) throw new Error('Missing authentication provider'); return value; }
export function useScope() {
  const { membership } = useAuth();
  return { membership, role: membership?.role ?? '', society: membership?.societyId ? `/societies/${encodeURIComponent(membership.societyId)}` : '', ulb: membership?.ulbId ? `/ulb/${encodeURIComponent(membership.ulbId)}` : '' };
}

import { useEffect, useState } from 'react';
import { AppState, KeyboardAvoidingView, Platform, StatusBar, Text, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import NetInfo from '@react-native-community/netinfo';
import * as SecureStore from 'expo-secure-store';
import * as Crypto from 'expo-crypto';
import { CollectorApi, clearMembership, chooseMembership, deviceId, logout, parseRoutes, requestOtp, restoreAuth, scopeOf, verifyOtp } from './src/api';
import { cacheRoutes, cachedRoutes, getDatabase, listEvents, loadDraft, saveDraft } from './src/storage';
import { indiaDate, record, type AuthSession, type CaptureDraft, type QueueEvent, type Route, type RouteStop } from './src/model';
import { formatTime, translatedError, translator, type Language, type Translate } from './src/i18n';
import { errorMessage, isSyncing, refreshVerdicts, syncQueue } from './src/sync';
import { CaptureScreen } from './src/CaptureScreen';
import { Diagnostics } from './src/Diagnostics';
import { Action, Busy, Field, Notice, Page, Panel, styles } from './src/ui';

function Login({ t, onAuth }: { t: Translate; onAuth: (auth: AuthSession) => void }) {
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const [error, setError] = useState('');
  useEffect(() => { if (!cooldown) return; const timer = setTimeout(() => setCooldown(cooldown - 1), 1000); return () => clearTimeout(timer); }, [cooldown]);
  async function submit(verify: boolean): Promise<void> {
    setError('');
    if (!/^\+[1-9]\d{7,14}$/.test(phone.trim())) { setError(t('phoneInvalid')); return; }
    if (verify && !/^\d{6}$/.test(code)) { setError(t('otpInvalid')); return; }
    setBusy(true);
    try {
      if (verify) onAuth(await verifyOtp(phone.trim(), code));
      else { await requestOtp(phone.trim()); setSent(true); setCooldown(60); }
    } catch (cause) { setError(translatedError(errorMessage(cause), t)); }
    finally { setBusy(false); }
  }
  return <Page>
    <Text style={styles.title}>{t('collector')}</Text>
    <Notice>{t('consent')}</Notice>
    {error ? <Notice error>{error}</Notice> : null}
    <Panel>
      <Field label={t('phone')} testID="phone" value={phone} keyboardType="phone-pad" autoComplete="tel" editable={!busy} onChangeText={(value) => { setPhone(value); setSent(false); setCode(''); }} />
      <Action label={`${t('requestOtp')}${cooldown ? ` (${cooldown})` : ''}`} testID="request-otp" disabled={busy || cooldown > 0} onPress={() => { void submit(false); }} />
      {sent ? <>
        <Notice>{t('otpSent')}</Notice>
        <Field label={t('code')} testID="otp-code" value={code} keyboardType="number-pad" autoComplete="sms-otp" maxLength={6} editable={!busy} onChangeText={setCode} />
        <Action label={t(busy ? 'working' : 'verifyOtp')} testID="verify-otp" disabled={busy} onPress={() => { void submit(true); }} />
      </> : null}
    </Panel>
  </Page>;
}

function CollectorHome({ auth, device, online, t, language, onLogout, onMembership }: { auth: AuthSession; device: string; online: boolean; t: Translate; language: Language; onLogout: () => void; onMembership: () => void }) {
  const [api] = useState(() => new CollectorApi(auth));
  const [routes, setRoutes] = useState<Route[]>([]);
  const [cachedAt, setCachedAt] = useState<string | null>(null);
  const [events, setEvents] = useState<QueueEvent[]>([]);
  const [capture, setCapture] = useState<{ draft: CaptureDraft; route: Route } | null>(null);
  const [diagnostics, setDiagnostics] = useState(false);
  const [serverStatus, setServerStatus] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  async function reload(): Promise<void> { setEvents(await listEvents(api.scope)); }
  function changed(): void { setSyncing(isSyncing()); void reload().catch((cause: unknown) => setError(errorMessage(cause))); }
  async function sync(manual = false): Promise<void> {
    setError(''); setSyncing(true);
    try { await syncQueue(api, changed, manual); }
    catch (cause) { setError(errorMessage(cause)); }
    finally { setSyncing(isSyncing()); }
  }
  async function refresh(): Promise<void> {
    setBusy(true); setError('');
    try {
      const value = parseRoutes(await api.request('/collector/today'));
      await cacheRoutes(api.scope, value);
      const cached = await cachedRoutes(api.scope);
      setRoutes(value); setCachedAt(cached?.cachedAt ?? null);
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(false); }
  }
  useEffect(() => {
    let active = true;
    void Promise.all([cachedRoutes(api.scope), listEvents(api.scope)]).then(([cache, localEvents]) => {
      if (!active) return;
      setRoutes(cache?.routes ?? []); setCachedAt(cache?.cachedAt ?? null); setEvents(localEvents);
    }).catch((cause: unknown) => { if (active) setError(errorMessage(cause)); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [api]);
  useEffect(() => {
    if (!online) return;
    let active = true;
    const notify = (): void => { if (active) changed(); };
    const tick = (): void => {
      if (AppState.currentState !== 'active') return;
      void syncQueue(api, notify).catch((cause: unknown) => { if (active) setError(errorMessage(cause)); });
      if (active) setSyncing(isSyncing());
    };
    tick();
    const timer = setInterval(tick, 5000);
    const subscription = AppState.addEventListener('change', (state) => { if (state === 'active') tick(); });
    return () => { active = false; clearInterval(timer); subscription.remove(); };
    // The API instance is fixed to this mounted membership; scope changes remount the screen.
  }, [api, online]);
  useEffect(() => {
    if (online) void refresh();
  }, [api, online]);

  async function openStop(route: Route, stop: RouteStop): Promise<void> {
    setBusy(true); setError(''); setMessage('');
    try {
      if (!stop.property.qrToken) throw new Error('qrUnavailable');
      if ((await listEvents(api.scope)).some((event) => event.stopId === stop.id)) throw new Error('alreadyQueued');
      let draft = await loadDraft(api.scope, stop.id);
      if (draft && (draft.stop.property.qrToken !== stop.property.qrToken || draft.routeDate !== route.date)) throw new Error('routeExpired');
      if (!draft) {
        draft = { client_uuid: Crypto.randomUUID(), scope: api.scope, routeId: route.id, routeDate: route.date, stop, qrToken: null, offline: !online, gps: null, doorstep: null, streams: stop.streams.map((stream) => ({ stream, weight: '', segregation: 'GOOD', contamination: false, contaminationNote: '', photo: null })), exception: null };
        await saveDraft(draft);
      }
      setCapture({ draft, route });
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(false); }
  }
  async function status(): Promise<void> {
    setBusy(true); setError('');
    try { setServerStatus(await refreshVerdicts(api)); }
    catch (cause) { setError(errorMessage(cause)); }
    finally { await reload().catch((cause: unknown) => setError(errorMessage(cause))); setBusy(false); }
  }
  if (capture) return <CaptureScreen initial={capture.draft} route={capture.route} device={device} online={online} t={t} language={language} onBack={() => setCapture(null)} onSaved={() => { setCapture(null); setMessage('saved'); changed(); if (online) void sync(); }} />;
  return <>
    {error ? <Notice error>{translatedError(error, t)}</Notice> : null}
    {diagnostics ? <Diagnostics events={events} busy={busy || syncing} online={online} t={t} language={language} serverStatus={serverStatus} onBack={() => setDiagnostics(false)} onRetry={() => { void sync(true); }} onStatus={() => { void status(); }} /> : <Page>
      <Text style={styles.title}>{t('routes')}</Text>
      {message ? <Notice>{translatedError(message, t)}</Notice> : null}
      {loading ? <Busy label={t('loading')} /> : null}
      <Text style={styles.text}>{t('pendingCount')}: {events.filter((event) => event.transport !== 'SYNCED').length}</Text>
      <Action label={t(syncing ? 'working' : 'sync')} testID="sync-now" disabled={syncing || !online} onPress={() => { void sync(true); }} />
      <Action label={t('diagnostics')} secondary testID="diagnostics" onPress={() => setDiagnostics(true)} />
      <Action label={t('refresh')} secondary testID="refresh-route" disabled={busy || !online} onPress={() => { void refresh(); }} />
      {cachedAt ? <Text style={styles.small}>{t('cache')}: {formatTime(cachedAt, language)}</Text> : null}
      {!loading && !routes.length ? <Notice>{t('noRoutes')}</Notice> : null}
      {routes.map((route) => <View key={route.id} style={{ gap: 14 }}>
        <Text style={styles.heading}>{route.name} · {route.date.slice(0, 10)}</Text>
        {route.date.slice(0, 10) !== indiaDate() ? <Notice>{t('stale')}</Notice> : null}
        {route.stops.map((stop) => {
          const event = events.find((item) => item.stopId === stop.id);
          let last = t('none');
          if (typeof stop.lastPickup === 'string') last = formatTime(stop.lastPickup, language);
          else if (stop.lastPickup) {
            try { const pickup = record(stop.lastPickup); last = typeof pickup.capturedAt === 'string' ? formatTime(pickup.capturedAt, language) : JSON.stringify(stop.lastPickup); } catch { last = t('none'); }
          }
          const locked = Boolean(event) || ['DONE', 'EXCEPTION', 'SKIPPED'].includes(stop.status);
          return <Panel key={stop.id}>
            <Text style={styles.heading}>{stop.sequence}. {stop.property.block ?? ''} {t('unit')} {stop.property.unitNo}</Text>
            <Text style={styles.text}>{stop.streams.map(t).join(' / ')}</Text>
            <Text style={styles.small}>{t('window')}: {formatTime(stop.windowStart, language)} - {formatTime(stop.windowEnd, language)}{ '\n' }{t('lastPickup')}: {last}</Text>
            {event ? <>
              <Text style={styles.text}>{t('transport')}: {t(event.transport)}{ '\n' }{t('verdict')}: {event.verdict ? t(event.verdict) : t('awaitingVerdict')}</Text>
              {event.result?.verificationReasons.length ? <Notice error={event.verdict === 'REJECTED'}>{event.result.verificationReasons.join('\n')}</Notice> : null}
              {event.lastError ? <Notice error>{translatedError(event.lastError, t)}</Notice> : null}
            </> : null}
            {locked ? <Text style={styles.small}>{t('lockedStop')}</Text> : null}
            {!stop.property.qrToken ? <Notice error>{t('qrUnavailable')}</Notice> : null}
            <Action label={t(locked ? 'diagnostics' : 'openStop')} secondary={locked} testID={`stop-${stop.id}`} disabled={busy || (!locked && (!stop.property.qrToken || route.date.slice(0, 10) !== indiaDate()))} onPress={() => { if (locked) setDiagnostics(true); else void openStop(route, stop); }} />
          </Panel>;
        })}
      </View>)}
      <Action label={t('changeMembership')} secondary disabled={busy || syncing || isSyncing()} onPress={onMembership} />
      <Action label={t('logout')} secondary disabled={busy || syncing || isSyncing()} testID="logout" onPress={onLogout} />
    </Page>}
  </>;
}

export default function App() {
  const [auth, setAuth] = useState<AuthSession | null>(null);
  const [device, setDevice] = useState('');
  const [language, setLanguage] = useState<Language>('en');
  const [online, setOnline] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const t = translator(language);
  async function boot(): Promise<void> {
    setLoading(true); setError('');
    try {
      const [session, id, locale] = await Promise.all([restoreAuth(), deviceId(), SecureStore.getItemAsync('swachh.language'), getDatabase()]);
      setAuth(session); setDevice(id); setLanguage(locale === 'hi' ? 'hi' : 'en');
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setLoading(false); }
  }
  useEffect(() => { void boot(); return NetInfo.addEventListener((state) => setOnline(Boolean(state.isConnected) && state.isInternetReachable !== false)); }, []);
  async function act(action: () => Promise<AuthSession | null>): Promise<void> {
    if (isSyncing()) { setError('syncBusy'); return; }
    setBusy(true); setError('');
    try { setAuth(await action()); } catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(false); }
  }
  const registered = auth?.membershipId && auth.registeredMemberships.includes(auth.membershipId);
  return <SafeAreaProvider><SafeAreaView style={styles.root}>
    <StatusBar barStyle="dark-content" backgroundColor="#fff" />
    <View style={styles.header}>
      <Text style={[styles.heading, { flexShrink: 1 }]}>{t('app')}</Text>
      <Action label={language === 'en' ? 'हिन्दी' : 'English'} secondary testID="language" onPress={() => {
        const next = language === 'en' ? 'hi' : 'en'; setLanguage(next);
        void SecureStore.setItemAsync('swachh.language', next).catch((cause: unknown) => setError(errorMessage(cause)));
      }} />
    </View>
    {!online ? <View testID="offline-banner"><Notice>{t('offlineBanner')}</Notice></View> : null}
    {error ? <Notice error>{translatedError(error, t)}</Notice> : null}
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      {loading ? <Page><Busy label={t('loading')} /></Page> : !device ? <Page><Action label={t('restart')} onPress={() => { void boot(); }} /></Page> : !auth ? <Login t={t} onAuth={setAuth} /> : !auth.membershipId ? <Page>
        <Text style={styles.title}>{t('membership')}</Text>
        {auth.memberships.filter((membership) => membership.role === 'COLLECTOR').map((membership) => <Action key={membership.id} label={membership.name ?? membership.id} testID={`membership-${membership.id}`} disabled={busy} onPress={() => { void act(() => chooseMembership(membership.id)); }} />)}
        {!auth.memberships.some((membership) => membership.role === 'COLLECTOR') ? <Notice>{t('noMembership')}</Notice> : null}
        <Action label={t('logout')} secondary disabled={busy} onPress={() => { void act(async () => { await logout(); return null; }); }} />
      </Page> : !registered ? <Page>
        <Notice>{t('registrationRequired')}</Notice>
        <Action label={t(busy ? 'working' : 'register')} testID="register-device" disabled={busy || !online} onPress={() => { void act(() => new CollectorApi(auth).register()); }} />
        <Action label={t('changeMembership')} secondary disabled={busy} onPress={() => { void act(clearMembership); }} />
        <Action label={t('logout')} secondary disabled={busy} onPress={() => { void act(async () => { await logout(); return null; }); }} />
      </Page> : <CollectorHome key={scopeOf(auth)} auth={auth} device={device} online={online} t={t} language={language} onLogout={() => { void act(async () => { await logout(); return null; }); }} onMembership={() => { void act(clearMembership); }} />}
    </KeyboardAvoidingView>
  </SafeAreaView></SafeAreaProvider>;
}

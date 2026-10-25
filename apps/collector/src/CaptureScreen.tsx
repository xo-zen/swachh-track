import { useEffect, useRef, useState } from 'react';
import { Image, Linking, Text, View } from 'react-native';
import NetInfo from '@react-native-community/netinfo';
import { CameraSheet, type CameraMode } from './CameraSheet';
import { EXCEPTIONS, SEGREGATIONS, resolveIdentity, validateDraft, type CaptureDraft, type LocalPhoto, type Route, type Stream } from './model';
import { formatTime, translatedError, type Language, type Translate } from './i18n';
import { captureGps } from './media';
import { enqueue, saveDraft } from './storage';
import { errorMessage } from './sync';
import { Action, Field, Notice, Page, Panel, styles } from './ui';

export function CaptureScreen({ initial, route, device, online, t, language, onBack, onSaved }: { initial: CaptureDraft; route: Route; device: string; online: boolean; t: Translate; language: Language; onBack: () => void; onSaved: () => void }) {
  const [draft, setDraft] = useState(initial);
  const latest = useRef(initial);
  const pending = useRef(0);
  const saving = useRef(false);
  const [writing, setWriting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [code, setCode] = useState('');
  const [cameraMode, setCameraMode] = useState<CameraMode | null>(null);

  async function update(change: (value: CaptureDraft) => CaptureDraft): Promise<void> {
    const next = change(latest.current);
    latest.current = next;
    setDraft(next);
    pending.current += 1;
    setWriting(true);
    try { await saveDraft(next); }
    finally { pending.current -= 1; setWriting(pending.current > 0); }
  }
  function edit(change: (value: CaptureDraft) => CaptureDraft): void {
    void update(change).catch((cause: unknown) => setError(translatedError(errorMessage(cause), t)));
  }
  useEffect(() => {
    if (!online && !latest.current.offline) {
      const next = { ...latest.current, offline: true };
      latest.current = next;
      setDraft(next);
      void saveDraft(next).catch((cause: unknown) => setError(translatedError(errorMessage(cause), t)));
    }
  }, [online, t]);

  function editStream(stream: Stream, patch: Partial<CaptureDraft['streams'][number]>): void {
    edit((value) => ({ ...value, streams: value.streams.map((entry) => entry.stream === stream ? { ...entry, ...patch } : entry) }));
  }
  async function identify(value: string, mode: 'QR' | 'CODE'): Promise<boolean> {
    const token = resolveIdentity(route, draft.stop.id, value, mode);
    if (!token) return false;
    await update((current) => ({ ...current, qrToken: token }));
    setError('');
    return true;
  }
  async function acceptPhoto(photo: LocalPhoto): Promise<void> {
    await update((value) => {
      if (photo.kind === 'DOORSTEP') return { ...value, doorstep: photo };
      if (photo.kind === 'EXCEPTION' && value.exception) return { ...value, exception: { ...value.exception, photo } };
      if (photo.kind === 'SCALE') return { ...value, streams: value.streams.map((entry) => entry.stream === photo.stream ? { ...entry, photo } : entry) };
      throw new Error('invalidResponse');
    });
  }
  async function gps(): Promise<void> {
    setBusy(true); setError('');
    try { const location = await captureGps(); await update((value) => ({ ...value, gps: location })); }
    catch (cause) { setError(translatedError(errorMessage(cause), t)); }
    finally { setBusy(false); }
  }
  async function save(): Promise<void> {
    if (saving.current) return;
    saving.current = true;
    setBusy(true); setError('');
    try {
      const network = await NetInfo.fetch();
      const value = { ...latest.current, offline: latest.current.offline || !network.isConnected || network.isInternetReachable === false };
      const errors = validateDraft(value);
      if (errors.length) { setError(errors.map(t).join('\n')); return; }
      await saveDraft(value);
      await enqueue(value, device);
      onSaved();
    } catch (cause) { setError(translatedError(errorMessage(cause), t)); }
    finally { saving.current = false; setBusy(false); }
  }
  const evidenceDisabled = busy || !draft.qrToken;
  function photoPreview(photo: LocalPhoto | null) {
    return photo ? <View style={{ gap: 6 }}><Image source={{ uri: photo.uri }} style={styles.photo} accessibilityLabel={t('photoSaved')} /><Text style={styles.small}>{t('photoSaved')} · {formatTime(photo.capturedAt, language)}</Text></View> : null;
  }
  return <>
    <Page>
      <Action label={t('back')} secondary disabled={busy || writing} testID="capture-back" onPress={onBack} />
      <Text style={styles.title}>{t('capture')} · {draft.stop.property.block ?? ''} {draft.stop.property.unitNo}</Text>
      <Text style={styles.small}>{t('draftNote')}</Text>
      {error ? <Notice error>{error}</Notice> : null}
      <Panel>
        <Text style={styles.heading}>{t('identity')}</Text>
        {draft.qrToken ? <Notice>{t('identityOk')}</Notice> : <>
          <Action label={t('scanQr')} icon="QR" testID="scan-qr" onPress={() => setCameraMode({ kind: 'QR' })} />
          <Field label={t('propertyCode')} testID="property-code" keyboardType="number-pad" maxLength={6} value={code} onChangeText={setCode} />
          <Action label={t('checkCode')} secondary icon="#" testID="check-property-code" disabled={writing || code.length !== 6} onPress={() => { void identify(code, 'CODE').then((ok) => { if (!ok) setError(t('invalidIdentity')); }).catch((cause: unknown) => setError(translatedError(errorMessage(cause), t))); }} />
        </>}
      </Panel>
      <Panel>
        <Text style={styles.heading}>{t('doorstep')}</Text>
        {photoPreview(draft.doorstep)}
        <Action label={t(draft.doorstep ? 'retake' : 'takeDoorstep')} icon="+" secondary disabled={evidenceDisabled} testID="doorstep-photo" onPress={() => setCameraMode({ kind: 'DOORSTEP' })} />
      </Panel>
      <Panel>
        <Text style={styles.heading}>{t('gps')}</Text>
        {draft.gps ? <>
          <Text style={styles.text}>{t('latitude')}: {draft.gps.latitude.toFixed(6)}{ '\n' }{t('longitude')}: {draft.gps.longitude.toFixed(6)}{ '\n' }{t('accuracy')}: {draft.gps.accuracyM.toFixed(1)}</Text>
          <Text style={styles.small}>{t('gpsTime')}: {formatTime(draft.gps.gpsCapturedAt, language)}</Text>
          {draft.gps.accuracyM > 50 ? <Notice>{t('gpsWarning')}</Notice> : null}
        </> : null}
        <Action label={t(busy ? 'working' : 'captureGps')} icon="GPS" secondary disabled={evidenceDisabled} testID="capture-gps" onPress={() => { void gps(); }} />
        <Action label={t('settings')} secondary disabled={busy} onPress={() => { void Linking.openSettings().catch(() => setError(t('locationPermission'))); }} />
      </Panel>
      <Text style={styles.heading}>{t('streams')}</Text>
      {draft.exception ? <Panel>
        <Notice>{t('exceptionWarning')}</Notice>
        <Text style={styles.heading}>{t('exceptionCode')}</Text>
        {EXCEPTIONS.map((codeValue) => <Action key={codeValue} label={t(codeValue)} icon={draft.exception?.code === codeValue ? '*' : undefined} secondary={draft.exception?.code !== codeValue} disabled={busy} testID={`exception-${codeValue}`} onPress={() => edit((value) => ({ ...value, exception: value.exception ? { ...value.exception, code: codeValue } : null }))} />)}
        <Field label={t('exceptionNote')} testID="exception-note" value={draft.exception.note} editable={!busy} multiline maxLength={1000} onChangeText={(note) => edit((value) => ({ ...value, exception: value.exception ? { ...value.exception, note } : null }))} />
        {photoPreview(draft.exception.photo)}
        <Action label={t('exceptionPhoto')} icon="+" secondary disabled={evidenceDisabled} testID="exception-photo" onPress={() => setCameraMode({ kind: 'EXCEPTION' })} />
        <Action label={t('normalPickup')} secondary disabled={busy} onPress={() => edit((value) => ({ ...value, exception: null }))} />
      </Panel> : <>
        <Notice>{t('manualWeight')}</Notice>
        {draft.streams.map((entry) => <Panel key={entry.stream}>
          <Text style={styles.heading}>{t(entry.stream)}</Text>
          <Field label={t('kg')} testID={`weight-${entry.stream}`} value={entry.weight} editable={!busy} keyboardType="decimal-pad" maxLength={12} onChangeText={(weight) => editStream(entry.stream, { weight })} />
          {photoPreview(entry.photo)}
          <Action label={t('scalePhoto')} icon="+" secondary testID={`scale-photo-${entry.stream}`} disabled={evidenceDisabled} onPress={() => setCameraMode({ kind: 'SCALE', stream: entry.stream })} />
          <Text style={styles.text}>{t('segregation')}</Text>
          <View style={styles.row}>{SEGREGATIONS.map((segregation) => <Action key={segregation} label={t(segregation)} secondary={entry.segregation !== segregation} disabled={busy} testID={`segregation-${entry.stream}-${segregation}`} onPress={() => editStream(entry.stream, { segregation })} />)}</View>
          <Text style={styles.text}>{t('contamination')}</Text>
          <View style={styles.row}>
            <Action label={t('no')} secondary={entry.contamination} disabled={busy} onPress={() => editStream(entry.stream, { contamination: false })} />
            <Action label={t('yes')} secondary={!entry.contamination} disabled={busy} testID={`contamination-${entry.stream}`} onPress={() => editStream(entry.stream, { contamination: true })} />
          </View>
          {entry.contamination ? <Field label={t('contaminationNote')} testID={`contamination-note-${entry.stream}`} editable={!busy} value={entry.contaminationNote} maxLength={500} multiline onChangeText={(contaminationNote) => editStream(entry.stream, { contaminationNote })} /> : null}
        </Panel>)}
        <Action label={t('exception')} icon="!" secondary disabled={busy} testID="record-exception" onPress={() => edit((value) => ({ ...value, exception: { code: 'WEIGHT_UNAVAILABLE', note: '', photo: null } }))} />
      </>}
      {draft.offline ? <Notice>{t('offlineReview')}</Notice> : null}
      <Text style={styles.small}>{t('immutableNote')}</Text>
      <Action label={t(busy || writing ? 'working' : 'save')} icon="+" testID="save-pickup" disabled={busy || writing} onPress={() => { void save(); }} />
    </Page>
    {cameraMode ? <CameraSheet mode={cameraMode} t={t} onClose={() => setCameraMode(null)} onScan={(value) => identify(value, 'QR')} onPhoto={acceptPhoto} /> : null}
  </>;
}

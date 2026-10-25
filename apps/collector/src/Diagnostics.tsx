import { useEffect, useState } from 'react';
import { Text } from 'react-native';
import type { PhotoRow, PickupPayload, QueueEvent } from './model';
import { listPhotos } from './storage';
import { formatTime, translatedError, type Language, type Translate } from './i18n';
import { errorMessage } from './sync';
import { Action, Notice, Page, Panel, styles } from './ui';

export function Diagnostics({ events, busy, online, t, language, serverStatus, onBack, onRetry, onStatus }: { events: QueueEvent[]; busy: boolean; online: boolean; t: Translate; language: Language; serverStatus: unknown; onBack: () => void; onRetry: () => void; onStatus: () => void }) {
  const [photos, setPhotos] = useState<Record<string, PhotoRow[]>>({});
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    void Promise.all(events.map(async (event) => [event.uuid, await listPhotos(event.uuid)] as const)).then((entries) => { if (active) setPhotos(Object.fromEntries(entries)); }).catch((cause: unknown) => { if (active) setError(errorMessage(cause)); });
    return () => { active = false; };
  }, [events]);
  return <Page>
    <Action label={t('back')} secondary onPress={onBack} />
    <Text style={styles.title}>{t('diagnostics')}</Text>
    <Notice>{t('syncedNote')}</Notice>
    <Notice>{t('offlineReview')}</Notice>
    <Action label={t(busy ? 'working' : 'retry')} testID="retry-pending" disabled={busy || !online} onPress={onRetry} />
    <Action label={t('checkStatus')} secondary testID="refresh-server-status" disabled={busy || !online} onPress={onStatus} />
    {error ? <Notice error>{translatedError(error, t)}</Notice> : null}
    {!events.length ? <Notice>{t('emptyQueue')}</Notice> : null}
    {[...events].reverse().map((event) => {
      const capture = JSON.parse(event.captureJson) as PickupPayload;
      return <Panel key={event.uuid}>
        <Text style={styles.heading}>{t('stop')}: {event.stopId}</Text>
        <Text selectable style={styles.small}>{event.uuid}{'\n'}{formatTime(event.createdAt, language)}</Text>
        <Text testID={`transport-${event.uuid}`} style={styles.heading}>{t('transport')}: {t(event.transport)}</Text>
        <Text testID={`verdict-${event.uuid}`} style={styles.heading}>{t('verdict')}: {event.verdict ? t(event.verdict) : t('awaitingVerdict')}</Text>
        {capture.offline ? <Text style={styles.text}>{t('offlineReview')}</Text> : null}
        {event.result ? <Text style={styles.text}>{t('score')}: {event.result.verificationScore}/100</Text> : null}
        {event.result?.verificationReasons.length ? <Text selectable style={styles.text}>{t('reasons')}: {'\n'}{event.result.verificationReasons.join('\n')}</Text> : null}
        {event.verdict === 'NEEDS_REVIEW' ? <Notice>{t('reviewNote')}</Notice> : null}
        {event.verdict === 'REJECTED' ? <Notice error>{t('rejectedNote')}</Notice> : null}
        {event.lastError ? <Notice error>{translatedError(event.lastError, t)}</Notice> : null}
        <Text style={styles.small}>{t('attempts')}: {event.attempts}</Text>
        {event.transport === 'PENDING' && event.nextAttemptAt > 0 ? <Text style={styles.small}>{t('nextRetry')}: {event.nextAttemptAt === Number.MAX_SAFE_INTEGER ? t('manualOnly') : formatTime(new Date(event.nextAttemptAt).toISOString(), language)}</Text> : null}
        <Text style={styles.text}>{t('photoCheckpoints')}</Text>
        {(photos[event.uuid] ?? []).map((photo) => <Text key={photo.localId} style={styles.small}>{t(photo.kind)}{photo.stream ? ` / ${t(photo.stream)}` : ''}: {t(photo.stage)}</Text>)}
      </Panel>;
    })}
    {serverStatus !== null ? <Panel><Text style={styles.heading}>{t('lastServerStatus')}</Text><Text selectable style={styles.small}>{JSON.stringify(serverStatus, null, 2)}</Text></Panel> : null}
  </Page>;
}

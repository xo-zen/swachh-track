import { useRef, useState } from 'react';
import { Linking, Modal, Text, View } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { LocalPhoto, PhotoKind, Stream } from './model';
import type { Translate } from './i18n';
import { translatedError } from './i18n';
import { durablePhoto } from './media';
import { errorMessage } from './sync';
import { Action, Notice, styles } from './ui';

export type CameraMode = { kind: 'QR' } | { kind: PhotoKind; stream?: Stream };
export function CameraSheet({ mode, t, onClose, onScan, onPhoto }: { mode: CameraMode; t: Translate; onClose: () => void; onScan: (value: string) => Promise<boolean>; onPhoto: (photo: LocalPhoto) => Promise<void> }) {
  const [permission, requestPermission] = useCameraPermissions();
  const camera = useRef<CameraView>(null);
  const scanning = useRef(false);
  const taking = useRef(false);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function takePhoto(): Promise<void> {
    if (taking.current || !ready || !camera.current || mode.kind === 'QR') return;
    taking.current = true;
    setBusy(true);
    setError('');
    try {
      const picture = await camera.current.takePictureAsync({ quality: 1, exif: false, skipProcessing: false });
      if (!picture) throw new Error('cameraFailed');
      await onPhoto(await durablePhoto(picture, mode.kind, mode.stream));
      onClose();
    } catch (cause) { setError(translatedError(errorMessage(cause), t)); }
    finally { taking.current = false; setBusy(false); }
  }
  async function scan(data: string): Promise<void> {
    if (scanning.current) return;
    scanning.current = true;
    try {
      if (await onScan(data)) onClose();
      else setError(t('invalidIdentity'));
    } catch (cause) { setError(translatedError(errorMessage(cause), t)); }
    finally { scanning.current = false; }
  }
  return <Modal visible animationType="slide" onRequestClose={() => { if (!busy) onClose(); }}>
    <SafeAreaView style={[styles.root, { padding: 16, gap: 14 }]}>
      <Text style={styles.heading}>{t(mode.kind === 'QR' ? 'scanHint' : 'cameraReady')}</Text>
      {error ? <Notice error>{error}</Notice> : null}
      {!permission?.granted ? <>
        <Notice>{t('cameraPermission')}</Notice>
        <Action label={t('allowCamera')} testID="allow-camera" onPress={() => { void requestPermission().catch(() => setError(t('cameraPermission'))); }} />
        <Action label={t('settings')} secondary onPress={() => { void Linking.openSettings().catch(() => setError(t('cameraPermission'))); }} />
      </> : <CameraView ref={camera} style={{ flex: 1, minHeight: 240 }} facing="back" mode="picture" barcodeScannerSettings={{ barcodeTypes: ['qr'] }} onBarcodeScanned={mode.kind === 'QR' ? ({ data }) => { void scan(data); } : undefined} onCameraReady={() => setReady(true)} onMountError={() => setError(t('cameraFailed'))} />}
      <View style={{ gap: 10 }}>
        {mode.kind !== 'QR' ? <Action label={t(busy ? 'working' : 'shutter')} icon="+" testID="camera-shutter" disabled={!ready || busy || !permission?.granted} onPress={() => { void takePhoto(); }} /> : null}
        <Action label={t('close')} secondary disabled={busy} testID="close-camera" onPress={onClose} />
      </View>
    </SafeAreaView>
  </Modal>;
}

import * as FileSystem from 'expo-file-system/legacy';
import * as ImageManipulator from 'expo-image-manipulator';
import * as Crypto from 'expo-crypto';
import * as Location from 'expo-location';
import type { CameraCapturedPicture } from 'expo-camera';
import type { Gps, LocalPhoto, PhotoKind, Stream } from './model';

export async function durablePhoto(picture: CameraCapturedPicture, kind: PhotoKind, stream?: Stream): Promise<LocalPhoto> {
  if (!FileSystem.documentDirectory) throw new Error('storageUnavailable');
  const id = Crypto.randomUUID();
  const directory = `${FileSystem.documentDirectory}evidence/`;
  await FileSystem.makeDirectoryAsync(directory, { intermediates: true });
  const longest = Math.max(picture.width, picture.height);
  const actions = longest > 1280 ? [{ resize: picture.width >= picture.height ? { width: 1280 } : { height: 1280 } }] : [];
  const compressed = await ImageManipulator.manipulateAsync(picture.uri, actions, { compress: 0.65, format: ImageManipulator.SaveFormat.JPEG });
  const uri = `${directory}${id}.jpg`;
  await FileSystem.copyAsync({ from: compressed.uri, to: uri });
  const info = await FileSystem.getInfoAsync(uri);
  if (!info.exists || info.size <= 0) throw new Error('storageUnavailable');
  // Only temporary camera/manipulator files are removed. Durable evidence is never evicted.
  await FileSystem.deleteAsync(picture.uri, { idempotent: true }).catch(() => undefined);
  if (compressed.uri !== picture.uri) await FileSystem.deleteAsync(compressed.uri, { idempotent: true }).catch(() => undefined);
  return { id, uri, kind, ...(stream ? { stream } : {}), capturedAt: new Date().toISOString(), width: compressed.width, height: compressed.height };
}

export async function captureGps(): Promise<Gps> {
  const permission = await Location.requestForegroundPermissionsAsync();
  if (!permission.granted) throw new Error('locationPermission');
  if (!await Location.hasServicesEnabledAsync()) throw new Error('locationDisabled');
  // A foreground watch can be cancelled on timeout; no stale last-known location is used.
  return new Promise<Gps>((resolve, reject) => {
    let subscription: Location.LocationSubscription | undefined;
    let settled = false;
    const finish = (gps?: Gps, error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      subscription?.remove();
      if (gps) resolve(gps); else reject(error ?? new Error('gpsRequired'));
    };
    const timer = setTimeout(() => finish(undefined, new Error('gpsTimeout')), 30_000);
    void Location.watchPositionAsync({ accuracy: Location.Accuracy.High, timeInterval: 1000, distanceInterval: 0 }, (location) => {
      if (Date.now() - location.timestamp > 30_000 || location.coords.accuracy === null) return;
      finish({ latitude: location.coords.latitude, longitude: location.coords.longitude, accuracyM: location.coords.accuracy, gpsCapturedAt: new Date(location.timestamp).toISOString() });
    }).then((watch) => { subscription = watch; if (settled) watch.remove(); }).catch((error: unknown) => finish(undefined, error instanceof Error ? error : new Error('gpsRequired')));
  });
}

export async function uploadJpeg(uri: string, uploadUrl: string): Promise<number> {
  const info = await FileSystem.getInfoAsync(uri);
  if (!info.exists) throw new Error('photoMissing');
  const task = FileSystem.createUploadTask(uploadUrl, uri, { httpMethod: 'PUT', uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT, headers: { 'Content-Type': 'image/jpeg' }, sessionType: FileSystem.FileSystemSessionType.FOREGROUND });
  const timeout = setTimeout(() => { void task.cancelAsync().catch(() => undefined); }, 90_000);
  try {
    const result = await task.uploadAsync();
    if (!result) throw new Error('uploadInterrupted');
    return result.status;
  } finally { clearTimeout(timeout); }
}

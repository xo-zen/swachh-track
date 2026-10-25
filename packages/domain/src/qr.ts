import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export interface QrKey { version: string; secret: string }
const propertyPattern = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;

function signature(propertyId: string, key: QrKey): Buffer {
  if (!key.version.trim() || !key.secret) throw new Error('QR version and secret are required');
  return createHmac('sha256', key.secret).update(JSON.stringify([key.version, propertyId])).digest();
}

export function signQrToken(propertyId: string, key: QrKey): string {
  if (!propertyPattern.test(propertyId)) throw new Error('Property ID must be a UUID');
  return Buffer.from(`${propertyId}.${signature(propertyId, key).toString('base64url')}`, 'utf8').toString('base64url');
}

export function hashQrToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function verifyQrToken(token: string, propertyId: string, key: QrKey, storedTokenHash?: string): boolean {
  if (!propertyPattern.test(propertyId) || token.length > 512 || !/^[\w-]+$/.test(token)) return false;
  const decoded = Buffer.from(token, 'base64url');
  if (decoded.toString('base64url') !== token) return false;
  const parts = decoded.toString('utf8').split('.');
  if (parts.length !== 2 || parts[0] !== propertyId || !/^[\w-]{43}$/.test(parts[1])) return false;
  const provided = Buffer.from(parts[1], 'base64url');
  const expected = signature(propertyId, key);
  if (provided.toString('base64url') !== parts[1] || provided.length !== expected.length || !timingSafeEqual(provided, expected)) return false;
  if (storedTokenHash !== undefined) {
    if (!/^[a-f\d]{64}$/i.test(storedTokenHash)) return false;
    return timingSafeEqual(Buffer.from(hashQrToken(token), 'hex'), Buffer.from(storedTokenHash, 'hex'));
  }
  return true;
}

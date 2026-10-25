import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import sharp from 'sharp';
import { z } from 'zod';
import type { Config } from './config.js';
import { api, authenticate, authorize, constantEqual, fail, hash, hmac, Scope, serialized, streamSchema, uuid, type App } from './core.js';

const MAX_IMAGE = 8 * 1024 * 1024;
export const photoBody = z.object({ kind: z.enum(['DOORSTEP', 'SCALE', 'EXCEPTION', 'RESOLUTION']), stream: streamSchema.optional(), captureSource: z.literal('CAMERA'), contentType: z.literal('image/jpeg') }).strict();

export interface MalwareScanner { scan(bytes: Buffer): Promise<{ status: 'CLEAN' | 'NOT_CONFIGURED' }> }
export class UnconfiguredMalwareScanner implements MalwareScanner {
  async scan(_bytes: Buffer): Promise<{ status: 'NOT_CONFIGURED' }> { return { status: 'NOT_CONFIGURED' }; }
}

export class Storage {
  private client: S3Client | undefined;
  private signingClient: S3Client | undefined;
  constructor(readonly config: Config) {}
  private s3() {
    if (!this.config.S3_ACCESS_KEY || !this.config.S3_SECRET_KEY) fail(503, 'STORAGE_NOT_CONFIGURED', 'Private object storage is not configured.');
    return this.client ??= new S3Client({ endpoint: this.config.S3_ENDPOINT, region: this.config.S3_REGION, forcePathStyle: true, requestChecksumCalculation: 'WHEN_REQUIRED', credentials: { accessKeyId: this.config.S3_ACCESS_KEY!, secretAccessKey: this.config.S3_SECRET_KEY! } });
  }
  private path(key: string) {
    if (!/^[a-zA-Z0-9/_\-.]+$/.test(key) || key.includes('..')) return fail(400, 'STORAGE_KEY_INVALID', 'Invalid storage key.');
    const base = resolve(this.config.LOCAL_STORAGE_PATH);
    return resolve(base, key);
  }
  async url(key: string, action: 'PUT' | 'GET', contentType = 'image/jpeg') {
    if (this.config.STORAGE_DRIVER === 'local') {
      const payload = Buffer.from(JSON.stringify({ key, action, expires: Date.now() + 300000 })).toString('base64url');
      return `${this.config.API_PUBLIC_URL}/api/v1/uploads/${payload}.${hmac(payload, this.config.JWT_SECRET)}`;
    }
    const input = { Bucket: this.config.S3_BUCKET, Key: key };
    const client = this.config.S3_PUBLIC_ENDPOINT ? this.signingClient ??= new S3Client({ endpoint: this.config.S3_PUBLIC_ENDPOINT, region: this.config.S3_REGION, forcePathStyle: true, requestChecksumCalculation: 'WHEN_REQUIRED', credentials: { accessKeyId: this.config.S3_ACCESS_KEY ?? '', secretAccessKey: this.config.S3_SECRET_KEY ?? '' } }) : this.s3();
    return getSignedUrl(client, action === 'PUT' ? new PutObjectCommand({ ...input, ContentType: contentType }) : new GetObjectCommand(input), { expiresIn: 300 });
  }
  parseToken(token: string, action: string) {
    if (this.config.STORAGE_DRIVER !== 'local') return fail(404, 'NOT_FOUND', 'Local uploads are disabled.');
    const [payload, signature] = token.split('.');
    if (!payload || !signature || !constantEqual(signature, hmac(payload, this.config.JWT_SECRET))) return fail(403, 'UPLOAD_SIGNATURE', 'Invalid upload capability.');
    try {
      const parsed = z.object({ key: z.string(), action: z.string(), expires: z.number() }).strict().parse(JSON.parse(Buffer.from(payload, 'base64url').toString()));
      if (parsed.action !== action || parsed.expires < Date.now()) return fail(403, 'UPLOAD_EXPIRED', 'This capability expired or cannot perform this operation.');
      return parsed.key;
    } catch { return fail(403, 'UPLOAD_SIGNATURE', 'Invalid or expired capability.'); }
  }
  async read(key: string) {
    if (this.config.STORAGE_DRIVER === 'local') {
      try {
        const bytes = await readFile(this.path(key));
        if (bytes.length > MAX_IMAGE) fail(422, 'IMAGE_TOO_LARGE', 'Maximum image size is 8 MiB.');
        return bytes;
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return fail(422, 'UPLOAD_MISSING', 'Upload actual image bytes before confirming.');
        throw error;
      }
    }
    try {
      const input = { Bucket: this.config.S3_BUCKET, Key: key };
      const head = await this.s3().send(new HeadObjectCommand(input));
      if (!head.ContentLength || head.ContentLength > MAX_IMAGE) fail(422, 'IMAGE_TOO_LARGE', 'Image must contain 1 byte to 8 MiB.');
      const result = await this.s3().send(new GetObjectCommand(input));
      if (!result.Body) return fail(422, 'UPLOAD_MISSING', 'Uploaded object is empty.');
      return Buffer.from(await result.Body.transformToByteArray());
    } catch (error) {
      if (error instanceof Error && ['NotFound', 'NoSuchKey'].includes(error.name)) return fail(422, 'UPLOAD_MISSING', 'Upload actual image bytes before confirming.');
      throw error;
    }
  }
  async write(key: string, bytes: Buffer, contentType = 'image/jpeg') {
    if (bytes.length > MAX_IMAGE) fail(413, 'IMAGE_TOO_LARGE', 'Maximum upload size is 8 MiB.');
    if (this.config.STORAGE_DRIVER === 'local') {
      const path = this.path(key); await mkdir(dirname(path), { recursive: true }); await writeFile(path, bytes);
    } else await this.s3().send(new PutObjectCommand({ Bucket: this.config.S3_BUCKET, Key: key, Body: bytes, ContentType: contentType }));
  }
}

export async function reservePhoto(app: App, scope: Scope, body: z.infer<typeof photoBody>, clientUuid?: string) {
  if (body.kind === 'SCALE' && !body.stream) fail(422, 'STREAM_REQUIRED', 'A scale photo requires its stream.');
  const id = randomUUID();
  const storageKey = `${scope.ulbId}/${scope.userId}/${id}.upload`;
  // Create the reservation only after storage configuration has successfully produced a capability.
  const uploadUrl = await app.storage.url(storageKey, 'PUT');
  await scope.db.photo.create({ data: { id, ulbId: scope.ulbId, ownerId: scope.userId, clientUuid, kind: body.kind, stream: body.stream, captureSource: body.captureSource, storageKey, expiresAt: new Date(Date.now() + 300000) } });
  return { photoId: id, uploadUrl, expiresIn: 300 };
}

export async function confirmPhoto(app: App, scope: Scope, photoId: string, clientUuid?: string) {
  return serialized(app.db, `photo:${photoId}`, async tx => {
    const row = await tx.photo.findFirst({ where: { id: photoId, ulbId: scope.ulbId, ownerId: scope.userId, ...(clientUuid ? { clientUuid } : {}) } });
    if (!row) return fail(404, 'NOT_FOUND', 'Photo reservation not found.');
    if (row.status === 'CONFIRMED') return { photoId: row.id, status: row.status, sha256: row.sha256, width: row.width, height: row.height, size: row.size };
    if (row.expiresAt.getTime() < Date.now()) fail(422, 'UPLOAD_EXPIRED', 'Create a new photo reservation.');
    const original = await app.storage.read(row.storageKey);
    let normalized: { data: Buffer; info: sharp.OutputInfo };
    try {
      const image = sharp(original, { limitInputPixels: 25_000_000, failOn: 'error' });
      const metadata = await image.metadata();
      if (metadata.format !== 'jpeg') return fail(422, 'IMAGE_FORMAT_INVALID', 'The bytes must be a JPEG image.');
      normalized = await image.rotate().resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 85, mozjpeg: true }).toBuffer({ resolveWithObject: true });
    } catch { return fail(422, 'IMAGE_DECODE_FAILED', 'The upload is not a decodable JPEG image.'); }
    const sha256 = hash(normalized.data);
    const key = `${scope.ulbId}/${scope.userId}/${row.id}.normalized.jpg`;
    await app.storage.write(key, normalized.data);
    const updated = await tx.photo.update({ where: { id: row.id, ulbId: scope.ulbId }, data: { storageKey: key, sha256, width: normalized.info.width, height: normalized.info.height, size: normalized.data.length, confirmedAt: new Date(), status: 'CONFIRMED' } });
    return { photoId: updated.id, status: updated.status, sha256, width: updated.width, height: updated.height, size: updated.size };
  });
}

export async function uploadRoutes(app: App) {
  const router = api(app);
  // This parser is confined to the API plugin and only accepts raw bytes for the signed upload route.
  app.addContentTypeParser(['image/jpeg', 'image/png', 'image/webp', 'application/pdf'], { parseAs: 'buffer', bodyLimit: MAX_IMAGE }, (_request, body, done) => done(null, body));
  router.put('/uploads/:token', { bodyLimit: MAX_IMAGE, schema: { params: z.object({ token: z.string().max(2000) }).strict() } }, async (request, reply) => {
    const key = app.storage.parseToken(request.params.token, 'PUT');
    const reservation = await app.db.photo.findFirst({ where: { storageKey: key, status: 'RESERVED', expiresAt: { gt: new Date() } } });
    const upload = reservation ? null : await app.db.upload.findFirst({ where: { storageKey: key, status: 'RESERVED', expiresAt: { gt: new Date() } } });
    if (!reservation && !upload) return fail(403, 'UPLOAD_CLOSED', 'This upload reservation is closed.');
    const contentType = upload?.contentType ?? 'image/jpeg';
    if (!Buffer.isBuffer(request.body) || request.headers['content-type'] !== contentType) return fail(415, 'CONTENT_TYPE_INVALID', 'Upload raw bytes with the reserved content type.');
    await app.storage.write(key, request.body, contentType);
    return reply.code(204).send();
  });
  router.get('/uploads/:token', { schema: { params: z.object({ token: z.string().max(2000) }).strict() } }, async (request, reply) => {
    const key = app.storage.parseToken(request.params.token, 'GET');
    return reply.header('Cache-Control', 'private, no-store').header('Content-Disposition', key.endsWith('.pdf') ? 'attachment; filename="document.pdf"' : 'inline').type(key.endsWith('.pdf') ? 'application/pdf' : 'image/jpeg').send(await app.storage.read(key));
  });
  router.post('/photos/presign', { preHandler: authenticate, schema: { body: photoBody } }, async request => reservePhoto(app, new Scope(request), request.body));
  router.post('/files/presign', { preHandler: authenticate, schema: { body: z.object({ filename: z.string().min(1).max(200), contentType: z.enum(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']), size: z.number().int().min(1).max(MAX_IMAGE), purpose: z.enum(['COMPLAINT', 'RESOLUTION', 'COMPLIANCE', 'DOCUMENT', 'PROCESSING', 'HANDOVER']) }).strict() } }, async request => {
    const scope = new Scope(request);
    if (scope.membership.role === 'COLLECTOR') return fail(403, 'CAMERA_CAPTURE_REQUIRED', 'Collectors must use the camera-evidence upload flow.');
    const id = randomUUID(); const storageKey = `${scope.ulbId}/${scope.userId}/${id}.upload`;
    const uploadUrl = await app.storage.url(storageKey, 'PUT', request.body.contentType);
    await app.db.upload.create({ data: { ...request.body, id, ulbId: scope.ulbId, ownerId: scope.userId, storageKey, expiresAt: new Date(Date.now() + 300000) } });
    return { fileId: id, uploadUrl, expiresIn: 300 };
  });
  router.post('/files/:id/confirm', { preHandler: authenticate, schema: { params: z.object({ id: uuid }).strict(), body: z.object({}).strict() } }, async request => {
    const scope = new Scope(request);
    return serialized(app.db, `file:${request.params.id}`, async tx => {
      const upload = await tx.upload.findFirst({ where: { id: request.params.id, ulbId: scope.ulbId, ownerId: scope.userId } });
      if (!upload) return fail(404, 'NOT_FOUND', 'Upload not found.');
      if (upload.status === 'CONFIRMED') return { fileId: upload.id, storageKey: upload.storageKey, sha256: upload.sha256, status: upload.status, scanStatus: upload.scanStatus };
      if (upload.expiresAt < new Date()) return fail(422, 'UPLOAD_EXPIRED', 'Reserve the file again.');
      let bytes = await app.storage.read(upload.storageKey); let width: number | undefined; let height: number | undefined;
      if (bytes.length !== upload.size) return fail(422, 'FILE_SIZE_MISMATCH', 'Uploaded bytes do not match the reserved size.');
      if (upload.contentType === 'application/pdf') {
        if (!bytes.subarray(0, 5).equals(Buffer.from('%PDF-')) || !bytes.subarray(-1024).includes(Buffer.from('%%EOF'))) return fail(422, 'PDF_INVALID', 'The file does not have a valid PDF envelope.');
      } else {
        try {
          const normalized = await sharp(bytes, { limitInputPixels: 25_000_000, failOn: 'error' }).rotate().resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer({ resolveWithObject: true });
          bytes = normalized.data; width = normalized.info.width; height = normalized.info.height;
        } catch { return fail(422, 'IMAGE_DECODE_FAILED', 'The file is not a decodable image.'); }
      }
      const pdf = upload.contentType === 'application/pdf';
      const storageKey = `${scope.ulbId}/${scope.userId}/${upload.id}.${pdf ? 'pdf' : 'normalized.jpg'}`;
      const sha256 = hash(bytes); await app.storage.write(storageKey, bytes, pdf ? 'application/pdf' : 'image/jpeg');
      if (!pdf) await tx.photo.create({ data: { id: upload.id, ulbId: scope.ulbId, ownerId: scope.userId, kind: upload.purpose === 'RESOLUTION' ? 'RESOLUTION' : 'EXCEPTION', captureSource: 'UPLOAD', storageKey, sha256, width, height, size: bytes.length, status: 'CONFIRMED', expiresAt: upload.expiresAt, confirmedAt: new Date() } });
      await tx.upload.update({ where: { id: upload.id, ulbId: scope.ulbId }, data: { storageKey, sha256, status: 'CONFIRMED', confirmedAt: new Date() } });
      return { fileId: upload.id, photoId: pdf ? null : upload.id, storageKey, sha256, status: 'CONFIRMED', scanStatus: 'NOT_CONFIGURED' };
    });
  });
  router.post('/photos/:photoId/confirm', { preHandler: authenticate, schema: { params: z.object({ photoId: uuid }).strict(), body: z.object({}).strict().optional() } }, async request => confirmPhoto(app, new Scope(request), request.params.photoId));
  router.get('/photos/:photoId', { preHandler: authenticate, schema: { params: z.object({ photoId: uuid }).strict() } }, async request => {
    const scope = new Scope(request);
    const photo = await app.db.photo.findFirst({ where: { id: request.params.photoId, ulbId: scope.ulbId, status: 'CONFIRMED' } });
    if (!photo) return fail(404, 'NOT_FOUND', 'Photo not found.');
    if (photo.ownerId !== scope.userId) {
      if (photo.pickupEventId) await scope.pickup(photo.pickupEventId);
      else {
        const complaint = await app.db.complaint.findFirst({ where: { ulbId: scope.ulbId, OR: [{ photoId: photo.id }, { resolutionPhotoId: photo.id }] } });
        if (complaint) await scope.property(complaint.propertyId);
        else {
          const document = await app.db.complianceDocument.findFirst({ where: { ulbId: scope.ulbId, photoId: photo.id } });
          if (!document || !['SOCIETY_ADMIN', 'ULB_ADMIN', 'SUPER_ADMIN'].includes(scope.membership.role)) return fail(404, 'NOT_FOUND', 'Photo not found.');
          await scope.society(document.societyId);
        }
      }
    }
    return { photoId: photo.id, url: await app.storage.url(photo.storageKey, 'GET'), expiresIn: 300, sha256: photo.sha256 };
  });
  router.post('/collector/pickups/:id/photos/presign', { preHandler: authorize('COLLECTOR'), schema: { params: z.object({ id: uuid }).strict(), body: photoBody } }, async request => {
    const scope = new Scope(request); await scope.collector();
    return reservePhoto(app, scope, request.body, request.params.id);
  });
  router.post('/collector/pickups/:id/photos/:photoId/confirm', { preHandler: authorize('COLLECTOR'), schema: { params: z.object({ id: uuid, photoId: uuid }).strict(), body: z.object({}).strict().optional() } }, async request => confirmPhoto(app, new Scope(request), request.params.photoId, request.params.id));
}

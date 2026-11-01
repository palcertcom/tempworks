import { Injectable, Logger, OnModuleInit, InternalServerErrorException, ConflictException, Optional } from '@nestjs/common';
import {
  S3Client,
  PutObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
} from '@aws-sdk/client-s3';
import { promises as fs } from 'fs';
import { createHash } from 'crypto';
import { extname, join } from 'path';
import { v4 as uuidv4 } from 'uuid';
import { PrismaService } from '../../prisma/prisma.service';

export type StorageDriver = 'spaces' | 'local';

export interface UploadOptions {
  /** Logical key prefix, e.g. `users/{id}/avatars`. The service appends `<uuid>.<ext>`. */
  keyPrefix: string;
  /** MIME type from Multer's file.mimetype. Stored as ContentType on the object. */
  contentType: string;
  /** Original filename — used only to derive the safe extension. */
  originalName: string;
  /** When true, sets `Content-Disposition: inline` (images/PDFs in browser). */
  inline?: boolean;
  /** Override the auto-generated UUID file basename. */
  filename?: string;
}

export interface UploadResult {
  /** S3 object key, e.g. `users/123/avatars/uuid.jpg` (no leading slash). */
  key: string;
  /** Public URL — served directly by the Spaces bucket (or local /uploads route). */
  url: string;
  contentType: string;
  size: number;
}

/**
 * StorageService — single point of contact for file storage. Backed by
 * DigitalOcean Spaces (S3-compatible) in production and the local
 * `./uploads` folder in development. The driver is selected at boot via
 * UPLOAD_STORAGE_DRIVER and is fully transparent to the callers.
 *
 * URL strategy: callers store the full public URL in DB fields like
 * `photoUrl` / `fileUrl` / `logoUrl`, matching the existing frontend
 * contract (no schema changes required). `extractKeyFromUrl` lets us
 * recover the object key for delete operations.
 */
@Injectable()
export class StorageService implements OnModuleInit {
  private readonly logger = new Logger(StorageService.name);
  private client?: S3Client;
  private driver: StorageDriver;
  private bucket = '';
  private publicBaseUrl = '';
  private localRoot = '';

  // Optional so scripts/harnesses that construct `new StorageService()`
  // keep the previous immediate-delete behaviour.
  constructor(@Optional() private readonly prisma?: PrismaService) {
    this.driver = (process.env.UPLOAD_STORAGE_DRIVER as StorageDriver) || 'local';
  }

  /**
   * Deferred deletion is ON whenever the database is available, unless
   * STORAGE_DEFERRED_DELETE=off. Deleted objects are queued and physically
   * removed later by StoragePurgeService — never while a backup is running and
   * never while a row still references them. This keeps every object that a
   * backup's database snapshot references present until its file capture
   * finishes, so concurrent deletions/replacements cannot make a backup
   * inconsistent.
   */
  private deferredDeletes(): boolean {
    return !!this.prisma && process.env.STORAGE_DEFERRED_DELETE !== 'off';
  }

  private async enqueuePurge(objectKey: string, originalRef: string, legacyLocal: boolean): Promise<void> {
    await this.prisma!.$executeRawUnsafe(
      `INSERT INTO "storage_purge_queue" ("id","objectKey","originalRef","driver","legacyLocal") VALUES ($1,$2,$3,$4,$5)`,
      uuidv4(), objectKey, originalRef, this.driver, legacyLocal,
    );
  }

  onModuleInit() {
    if (this.driver === 'spaces') {
      const endpoint = process.env.DO_SPACES_ENDPOINT;
      const region = process.env.DO_SPACES_REGION;
      const accessKeyId = process.env.DO_SPACES_ACCESS_KEY;
      const secretAccessKey = process.env.DO_SPACES_SECRET_KEY;
      this.bucket = process.env.DO_SPACES_BUCKET || '';
      this.publicBaseUrl = (process.env.DO_SPACES_PUBLIC_URL || '').replace(/\/+$/, '');

      const missing = Object.entries({
        DO_SPACES_ENDPOINT: endpoint,
        DO_SPACES_REGION: region,
        DO_SPACES_BUCKET: this.bucket,
        DO_SPACES_ACCESS_KEY: accessKeyId,
        DO_SPACES_SECRET_KEY: secretAccessKey,
        DO_SPACES_PUBLIC_URL: this.publicBaseUrl,
      })
        .filter(([, v]) => !v)
        .map(([k]) => k);

      if (missing.length > 0) {
        const msg = `UPLOAD_STORAGE_DRIVER=spaces but missing env vars: ${missing.join(', ')}`;
        this.logger.error(msg);
        throw new InternalServerErrorException(msg);
      }

      this.client = new S3Client({
        endpoint,
        region: region!,
        credentials: { accessKeyId: accessKeyId!, secretAccessKey: secretAccessKey! },
        // Virtual-hosted-style for DO Spaces/AWS; set DO_SPACES_FORCE_PATH_STYLE=1
        // for MinIO or other S3-compatible endpoints that require path-style.
        forcePathStyle: process.env.DO_SPACES_FORCE_PATH_STYLE === '1' || process.env.DO_SPACES_FORCE_PATH_STYLE === 'true',
      });
      this.logger.log(`Storage driver: spaces (bucket=${this.bucket}, public=${this.publicBaseUrl})`);
    } else {
      this.localRoot = process.env.UPLOAD_DEST || './uploads';
      this.logger.log(`Storage driver: local (root=${this.localRoot})`);
    }
  }

  /** Strip leading dots, collapse to a single safe extension (max 10 chars, alnum). */
  private safeExt(originalName: string): string {
    const raw = extname(originalName || '').toLowerCase();
    if (!raw) return '';
    const cleaned = raw.replace(/[^a-z0-9.]/g, '');
    return cleaned.length > 10 ? cleaned.slice(0, 10) : cleaned;
  }

  /** Build a key like `<keyPrefix>/<uuid>.<ext>`, never including the original filename. */
  buildKey(keyPrefix: string, originalName: string, filename?: string): string {
    const prefix = keyPrefix.replace(/^\/+|\/+$/g, '');
    const ext = this.safeExt(originalName);
    const base = filename || `${uuidv4()}${ext}`;
    return `${prefix}/${base}`;
  }

  /** Upload a buffer. Returns the object key + public URL to persist on the DB row. */
  async uploadFile(buffer: Buffer, opts: UploadOptions): Promise<UploadResult> {
    const key = this.buildKey(opts.keyPrefix, opts.originalName, opts.filename);
    const contentType = opts.contentType || 'application/octet-stream';
    const inline = opts.inline ?? this.shouldInline(contentType);

    if (this.driver === 'spaces' && this.client) {
      // Write-once keys: never overwrite an existing object. Keys are
      // <prefix>/<uuid>.<ext>, so a collision means a caller passed an explicit
      // filename that already exists — refuse instead of silently replacing
      // bytes that database rows (and backups) already reference.
      if (await this.objectExists(key)) {
        throw new ConflictException({ code: 'STORAGE.KEY_EXISTS', message: `Storage key already exists: ${key}` });
      }
      await this.client.send(new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: buffer,
        ContentType: contentType,
        ContentDisposition: inline ? 'inline' : 'attachment',
        ACL: 'public-read',
        // Version evidence for disaster recovery: the object was written by the
        // app (write-once: never overwritten), under a generated unique key,
        // with this content hash. Backups record it, so a copy taken from an
        // earlier snapshot can be PROVEN to be the version the database
        // references (scripts/dr/snapshot-engine.mjs).
        Metadata: {
          'tw-sha256': createHash('sha256').update(buffer).digest('hex'),
          'tw-write-once': '1',
          ...(opts.filename ? {} : { 'tw-unique-key': '1' }),
        },
      }));
      return { key, url: `${this.publicBaseUrl}/${key}`, contentType, size: buffer.length };
    }

    // Local driver — write to disk under <localRoot>/<key>
    const absPath = join(this.localRoot, key);
    await fs.mkdir(join(absPath, '..'), { recursive: true });
    try {
      await fs.writeFile(absPath, buffer, { flag: 'wx' }); // create-only (write-once keys)
    } catch (err: any) {
      if (err?.code === 'EEXIST') {
        throw new ConflictException({ code: 'STORAGE.KEY_EXISTS', message: `Storage key already exists: ${key}` });
      }
      throw err;
    }
    return { key, url: `/uploads/${key}`, contentType, size: buffer.length };
  }

  /**
   * Delete an object given either a full URL (Spaces or legacy /uploads),
   * or a bare object key. Errors are logged but never thrown — call sites
   * must continue when cleanup fails.
   */
  async deleteFileByUrlOrKey(urlOrKey: string | null | undefined): Promise<void> {
    if (!urlOrKey) return;
    const key = this.extractKeyFromUrl(urlOrKey);
    if (!key) return;
    if (this.deferredDeletes()) {
      try {
        await this.enqueuePurge(key, urlOrKey, this.isLegacyLocalUrl(urlOrKey));
        return;
      } catch (err: any) {
        // Queue table missing (e.g. before the first boot heal) — fall back.
        this.logger.warn(`purge queue unavailable, deleting immediately: ${err?.message ?? err}`);
      }
    }
    await this.deleteNow(urlOrKey);
  }

  /** Physically delete an object NOW (used by the purge worker and as fallback). */
  async deleteNow(urlOrKey: string): Promise<void> {
    const key = this.extractKeyFromUrl(urlOrKey);
    if (!key) return;

    // Legacy local /uploads URLs — best-effort filesystem unlink.
    // Files were served by express.static from `<cwd>/uploads`, so map
    // the URL back to that exact path regardless of UPLOAD_DEST (which
    // historically also defaulted to ./uploads).
    if (this.isLegacyLocalUrl(urlOrKey)) {
      try {
        const rel = urlOrKey.replace(/^\/+uploads\/+/, '');
        await fs.unlink(join(process.cwd(), 'uploads', rel));
      } catch (err: any) {
        if (err?.code !== 'ENOENT') {
          this.logger.warn(`Local unlink failed for ${urlOrKey}: ${err?.message ?? err}`);
        }
      }
      return;
    }

    if (this.driver === 'spaces' && this.client) {
      try {
        await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
      } catch (err: any) {
        this.logger.warn(`Spaces delete failed for ${key}: ${err?.message ?? err}`);
      }
      return;
    }

    // Local driver fallback (key-style without /uploads prefix).
    try {
      await fs.unlink(join(this.localRoot, key));
    } catch (err: any) {
      if (err?.code !== 'ENOENT') {
        this.logger.warn(`Local unlink failed for ${key}: ${err?.message ?? err}`);
      }
    }
  }

  /**
   * Delete every object whose key starts with the given prefix. No-op on
   * the local driver (callers fall back to per-file deletes). Used by
   * application-drafts to wipe `application-drafts/{id}/`.
   */
  async deleteByPrefix(prefix: string): Promise<void> {
    if (!prefix) return;
    const cleanPrefix = prefix.replace(/^\/+|\/+$/g, '') + '/';
    if (this.deferredDeletes()) {
      try {
        for (const key of await this.listKeys(cleanPrefix)) await this.enqueuePurge(key, key, false);
        return;
      } catch (err: any) {
        this.logger.warn(`purge queue unavailable, deleting prefix immediately: ${err?.message ?? err}`);
      }
    }

    if (this.driver === 'spaces' && this.client) {
      try {
        let continuationToken: string | undefined;
        do {
          const list = await this.client.send(new ListObjectsV2Command({
            Bucket: this.bucket,
            Prefix: cleanPrefix,
            ContinuationToken: continuationToken,
          }));
          const objects = (list.Contents ?? []).map(o => ({ Key: o.Key! })).filter(o => !!o.Key);
          if (objects.length > 0) {
            await this.client.send(new DeleteObjectsCommand({
              Bucket: this.bucket,
              Delete: { Objects: objects, Quiet: true },
            }));
          }
          continuationToken = list.IsTruncated ? list.NextContinuationToken : undefined;
        } while (continuationToken);
      } catch (err: any) {
        this.logger.warn(`Spaces deleteByPrefix failed for ${cleanPrefix}: ${err?.message ?? err}`);
      }
      return;
    }

    // Local driver — best-effort recursive remove.
    try {
      await fs.rm(join(this.localRoot, cleanPrefix), { recursive: true, force: true });
    } catch (err: any) {
      this.logger.warn(`Local rm failed for ${cleanPrefix}: ${err?.message ?? err}`);
    }
  }

  /** True if an object with this key already exists in the active store. */
  async objectExists(key: string): Promise<boolean> {
    if (this.driver === 'spaces' && this.client) {
      try {
        await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
        return true;
      } catch (err: any) {
        if (err?.name === 'NotFound' || err?.$metadata?.httpStatusCode === 404) return false;
        throw err;
      }
    }
    try { await fs.access(join(this.localRoot, key)); return true; } catch { return false; }
  }

  /** All object keys under a prefix (used to queue prefix deletions). */
  private async listKeys(prefix: string): Promise<string[]> {
    const keys: string[] = [];
    if (this.driver === 'spaces' && this.client) {
      let token: string | undefined;
      do {
        const out = await this.client.send(new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, ContinuationToken: token }));
        for (const o of out.Contents ?? []) if (o.Key) keys.push(o.Key);
        token = out.IsTruncated ? out.NextContinuationToken : undefined;
      } while (token);
      return keys;
    }
    const walk = async (dir: string, rel: string) => {
      let entries: any[] = [];
      try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) await walk(join(dir, e.name), r); else keys.push(`${prefix}${r}`);
      }
    };
    await walk(join(this.localRoot, prefix), '');
    return keys;
  }

  /** Build the public URL for a stored object key. */
  getPublicUrl(key: string): string {
    const cleaned = key.replace(/^\/+/, '');
    if (this.driver === 'spaces') return `${this.publicBaseUrl}/${cleaned}`;
    return `/uploads/${cleaned}`;
  }

  /**
   * Recover the object key from any storage URL we know about — Spaces
   * public URL, legacy `/uploads/...` path, or a bare key. Returns `null`
   * for inputs we can't classify (so callers skip cleanup safely).
   */
  extractKeyFromUrl(urlOrKey: string): string | null {
    if (!urlOrKey) return null;
    // Spaces public URL — strip the configured prefix.
    if (this.publicBaseUrl && urlOrKey.startsWith(this.publicBaseUrl + '/')) {
      return urlOrKey.slice(this.publicBaseUrl.length + 1);
    }
    // Legacy local URL — return the path under /uploads/ as a key-shaped string.
    if (urlOrKey.startsWith('/uploads/')) {
      return urlOrKey.slice('/uploads/'.length);
    }
    // Already a bare key.
    if (!/^https?:\/\//i.test(urlOrKey)) {
      return urlOrKey.replace(/^\/+/, '');
    }
    return null;
  }

  /** True when the URL points at the legacy local /uploads route. */
  isLegacyLocalUrl(url: string): boolean {
    return typeof url === 'string' && url.startsWith('/uploads/');
  }

  /** Inline-render images and PDFs by default; everything else attaches. */
  private shouldInline(contentType: string): boolean {
    return contentType.startsWith('image/') || contentType === 'application/pdf';
  }

  getDriver(): StorageDriver {
    return this.driver;
  }
}

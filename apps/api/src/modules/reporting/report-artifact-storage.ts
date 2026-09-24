import { createHash, randomUUID } from 'node:crypto';
import { link, lstat, mkdir, open, realpath, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

import type { ReportPdfPublisher } from './reporting.service.js';

const PDF_MIME_TYPE = 'application/pdf' as const;
const DEFAULT_RETENTION_DAYS = 90;
const REPORT_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const WINDOWS_DEVICE_NAME_PATTERN = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
const CHECKSUM_PATTERN = /^[a-f0-9]{64}$/;
const PDF_SIGNATURE = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]);

export type StoredReportArtifact = {
  reportId: string;
  storageKey: string;
  fileName: string;
  mimeType: typeof PDF_MIME_TYPE;
  sizeBytes: number;
  checksumSha256: string;
  createdAt: string;
  expiresAt: string;
  pdfFileReference: string;
};

export type RetrievedReportArtifact = {
  metadata: StoredReportArtifact;
  bytes: Uint8Array;
};

export type LocalReportArtifactStorageOptions = {
  rootDirectory: string;
  retentionDays?: number;
  now?: () => Date;
};

export class ReportArtifactConflictError extends Error {
  constructor(reportId: string) {
    super(`Report artifact "${reportId}" already exists with different PDF bytes.`);
    this.name = 'ReportArtifactConflictError';
  }
}

export class ReportArtifactCorruptionError extends Error {
  constructor(reportId: string, cause?: unknown) {
    super(`Stored report artifact "${reportId}" is missing or corrupted.`, { cause });
    this.name = 'ReportArtifactCorruptionError';
  }
}

function validateReportId(reportId: string): void {
  if (!REPORT_ID_PATTERN.test(reportId) || WINDOWS_DEVICE_NAME_PATTERN.test(reportId)) {
    throw new TypeError(
      'Report ID must contain only safe letters, numbers, underscores, and hyphens.',
    );
  }
}

function validateFileName(fileName: string): void {
  if (
    fileName.length === 0 ||
    fileName === '.' ||
    fileName === '..' ||
    fileName.includes('/') ||
    fileName.includes('\\') ||
    Array.from(fileName).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) ||
    !/\.pdf$/i.test(fileName)
  ) {
    throw new TypeError('File name must be a safe PDF basename.');
  }
}

function validatePdfBytes(bytes: Uint8Array): void {
  if (
    bytes.byteLength < PDF_SIGNATURE.byteLength ||
    PDF_SIGNATURE.some((byte, index) => bytes[index] !== byte)
  ) {
    throw new TypeError('PDF bytes must be non-empty and begin with %PDF-.');
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function reportStoragePrefix(reportId: string): string {
  return createHash('sha256').update(reportId, 'utf8').digest('hex');
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

function isIsoDate(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === value;
}

function resolveDirectChild(rootDirectory: string, fileName: string): string {
  const target = resolve(rootDirectory, fileName);
  const relativePath = relative(rootDirectory, target);
  if (
    relativePath.length === 0 ||
    isAbsolute(relativePath) ||
    relativePath === '..' ||
    relativePath.startsWith(`..${sep}`) ||
    relativePath.includes(sep)
  ) {
    throw new Error('Report artifact path must be a direct child of the storage root.');
  }
  return target;
}

export class LocalReportArtifactStorage implements ReportPdfPublisher {
  readonly #configuredRootDirectory: string;
  readonly #retentionDays: number;
  readonly #now: () => Date;

  constructor(options: LocalReportArtifactStorageOptions) {
    if (options.rootDirectory.trim().length === 0) {
      throw new TypeError('Report storage root directory must not be empty.');
    }

    const retentionDays = options.retentionDays ?? DEFAULT_RETENTION_DAYS;
    if (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 3650) {
      throw new TypeError('Report retention days must be an integer from 1 through 3650.');
    }

    this.#configuredRootDirectory = resolve(options.rootDirectory);
    this.#retentionDays = retentionDays;
    this.#now = options.now ?? (() => new Date());
  }

  async publish(input: {
    reportId: string;
    fileName: string;
    bytes: Uint8Array;
  }): Promise<StoredReportArtifact> {
    validateReportId(input.reportId);
    validateFileName(input.fileName);
    validatePdfBytes(input.bytes);

    const rootDirectory = await this.#prepareRootDirectory();
    const checksumSha256 = sha256(input.bytes);
    const storagePrefix = reportStoragePrefix(input.reportId);
    const storageKey = `${storagePrefix}--${checksumSha256}.pdf`;
    const pdfPath = resolveDirectChild(rootDirectory, storageKey);
    const metadataPath = resolveDirectChild(rootDirectory, this.#metadataFileName(input.reportId));

    const existing = await this.#retrieveFromRoot(input.reportId, rootDirectory);
    if (existing !== null) {
      if (existing.metadata.checksumSha256 === checksumSha256) return existing.metadata;
      throw new ReportArtifactConflictError(input.reportId);
    }

    const createdAtDate = this.#now();
    if (Number.isNaN(createdAtDate.valueOf())) {
      throw new TypeError('Report storage clock returned an invalid date.');
    }
    const expiresAtDate = new Date(createdAtDate.valueOf());
    expiresAtDate.setUTCDate(expiresAtDate.getUTCDate() + this.#retentionDays);

    const metadata: StoredReportArtifact = {
      reportId: input.reportId,
      storageKey,
      fileName: input.fileName,
      mimeType: PDF_MIME_TYPE,
      sizeBytes: input.bytes.byteLength,
      checksumSha256,
      createdAt: createdAtDate.toISOString(),
      expiresAt: expiresAtDate.toISOString(),
      pdfFileReference: `/api/v1/reports/${input.reportId}/download`,
    };

    const temporarySuffix = randomUUID();
    const temporaryPdfPath = resolveDirectChild(
      rootDirectory,
      `.${storagePrefix}--${checksumSha256}.${temporarySuffix}.pdf.tmp`,
    );
    const temporaryMetadataPath = resolveDirectChild(
      rootDirectory,
      `.${storagePrefix}.${temporarySuffix}.metadata.json.tmp`,
    );

    try {
      await writeFile(temporaryPdfPath, input.bytes, { flag: 'wx' });
      await writeFile(temporaryMetadataPath, `${JSON.stringify(metadata, null, 2)}\n`, {
        encoding: 'utf8',
        flag: 'wx',
      });

      try {
        await link(temporaryPdfPath, pdfPath);
      } catch (error) {
        if (!isNodeError(error, 'EEXIST')) throw error;
        await this.#readAndValidatePdf(input.reportId, pdfPath, metadata);
      }

      try {
        await link(temporaryMetadataPath, metadataPath);
      } catch (error) {
        if (!isNodeError(error, 'EEXIST')) throw error;

        const winner = await this.#retrieveFromRoot(input.reportId, rootDirectory);
        if (winner === null) {
          throw new ReportArtifactCorruptionError(
            input.reportId,
            new Error('Metadata claim exists but cannot be retrieved.'),
          );
        }
        if (winner.metadata.checksumSha256 === checksumSha256) return winner.metadata;
        throw new ReportArtifactConflictError(input.reportId);
      }

      return metadata;
    } finally {
      await Promise.all([
        rm(temporaryPdfPath, { force: true }),
        rm(temporaryMetadataPath, { force: true }),
      ]);
    }
  }

  async retrieve(reportId: string): Promise<RetrievedReportArtifact | null> {
    validateReportId(reportId);
    const rootDirectory = await this.#locateRootDirectory();
    if (rootDirectory === null) return null;
    return this.#retrieveFromRoot(reportId, rootDirectory);
  }

  async #prepareRootDirectory(): Promise<string> {
    await mkdir(this.#configuredRootDirectory, { recursive: true });
    return this.#validateRootDirectory();
  }

  async #locateRootDirectory(): Promise<string | null> {
    try {
      await lstat(this.#configuredRootDirectory);
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) return null;
      throw error;
    }
    return this.#validateRootDirectory();
  }

  async #validateRootDirectory(): Promise<string> {
    const stats = await lstat(this.#configuredRootDirectory);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new Error('Report storage root must be a real directory, not a symbolic link.');
    }

    // This operator-configured directory is the trusted storage boundary. All
    // report-controlled paths below it are validated flat direct-child names.
    return realpath(this.#configuredRootDirectory);
  }

  async #retrieveFromRoot(
    reportId: string,
    rootDirectory: string,
  ): Promise<RetrievedReportArtifact | null> {
    const metadataPath = resolveDirectChild(rootDirectory, this.#metadataFileName(reportId));

    let serializedMetadata: string;
    try {
      serializedMetadata = (await this.#readStableRegularFile(metadataPath)).toString('utf8');
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) return null;
      if (error instanceof ReportArtifactCorruptionError) throw error;
      throw new ReportArtifactCorruptionError(reportId, error);
    }

    try {
      const metadata = this.#parseAndValidateMetadata(reportId, serializedMetadata);
      const pdfPath = resolveDirectChild(rootDirectory, metadata.storageKey);
      const bytes = await this.#readAndValidatePdf(reportId, pdfPath, metadata);
      return { metadata, bytes };
    } catch (error) {
      if (error instanceof ReportArtifactCorruptionError) throw error;
      throw new ReportArtifactCorruptionError(reportId, error);
    }
  }

  async #readAndValidatePdf(
    reportId: string,
    pdfPath: string,
    metadata: StoredReportArtifact,
  ): Promise<Uint8Array> {
    try {
      const bytes = new Uint8Array(await this.#readStableRegularFile(pdfPath));
      validatePdfBytes(bytes);
      if (bytes.byteLength !== metadata.sizeBytes || sha256(bytes) !== metadata.checksumSha256) {
        throw new Error('Stored PDF size or checksum does not match metadata.');
      }
      return bytes;
    } catch (error) {
      if (error instanceof ReportArtifactCorruptionError) throw error;
      throw new ReportArtifactCorruptionError(reportId, error);
    }
  }

  async #readStableRegularFile(path: string): Promise<Buffer> {
    const pathStats = await lstat(path);
    if (pathStats.isSymbolicLink() || !pathStats.isFile()) {
      throw new Error('Report artifact files must be regular files, not symbolic links.');
    }

    const handle = await open(path, 'r');
    try {
      const openedStats = await handle.stat();
      if (
        !openedStats.isFile() ||
        openedStats.dev !== pathStats.dev ||
        openedStats.ino !== pathStats.ino
      ) {
        throw new Error('Report artifact file changed while it was being opened.');
      }
      return await handle.readFile();
    } finally {
      await handle.close();
    }
  }

  #metadataFileName(reportId: string): string {
    return `${reportStoragePrefix(reportId)}.metadata.json`;
  }

  #parseAndValidateMetadata(reportId: string, serialized: string): StoredReportArtifact {
    const value: unknown = JSON.parse(serialized);
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Error('Stored metadata must be a JSON object.');
    }

    const record = value as Record<string, unknown>;
    const checksumSha256 = record.checksumSha256;
    const expectedStorageKey =
      typeof checksumSha256 === 'string'
        ? `${reportStoragePrefix(reportId)}--${checksumSha256}.pdf`
        : undefined;
    const expectedReference = `/api/v1/reports/${reportId}/download`;

    if (
      record.reportId !== reportId ||
      record.mimeType !== PDF_MIME_TYPE ||
      typeof record.fileName !== 'string' ||
      typeof record.storageKey !== 'string' ||
      !Number.isSafeInteger(record.sizeBytes) ||
      (record.sizeBytes as number) <= 0 ||
      typeof checksumSha256 !== 'string' ||
      !CHECKSUM_PATTERN.test(checksumSha256) ||
      record.storageKey !== expectedStorageKey ||
      record.pdfFileReference !== expectedReference ||
      !isIsoDate(record.createdAt) ||
      !isIsoDate(record.expiresAt) ||
      new Date(record.expiresAt).valueOf() <= new Date(record.createdAt).valueOf()
    ) {
      throw new Error('Stored report metadata failed validation.');
    }

    validateReportId(record.reportId);
    validateFileName(record.fileName);

    return {
      reportId: record.reportId,
      storageKey: record.storageKey,
      fileName: record.fileName,
      mimeType: PDF_MIME_TYPE,
      sizeBytes: record.sizeBytes as number,
      checksumSha256,
      createdAt: record.createdAt,
      expiresAt: record.expiresAt,
      pdfFileReference: record.pdfFileReference as string,
    };
  }
}

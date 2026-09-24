import { access, readFile, readdir, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp } from 'node:fs/promises';

import { afterEach, describe, expect, it } from 'vitest';

import { createHash } from 'node:crypto';
import {
  LocalReportArtifactStorage,
  ReportArtifactConflictError,
  ReportArtifactCorruptionError,
} from './report-artifact-storage.js';

const PDF_BYTES = new TextEncoder().encode('%PDF-1.7\nhello\n%%EOF');
const OTHER_PDF_BYTES = new TextEncoder().encode('%PDF-1.7\ndifferent\n%%EOF');
const PDF_SHA256 = '7f04c1c0e7d4a2f203722187a408a7f55f561184c38d1d2c24a87602f24bcd8f';
const NOW = new Date('2026-09-18T04:05:06.000Z');

const temporaryRoots: string[] = [];

async function createTemporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'cornven-report-storage-'));
  temporaryRoots.push(root);
  return root;
}

function reportStoragePrefix(reportId: string): string {
  return createHash('sha256').update(reportId, 'utf8').digest('hex');
}

function pdfStorageKey(reportId: string, checksum: string): string {
  return `${reportStoragePrefix(reportId)}--${checksum}.pdf`;
}

function metadataFileName(reportId: string): string {
  return `${reportStoragePrefix(reportId)}.metadata.json`;
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('LocalReportArtifactStorage', () => {
  it('persists PDF bytes and complete 90-day metadata beneath the private root', async () => {
    const rootDirectory = await createTemporaryRoot();
    const storage = new LocalReportArtifactStorage({
      rootDirectory,
      now: () => NOW,
    });

    const stored = await storage.publish({
      reportId: 'REPORT_2026-09',
      fileName: 'artist-monthly-report.pdf',
      bytes: PDF_BYTES,
    });

    expect(stored).toEqual({
      reportId: 'REPORT_2026-09',
      storageKey: pdfStorageKey('REPORT_2026-09', PDF_SHA256),
      fileName: 'artist-monthly-report.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 20,
      checksumSha256: PDF_SHA256,
      createdAt: '2026-09-18T04:05:06.000Z',
      expiresAt: '2026-12-17T04:05:06.000Z',
      pdfFileReference: '/api/v1/reports/REPORT_2026-09/download',
    });

    await expect(
      access(join(rootDirectory, pdfStorageKey('REPORT_2026-09', PDF_SHA256))),
    ).resolves.toBeUndefined();
    const metadata = JSON.parse(
      await readFile(join(rootDirectory, metadataFileName('REPORT_2026-09')), 'utf8'),
    );
    expect(metadata).toEqual(stored);
  });

  it('retrieves the persisted metadata and bytes through a fresh storage instance', async () => {
    const rootDirectory = await createTemporaryRoot();
    const firstInstance = new LocalReportArtifactStorage({ rootDirectory, now: () => NOW });
    const stored = await firstInstance.publish({
      reportId: 'REPORT-RESTART',
      fileName: 'restart.pdf',
      bytes: PDF_BYTES,
    });

    const freshInstance = new LocalReportArtifactStorage({
      rootDirectory,
      now: () => new Date('2030-01-01T00:00:00.000Z'),
    });

    await expect(freshInstance.retrieve('REPORT-RESTART')).resolves.toEqual({
      metadata: stored,
      bytes: PDF_BYTES,
    });
  });

  it('stores report IDs that differ only by case as independent artifacts', async () => {
    const rootDirectory = await createTemporaryRoot();
    const storage = new LocalReportArtifactStorage({ rootDirectory, now: () => NOW });
    const upperBytes = new TextEncoder().encode('%PDF-upper');
    const lowerBytes = new TextEncoder().encode('%PDF-lower');

    const upper = await storage.publish({
      reportId: 'Report',
      fileName: 'upper.pdf',
      bytes: upperBytes,
    });
    const lower = await storage.publish({
      reportId: 'report',
      fileName: 'lower.pdf',
      bytes: lowerBytes,
    });

    expect(upper.reportId).toBe('Report');
    expect(lower.reportId).toBe('report');
    expect(upper.storageKey).not.toBe(lower.storageKey);
    expect(upper.pdfFileReference).toBe('/api/v1/reports/Report/download');
    expect(lower.pdfFileReference).toBe('/api/v1/reports/report/download');
    await expect(storage.retrieve('Report')).resolves.toEqual({
      metadata: upper,
      bytes: upperBytes,
    });
    await expect(storage.retrieve('report')).resolves.toEqual({
      metadata: lower,
      bytes: lowerBytes,
    });
    await expect(access(join(rootDirectory, metadataFileName('Report')))).resolves.toBeUndefined();
    await expect(access(join(rootDirectory, metadataFileName('report')))).resolves.toBeUndefined();
  });

  it('returns null when the report ID has no persisted metadata', async () => {
    const rootDirectory = await createTemporaryRoot();
    const storage = new LocalReportArtifactStorage({ rootDirectory, now: () => NOW });

    await expect(storage.retrieve('MISSING-REPORT')).resolves.toBeNull();
  });

  it.each(['', '.', '..', '../escape', 'nested/report', 'nested\\report', 'report%2Fescape'])(
    'rejects unsafe report ID %j without writing outside the root',
    async (reportId) => {
      const rootDirectory = await createTemporaryRoot();
      const storage = new LocalReportArtifactStorage({ rootDirectory, now: () => NOW });

      await expect(
        storage.publish({ reportId, fileName: 'safe.pdf', bytes: PDF_BYTES }),
      ).rejects.toThrow(/report id/i);
      await expect(storage.retrieve(reportId)).rejects.toThrow(/report id/i);
      await expect(access(join(rootDirectory, '..', 'escape'))).rejects.toThrow();
    },
  );

  it.each([
    '',
    '.',
    '..',
    'report',
    '../escape.pdf',
    'nested/report.pdf',
    'nested\\report.pdf',
    'bad\u0000.pdf',
  ])('rejects unsafe PDF filename %j', async (fileName) => {
    const rootDirectory = await createTemporaryRoot();
    const storage = new LocalReportArtifactStorage({ rootDirectory, now: () => NOW });

    await expect(
      storage.publish({ reportId: 'SAFE-REPORT', fileName, bytes: PDF_BYTES }),
    ).rejects.toThrow(/file name/i);
    await expect(access(join(rootDirectory, metadataFileName('SAFE-REPORT')))).rejects.toThrow();
  });

  it.each([
    ['empty bytes', new Uint8Array()],
    ['non-PDF bytes', new TextEncoder().encode('not a PDF')],
    ['truncated signature', new TextEncoder().encode('%PDF')],
  ])('rejects %s', async (_label, bytes) => {
    const rootDirectory = await createTemporaryRoot();
    const storage = new LocalReportArtifactStorage({ rootDirectory, now: () => NOW });

    await expect(
      storage.publish({ reportId: 'INVALID-PDF', fileName: 'invalid.pdf', bytes }),
    ).rejects.toThrow(/pdf/i);
  });

  it.each([0, -1, 1.5, 3651, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects invalid retention days %s',
    async (retentionDays) => {
      const rootDirectory = await createTemporaryRoot();

      expect(
        () => new LocalReportArtifactStorage({ rootDirectory, retentionDays, now: () => NOW }),
      ).toThrow(/retention/i);
    },
  );

  it('treats an exact republish as idempotent without changing timestamps', async () => {
    const rootDirectory = await createTemporaryRoot();
    let currentNow = NOW;
    const storage = new LocalReportArtifactStorage({ rootDirectory, now: () => currentNow });
    const input = { reportId: 'IDEMPOTENT', fileName: 'same.pdf', bytes: PDF_BYTES };
    const first = await storage.publish(input);
    currentNow = new Date('2027-01-01T00:00:00.000Z');

    await expect(storage.publish(input)).resolves.toEqual(first);
  });

  it('rejects different bytes for an existing report without replacing the original', async () => {
    const rootDirectory = await createTemporaryRoot();
    const storage = new LocalReportArtifactStorage({ rootDirectory, now: () => NOW });
    const original = await storage.publish({
      reportId: 'CONFLICT',
      fileName: 'original.pdf',
      bytes: PDF_BYTES,
    });

    await expect(
      storage.publish({
        reportId: 'CONFLICT',
        fileName: 'replacement.pdf',
        bytes: OTHER_PDF_BYTES,
      }),
    ).rejects.toBeInstanceOf(ReportArtifactConflictError);

    await expect(storage.retrieve('CONFLICT')).resolves.toEqual({
      metadata: original,
      bytes: PDF_BYTES,
    });
  });

  it('rejects tampered PDF bytes instead of serving them', async () => {
    const rootDirectory = await createTemporaryRoot();
    const storage = new LocalReportArtifactStorage({ rootDirectory, now: () => NOW });
    const stored = await storage.publish({
      reportId: 'TAMPERED',
      fileName: 'tampered.pdf',
      bytes: PDF_BYTES,
    });
    await writeFile(join(rootDirectory, stored.storageKey), OTHER_PDF_BYTES);

    await expect(storage.retrieve('TAMPERED')).rejects.toBeInstanceOf(
      ReportArtifactCorruptionError,
    );
  });

  it('atomically preserves one winner when concurrent publishers use different bytes', async () => {
    const rootDirectory = await createTemporaryRoot();
    const firstStorage = new LocalReportArtifactStorage({ rootDirectory, now: () => NOW });
    const secondStorage = new LocalReportArtifactStorage({
      rootDirectory,
      now: () => new Date('2026-09-19T04:05:06.000Z'),
    });
    const firstBytes = new TextEncoder().encode(`%PDF-${'a'.repeat(512 * 1024)}`);
    const secondBytes = new TextEncoder().encode(`%PDF-${'b'.repeat(512 * 1024)}`);

    const results = await Promise.allSettled([
      firstStorage.publish({
        reportId: 'CONCURRENT-DIFFERENT',
        fileName: 'first.pdf',
        bytes: firstBytes,
      }),
      secondStorage.publish({
        reportId: 'CONCURRENT-DIFFERENT',
        fileName: 'second.pdf',
        bytes: secondBytes,
      }),
    ]);

    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter((result) => result.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({ reason: expect.any(ReportArtifactConflictError) });

    const winner = fulfilled[0];
    if (winner?.status !== 'fulfilled') throw new Error('Expected a publication winner.');
    const retrieved = await firstStorage.retrieve('CONCURRENT-DIFFERENT');
    expect(retrieved?.metadata).toEqual(winner.value);
    expect(retrieved?.bytes.byteLength).toBe(512 * 1024 + 5);
    expect(retrieved?.bytes[5]).toBe(winner.value.fileName === 'first.pdf' ? 97 : 98);
  });

  it('returns the original metadata to concurrent publishers of the same bytes', async () => {
    const rootDirectory = await createTemporaryRoot();
    const firstStorage = new LocalReportArtifactStorage({ rootDirectory, now: () => NOW });
    const secondStorage = new LocalReportArtifactStorage({
      rootDirectory,
      now: () => new Date('2026-09-19T04:05:06.000Z'),
    });
    const bytes = new TextEncoder().encode(`%PDF-${'s'.repeat(512 * 1024)}`);

    const [first, second] = await Promise.all([
      firstStorage.publish({
        reportId: 'CONCURRENT-SAME',
        fileName: 'first.pdf',
        bytes,
      }),
      secondStorage.publish({
        reportId: 'CONCURRENT-SAME',
        fileName: 'second.pdf',
        bytes,
      }),
    ]);

    expect(second).toEqual(first);
    const retrieved = await firstStorage.retrieve('CONCURRENT-SAME');
    expect(retrieved?.metadata).toEqual(first);
    expect(retrieved?.bytes.byteLength).toBe(bytes.byteLength);
  });

  it('keeps loser content stable during a real three-publisher race', async () => {
    const rootDirectory = await createTemporaryRoot();
    const winnerBytes = PDF_BYTES;
    const competingBytes = new TextEncoder().encode(`%PDF-${'r'.repeat(2 * 1024 * 1024)}`);
    const competingChecksum = createHash('sha256').update(competingBytes).digest('hex');
    const storages = [
      new LocalReportArtifactStorage({ rootDirectory, now: () => NOW }),
      new LocalReportArtifactStorage({
        rootDirectory,
        now: () => new Date('2026-09-19T04:05:06.000Z'),
      }),
      new LocalReportArtifactStorage({
        rootDirectory,
        now: () => new Date('2026-09-20T04:05:06.000Z'),
      }),
    ];

    const results = await Promise.allSettled([
      storages[0]!.publish({
        reportId: 'THREE-PUBLISHER-RACE',
        fileName: 'winner.pdf',
        bytes: winnerBytes,
      }),
      storages[1]!.publish({
        reportId: 'THREE-PUBLISHER-RACE',
        fileName: 'competitor-one.pdf',
        bytes: competingBytes,
      }),
      storages[2]!.publish({
        reportId: 'THREE-PUBLISHER-RACE',
        fileName: 'competitor-two.pdf',
        bytes: competingBytes,
      }),
    ]);

    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter((result) => result.status === 'rejected');
    expect(fulfilled.length).toBeGreaterThanOrEqual(1);
    expect(rejected.length).toBeGreaterThanOrEqual(1);
    const firstFulfilled = fulfilled[0];
    if (firstFulfilled?.status !== 'fulfilled') throw new Error('Expected a publication winner.');
    for (const result of fulfilled) {
      if (result.status === 'fulfilled') expect(result.value).toEqual(firstFulfilled.value);
    }
    for (const result of rejected) {
      expect(result).toMatchObject({ reason: expect.any(ReportArtifactConflictError) });
    }
    await expect(
      access(join(rootDirectory, pdfStorageKey('THREE-PUBLISHER-RACE', PDF_SHA256))),
    ).resolves.toBeUndefined();
    await expect(
      access(join(rootDirectory, pdfStorageKey('THREE-PUBLISHER-RACE', competingChecksum))),
    ).resolves.toBeUndefined();
  });

  it('does not use or follow a pre-existing report-ID link in the flat root', async (context) => {
    const rootDirectory = await createTemporaryRoot();
    const outsideDirectory = await createTemporaryRoot();
    const reportLink = join(rootDirectory, 'LINKED-REPORT');
    try {
      await symlink(
        outsideDirectory,
        reportLink,
        process.platform === 'win32' ? 'junction' : 'dir',
      );
    } catch (error) {
      if (
        error instanceof Error &&
        'code' in error &&
        (error.code === 'EPERM' || error.code === 'ENOSYS')
      ) {
        context.skip();
        return;
      }
      throw error;
    }

    try {
      const storage = new LocalReportArtifactStorage({ rootDirectory, now: () => NOW });
      const stored = await storage.publish({
        reportId: 'LINKED-REPORT',
        fileName: 'linked.pdf',
        bytes: PDF_BYTES,
      });
      await expect(storage.retrieve('LINKED-REPORT')).resolves.toEqual({
        metadata: stored,
        bytes: PDF_BYTES,
      });
      await expect(readdir(outsideDirectory)).resolves.toEqual([]);
    } finally {
      await unlink(reportLink).catch(() => undefined);
    }
  });

  it('rejects a configured storage root that is a link or junction', async (context) => {
    const containerDirectory = await createTemporaryRoot();
    const outsideDirectory = await createTemporaryRoot();
    const linkedRoot = join(containerDirectory, 'reports');
    try {
      await symlink(
        outsideDirectory,
        linkedRoot,
        process.platform === 'win32' ? 'junction' : 'dir',
      );
    } catch (error) {
      if (
        error instanceof Error &&
        'code' in error &&
        (error.code === 'EPERM' || error.code === 'ENOSYS')
      ) {
        context.skip();
        return;
      }
      throw error;
    }

    try {
      const storage = new LocalReportArtifactStorage({ rootDirectory: linkedRoot, now: () => NOW });
      await expect(
        storage.publish({ reportId: 'ROOT-LINK', fileName: 'linked.pdf', bytes: PDF_BYTES }),
      ).rejects.toThrow(/root|link|symbolic|junction/i);
      await expect(storage.retrieve('ROOT-LINK')).rejects.toThrow(/root|link|symbolic|junction/i);
      await expect(readdir(outsideDirectory)).resolves.toEqual([]);
    } finally {
      await unlink(linkedRoot).catch(() => undefined);
    }
  });

  it.each(['CON', 'con', 'PRN', 'AUX', 'NUL', 'COM1', 'COM9', 'LPT1', 'LPT9'])(
    'rejects Windows reserved device report ID %s',
    async (reportId) => {
      const rootDirectory = await createTemporaryRoot();
      const storage = new LocalReportArtifactStorage({ rootDirectory, now: () => NOW });

      await expect(
        storage.publish({ reportId, fileName: 'device.pdf', bytes: PDF_BYTES }),
      ).rejects.toThrow(/report id/i);
      await expect(storage.retrieve(reportId)).rejects.toThrow(/report id/i);
    },
  );

  it.each([
    ['report ID', { reportId: 'OTHER-REPORT' }],
    ['MIME type', { mimeType: 'text/plain' }],
    ['storage key', { storageKey: '../outside.pdf' }],
    ['size', { sizeBytes: 999 }],
  ])('rejects persisted metadata with a tampered %s', async (_field, mutation) => {
    const rootDirectory = await createTemporaryRoot();
    const storage = new LocalReportArtifactStorage({ rootDirectory, now: () => NOW });
    const stored = await storage.publish({
      reportId: 'TAMPERED-METADATA',
      fileName: 'metadata.pdf',
      bytes: PDF_BYTES,
    });
    const metadataPath = join(rootDirectory, metadataFileName('TAMPERED-METADATA'));
    await writeFile(metadataPath, JSON.stringify({ ...stored, ...mutation }));

    await expect(storage.retrieve('TAMPERED-METADATA')).rejects.toBeInstanceOf(
      ReportArtifactCorruptionError,
    );
  });

  it('rejects a mismatched orphan PDF instead of replacing it during retry', async () => {
    const rootDirectory = await createTemporaryRoot();
    const orphanPath = join(rootDirectory, pdfStorageKey('PARTIAL-CORRUPT', PDF_SHA256));
    await writeFile(orphanPath, OTHER_PDF_BYTES);
    const storage = new LocalReportArtifactStorage({ rootDirectory, now: () => NOW });

    await expect(
      storage.publish({
        reportId: 'PARTIAL-CORRUPT',
        fileName: 'retry.pdf',
        bytes: PDF_BYTES,
      }),
    ).rejects.toBeInstanceOf(ReportArtifactCorruptionError);
    await expect(readFile(orphanPath)).resolves.toEqual(Buffer.from(OTHER_PDF_BYTES));
  });

  it('completes metadata promotion when retrying a valid orphan PDF', async () => {
    const rootDirectory = await createTemporaryRoot();
    await writeFile(join(rootDirectory, pdfStorageKey('PARTIAL-VALID', PDF_SHA256)), PDF_BYTES);
    const storage = new LocalReportArtifactStorage({ rootDirectory, now: () => NOW });

    const stored = await storage.publish({
      reportId: 'PARTIAL-VALID',
      fileName: 'retry.pdf',
      bytes: PDF_BYTES,
    });

    await expect(storage.retrieve('PARTIAL-VALID')).resolves.toEqual({
      metadata: stored,
      bytes: PDF_BYTES,
    });
  });
});

/**
 * The Google Drive adapter against a real Drive folder, through `@googleapis/drive`.
 * Skipped unless a folder is named:
 *
 *   TEST_GOOGLE_DRIVE_FOLDER_ID=<ID of a folder the credentials can add files to>
 *   GOOGLE_APPLICATION_CREDENTIALS=/path/to/credentials.json
 *   TEST_GOOGLE_DRIVE_SHARED=true        (only if the folder is in a shared drive)
 *
 * The credentials file can be a service account key (the folder must then be in a shared
 * drive, because a service account has no Drive storage of its own) or an
 * `authorized_user` file holding an OAuth client ID, client secret and refresh token. The
 * Google Drive API must be enabled for the credentials' project, and they need the
 * `https://www.googleapis.com/auth/drive` scope. Each test makes a sub-folder of its own
 * and deletes it, with everything in it, afterwards. Run it with a long timeout:
 *
 *   bun test --timeout 600000 test/google-drive-live.test.ts
 *
 * Nothing here has been run against a real Drive folder by the author of the adapter yet;
 * the default test run uses the stand-in in test/support/fake-google-drive.ts.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { describe, it } from 'node:test';

import { auth, drive as createDrive } from '@googleapis/drive';

import {
  googleDriveAdapter,
  type DriveClientLike,
} from '../src/google-drive/index.js';
import type { StorageAdapter, StoreResult } from '../src/storage.js';
import { runConformance } from './support/conformance.js';

const signal: AbortSignal = new AbortController().signal;

function expectOk<T>(result: StoreResult<T>): T {
  if (!result.ok) {
    assert.fail(`expected success, got ${JSON.stringify(result)}`);
  }
  return result.value;
}

const parentId: string | undefined = process.env.TEST_GOOGLE_DRIVE_FOLDER_ID;
if (parentId === undefined || parentId === '') {
  void describe('googleDriveAdapter on a Google Drive folder', () => {
    void it(
      'is skipped: set TEST_GOOGLE_DRIVE_FOLDER_ID to run it',
      { skip: true },
      () => {
        // Nothing to run without a folder.
      }
    );
  });
} else {
  const shared: boolean = process.env.TEST_GOOGLE_DRIVE_SHARED === 'true';
  const real = createDrive({
    version: 'v3',
    auth: new auth.GoogleAuth({
      scopes: ['https://www.googleapis.com/auth/drive'],
    }),
  });

  // The real client is passed as it is: this also checks that it fits `DriveClientLike`.
  const client: DriveClientLike = real;

  const addFolder = async (): Promise<string> => {
    const made = await real.files.create({
      requestBody: {
        name: `adapter-test-${randomBytes(6).toString('hex')}`,
        mimeType: 'application/vnd.google-apps.folder',
        parents: [parentId],
      },
      fields: 'id',
      ...(shared ? { supportsAllDrives: true } : {}),
    });
    const id: string | null | undefined = made.data.id;
    assert.equal(typeof id, 'string', 'the new folder should have an ID');
    return id as string;
  };

  const dropFolder = async (id: string): Promise<void> => {
    await real.files.delete({
      fileId: id,
      ...(shared ? { supportsAllDrives: true } : {}),
    });
  };

  const adapterFor = (folderId: string): StorageAdapter =>
    googleDriveAdapter({
      client,
      folderId,
      ...(shared ? { sharedDrive: true } : {}),
    });

  runConformance('googleDriveAdapter on a Google Drive folder', {
    ownWrites: 'notifies',
    create: async () => {
      const folderId: string = await addFolder();
      return {
        adapter: adapterFor(folderId),
        reopen: () => adapterFor(folderId),
        cleanup: () => dropFolder(folderId),
      };
    },
  });

  void describe('googleDriveAdapter on a Google Drive folder: beyond the contract', () => {
    void it('stores a plain text file named after the key, with the revision in its properties', async () => {
      const folderId: string = await addFolder();
      try {
        const adapter = adapterFor(folderId);
        expectOk(
          await adapter.set('hello world', 'line one\nline two', { signal })
        );
        const listed = await real.files.list({
          q: `'${folderId}' in parents and trashed = false`,
          fields: 'files(id,name,mimeType,appProperties)',
          spaces: 'drive',
          ...(shared
            ? {
                supportsAllDrives: true,
                includeItemsFromAllDrives: true,
                corpora: 'allDrives',
              }
            : {}),
        });
        const file = listed.data.files?.[0];
        assert.equal(file?.name, 'hello world');
        assert.equal(file?.appProperties?.revision, '1');
        const content = await real.files.get(
          {
            fileId: file?.id ?? '',
            alt: 'media',
            ...(shared ? { supportsAllDrives: true } : {}),
          },
          { responseType: 'text' }
        );
        assert.equal(content.data, 'line one\nline two');
      } finally {
        await dropFolder(folderId);
      }
    });

    void it('explains a folder that does not exist', async () => {
      const adapter = adapterFor(`missing_${randomBytes(8).toString('hex')}`);
      const result = await adapter.get('k', { signal });
      assert.ok(!result.ok);
      assert.match(result.error, /not found|check folderId/i);
    });
  });
}

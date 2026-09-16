import {
  expect,
  test as base,
} from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { startStudioProfile } from '../support/profile-worker';
import {
  readE2ERuntime,
  type E2ERuntime,
  type StudioProfile,
} from '../support/runtime';

type StudioFixtures = {
  studioProfile: StudioProfile;
  studioRuntime: E2ERuntime;
  operationsToken: string;
  _studioWorker: void;
};

export const test = base.extend<StudioFixtures>({
  studioProfile: ['operations', { option: true }],
  studioRuntime: async ({ _studioWorker }, use) => {
    void _studioWorker;
    await use(await readE2ERuntime());
  },
  operationsToken: async ({ studioRuntime }, use) => {
    await use(studioRuntime.credentials.operationsToken);
  },
  _studioWorker: [async ({ studioProfile }, use, testInfo) => {
    const runtime = await readE2ERuntime();
    const runId = [
      String(testInfo.workerIndex),
      studioProfile,
      randomBytes(8).toString('hex'),
    ].join('-');
    const worker = await startStudioProfile({
      profile: studioProfile,
      runtime,
      runId,
    });
    try {
      await use();
    } finally {
      await worker.stop();
    }
  }, { auto: true }],
});

export { expect };

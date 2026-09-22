import { expect, test } from '../fixtures/studio-test';
import type { Response } from '@playwright/test';
import { signInAsAdministrator } from '../support/journeys';

const operationsStatusPath = '/api/system/operations/status';

function isOperationsStatusResponse(response: Response) {
  return new URL(response.url()).pathname === operationsStatusPath;
}

test('unlocks Operations with its token and locks it again on reload', async ({
  page,
  operationsToken,
}) => {
  const pageErrors: Error[] = [];
  const statusResponses: Response[] = [];
  page.on('pageerror', (error) => pageErrors.push(error));
  page.on('response', (response) => {
    if (isOperationsStatusResponse(response)) statusResponses.push(response);
  });

  await page.goto('/system/operations');

  await expect(page.getByRole('heading', {
    level: 2,
    name: 'Maintenance & Recovery',
  })).toBeVisible();
  expect(statusResponses).toHaveLength(0);

  const tokenField = page.getByLabel('Operations token');
  await expect(tokenField).toBeVisible();
  await expect(tokenField).toHaveValue('');
  await tokenField.fill('short');
  await page.getByRole('button', {
    name: 'Open Maintenance & Recovery',
  }).click();
  await expect(page.getByRole('alert').locator('.studio-notice-content'))
    .toHaveText('Check the Operations token and try again.');
  expect(statusResponses).toHaveLength(0);
  await tokenField.fill(`wrong-${operationsToken}`);
  await page.getByRole('button', {
    name: 'Open Maintenance & Recovery',
  }).click();
  await expect(page.getByText('The operations token is invalid.'))
    .toBeVisible();

  await tokenField.fill(operationsToken);

  const statusRequest = page.waitForResponse((response) => (
    isOperationsStatusResponse(response)
    && response.request().headers().authorization !== undefined
  ));
  await page.getByRole('button', {
    name: 'Open Maintenance & Recovery',
  }).click();
  expect((await statusRequest).status()).toBe(200);

  await expect(page.getByRole('button', { name: 'Lock screen' }))
    .toBeVisible();
  await expect(page.getByRole('heading', {
    level: 1,
    name: 'Operations overview',
  })).toBeVisible();
  await expect(page.getByRole('heading', {
    level: 2,
    name: 'Worker configuration status',
  })).toBeVisible();
  await expect(page.getByText('Ready to install', { exact: true }).first())
    .toBeVisible();

  const persistedToken = await page.evaluate((token) => (
    [...Object.values(window.localStorage), ...Object.values(window.sessionStorage)]
      .includes(token)
  ), operationsToken);
  expect(persistedToken).toBe(false);

  await page.getByRole('button', { name: 'Lock screen' }).click();
  await expect(page.getByLabel('Operations token')).toBeVisible();
  await expect(page.getByLabel('Operations token')).toHaveValue('');
  await expect(page.getByRole('button', { name: 'Lock screen' }))
    .toHaveCount(0);

  await page.getByLabel('Operations token').fill(operationsToken);
  await page.getByRole('button', {
    name: 'Open Maintenance & Recovery',
  }).click();
  await expect(page.getByRole('button', { name: 'Lock screen' }))
    .toBeVisible();

  const statusCountBeforeReload = statusResponses.length;
  await page.reload();

  await expect(page.getByLabel('Operations token')).toBeVisible();
  await expect(page.getByLabel('Operations token')).toHaveValue('');
  await expect(page.getByRole('button', { name: 'Lock screen' }))
    .toHaveCount(0);
  expect(statusResponses).toHaveLength(statusCountBeforeReload);
  expect(statusResponses.every((response) => (
    response.request().headers().authorization !== undefined
  ))).toBe(true);
  expect(pageErrors).toEqual([]);
});

for (const studioProfile of [
  'operations-ip-denied',
] as const) {
  test.describe(`Operations unavailable: ${studioProfile}`, () => {
    test.use({ studioProfile });

    test('shows not found before any login or protected request, including reload', async ({ page }) => {
      const protectedRequests: string[] = [];
      page.on('request', (request) => {
        const path = new URL(request.url()).pathname;
        if (path.startsWith('/api/system/operations/') || path === '/api/auth/session') {
          protectedRequests.push(path);
        }
      });
      await page.addInitScript(() => {
        const state = { sawForm: false };
        (window as typeof window & { __operationsEntry?: typeof state })
          .__operationsEntry = state;
        new MutationObserver(() => {
          if (document.querySelector('input[type="password"], input[type="email"]')) {
            state.sawForm = true;
          }
        }).observe(document, { childList: true, subtree: true });
      });

      const publicStatus = page.waitForResponse((response) => (
        new URL(response.url()).pathname === '/api/system/status'
      ));
      await page.goto('/system/operations/edge');
      const response = await publicStatus;
      expect(response.status()).toBe(200);
      expect((await response.json()).data.operations).toEqual({ state: 'not_found' });
      await expect(page.getByRole('heading', { name: 'Page not found' }))
        .toBeVisible();
      await expect(page.getByLabel('Operations token')).toHaveCount(0);
      await expect(page.getByLabel('Current connection IP')).toHaveCount(0);
      expect(await page.evaluate(() => (
        (window as typeof window & { __operationsEntry?: { sawForm: boolean } })
          .__operationsEntry?.sawForm
      ))).toBe(false);
      await page.reload();
      await expect(page.getByRole('heading', { name: 'Page not found' }))
        .toBeVisible();
      expect(protectedRequests).toEqual([]);
    });
  });
}

for (const studioProfile of [
  'initial-no-operations',
  'recovery-no-operations',
  'operations-allowlist-empty',
  'operations-allowlist-invalid',
  'operations-token-missing',
  'operations-token-invalid',
  'operations-ip-denied-token-missing',
  'operations-ip-denied-token-invalid',
] as const) {
  test.describe(`Operations configuration: ${studioProfile}`, () => {
    test.use({ studioProfile });

    test('guides configuration without asking for credentials or probing protected APIs', async ({ page, studioRuntime }) => {
      const protectedRequests: string[] = [];
      page.on('request', (request) => {
        const path = new URL(request.url()).pathname;
        if (path.startsWith('/api/system/operations/') || path === '/api/auth/session') {
          protectedRequests.push(path);
        }
      });
      const pageErrors: Error[] = [];
      page.on('pageerror', (error) => pageErrors.push(error));
      const publicStatus = page.waitForResponse((response) => (
        new URL(response.url()).pathname === '/api/system/status'
      ));
      if (studioProfile === 'initial-no-operations') {
        await page.goto('/system/operations/edge');
      } else {
        await page.goto('/');
        await page.getByRole('link', {
          name: 'Open Maintenance & Recovery',
        }).click();
      }
      const publicResponse = await publicStatus;
      expect(publicResponse.headers()['cache-control']).toBe('no-store');
      const entry = (await publicResponse.json()).data.operations;
      await expect(page.getByRole('heading', {
        name: 'Set up Operations access',
      })).toBeVisible();
      await expect(page.getByLabel('Operations token')).toHaveCount(0);
      await expect(page.getByLabel('Email', { exact: true })).toHaveCount(0);

      const noOperations = studioProfile.endsWith('-no-operations');
      const invalidAllowlist = studioProfile.startsWith('operations-allowlist-');
      const needsAllowlist = noOperations || invalidAllowlist;
      const clientIp = page.getByLabel('Current connection IP');
      if (needsAllowlist) {
        expect(entry.configuration.client_ip === studioRuntime.workerHost).toBe(true);
        await expect(clientIp).toBeVisible();
        expect(await clientIp.evaluate((element: HTMLInputElement, ip) => (
          element.readOnly && element.value === ip
          && ![...Object.values(localStorage), ...Object.values(sessionStorage)]
            .some((value) => value.includes(element.value))
        ), studioRuntime.workerHost)).toBe(true);
        await expect(page.getByText(/Your IP may change when you switch networks or VPNs/)).toBeVisible();
        await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
        await page.getByRole('button', { name: 'Copy IP address' }).click();
        await expect(page.getByText('The current connection IP was copied.')).toBeVisible();
        expect(await page.evaluate(async (ip) => (
          await navigator.clipboard.readText() === ip
        ), studioRuntime.workerHost)).toBe(true);
      } else {
        expect(Object.hasOwn(entry.configuration, 'client_ip')).toBe(false);
        await expect(clientIp).toHaveCount(0);
        await expect(page.getByRole('button', { name: 'Copy IP address' })).toHaveCount(0);
      }
      await expect(page.getByRole('region', { name: 'STUDIO_OPERATIONS_ALLOWED_IPS' }))
        .toContainText(noOperations ? 'Not set' : invalidAllowlist ? 'Invalid' : 'Configured');
      await expect(page.getByRole('region', { name: 'STUDIO_OPERATIONS_TOKEN' }))
        .toContainText(invalidAllowlist ? 'Configured' : studioProfile.endsWith('-invalid') ? 'Invalid' : 'Not set');
      const generate = page.getByRole('button', { name: 'Generate Operations token' });
      if (invalidAllowlist) {
        await expect(generate).toHaveCount(0);
      } else {
        await generate.click();
        const generatedField = page.getByLabel('Generated STUDIO_OPERATIONS_TOKEN');
        // Keep credential assertions boolean-only; never print a candidate in failures.
        expect(await generatedField.evaluate((element: HTMLInputElement) => (
          element.readOnly && /^[a-f0-9]{64}$/.test(element.value)
          && ![...Object.values(localStorage), ...Object.values(sessionStorage)]
            .some((value) => value.includes(element.value))
        ))).toBe(true);
        await expect(page.getByText('Keep a separate, secure copy of this value. You will need it to access Operations.'))
          .toBeVisible();
      }

      if (studioProfile === 'initial-no-operations') {
        for (const width of [320, 360, 640, 1024, 1440]) {
          await page.setViewportSize({ width, height: 900 });
          expect(await page.evaluate(() => (
            document.documentElement.scrollWidth <= window.innerWidth
          ))).toBe(true);
        }
        await page.getByRole('button', { name: 'Use dark appearance' }).click();
        await expect(clientIp).toBeVisible();
        await page.getByRole('button', { name: 'Use light appearance' }).click();
        await page.getByRole('combobox', { name: 'Interface language' }).selectOption('ko');
        await expect(page.getByRole('heading', { name: 'Operations 접근을 설정하세요' })).toBeVisible();
        await expect(page.getByLabel('현재 접속 IP')).toBeVisible();
        await expect(page.getByText(/네트워크나 VPN이 바뀌면 IP도 달라질 수 있습니다/)).toBeVisible();
        await page.getByRole('combobox', { name: '인터페이스 언어' }).selectOption('en');
      }
      await page.getByRole('button', { name: 'Check configuration again' }).click();
      await expect(page.getByRole('heading', {
        name: 'Set up Operations access',
      })).toBeVisible();
      await expect(page.getByLabel('Generated STUDIO_OPERATIONS_TOKEN')).toHaveCount(0);
      await expect(clientIp).toHaveCount(needsAllowlist ? 1 : 0);
      if (needsAllowlist) await expect(page.getByRole('button', { name: 'Copy IP address' })).toBeVisible();
      await page.reload();
      await expect(page.getByRole('heading', { name: 'Set up Operations access' })).toBeVisible();
      await expect(page.getByLabel('Generated STUDIO_OPERATIONS_TOKEN')).toHaveCount(0);
      expect(protectedRequests).toEqual([]);
      expect(pageErrors).toEqual([]);
    });
  });
}

test.describe('operational Operations setup', () => {
  test.use({ studioProfile: 'operational-no-operations' });

  test('reveals setup only to a signed-in administrator without prompting visitors to sign in', async ({
    page,
    studioRuntime,
  }) => {
    const publicStatus = page.waitForResponse((response) => (
      new URL(response.url()).pathname === '/api/system/status'
    ));
    await page.goto('/system/operations/access');
    expect((await (await publicStatus).json()).data.operations).toEqual({ state: 'not_found' });
    await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
    await expect(page.getByLabel('Email', { exact: true })).toHaveCount(0);
    const protectedResponse = await page.request.get(operationsStatusPath);
    expect(protectedResponse.status()).toBe(404);

    await signInAsAdministrator(page, studioRuntime);
    await page.goto('/system/operations/access');
    await expect(page.getByRole('heading', { name: 'Set up Operations access' })).toBeVisible();
    await expect(page.getByRole('region', { name: 'STUDIO_OPERATIONS_ALLOWED_IPS' }))
      .toContainText('Not set');
    await expect(page.getByRole('region', { name: 'STUDIO_OPERATIONS_TOKEN' }))
      .toContainText('Not set');
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Set up Operations access' })).toBeVisible();

    await page.context().clearCookies();
    await page.getByRole('button', { name: 'Check configuration again' }).click();
    await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
    await expect(page.getByLabel('Email', { exact: true })).toHaveCount(0);
    await expect(page.getByLabel('Current connection IP')).toHaveCount(0);
  });
});

test.describe('operational administrator control plane', () => {
  test.use({ studioProfile: 'operational' });

  test('requires Studio administrator sign-in before offering protected tools', async ({
    page,
    operationsToken,
    studioRuntime,
  }) => {
    await page.goto('/system/operations/access');
    await expect(page.getByRole('heading', { name: 'Sign in to Studio' }))
      .toBeVisible();
    await expect(page.getByLabel('Operations token')).toHaveCount(0);

    await signInAsAdministrator(page, studioRuntime);
    await page.goto('/system/operations/access');

    const accessRegion = page.getByRole('region', {
      name: 'Unlock Studio operations',
    });
    await expect(accessRegion).toHaveClass(/auth-frame-login/);
    await expect(accessRegion.getByRole('heading', {
      level: 1,
      name: 'Get Studio running again',
    })).toBeVisible();
    await expect(accessRegion.getByRole('heading', {
      level: 2,
      name: 'Studio operations',
    })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Studio access' }))
      .toHaveCount(0);
    await expect(page.getByText(
      'Enter the Operations token to open Studio access settings and protected tools.',
    )).toBeVisible();

    await page.getByLabel('Operations token').fill(operationsToken);
    await page.getByRole('button', {
      name: 'Open Studio operations',
    }).click();
    await expect(page.getByRole('heading', {
      level: 1,
      name: 'Studio access',
    })).toBeVisible();
    await expect(page.getByRole('navigation', {
      name: 'Operations sections',
    }).getByRole('link', { name: /^Studio access/u }))
      .toHaveAttribute('aria-current', 'page');
    await expect(page.getByRole('heading', {
      level: 2,
      name: 'Second-level verification',
    }))
      .toBeVisible();
  });
});

import type { Page } from '@playwright/test';
import type { E2ERuntime } from './runtime';
import { createTotpCode } from './totp.mjs';

export async function signInAsAdministrator(
  page: Page,
  runtime: E2ERuntime,
): Promise<void> {
  await page.goto('/');
  await page.getByLabel('Email').fill(runtime.credentials.admin.email);
  await page.getByRole('textbox', { name: 'Password' })
    .fill(runtime.credentials.admin.password);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByRole('heading', { name: 'Verify your identity' })
    .waitFor();
  await page.getByLabel('Six-digit code').fill(
    createTotpCode(runtime.credentials.admin.totpSecret),
  );
  await page.getByRole('button', { name: 'Verify and sign in' }).click();
  await page.getByRole('heading', { level: 1, name: 'Dashboard' })
    .waitFor();
}

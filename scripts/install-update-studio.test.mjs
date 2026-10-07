import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installUpdateWorkflow } from './install-update-studio.mjs';

const scripts = dirname(fileURLToPath(import.meta.url));
const path = '.github/workflows/update-studio.yml';
let root;
let template;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'studio-workflow-installer-'));
  mkdirSync(join(root, 'scripts/templates'), { recursive: true });
  writeFileSync(join(root, 'package.json'), '{"name":"@zeropress/studio"}');
  copyFileSync(join(scripts, 'templates/update-studio.yml'), join(root, 'scripts/templates/update-studio.yml'));
  template = readFileSync(join(root, 'scripts/templates/update-studio.yml'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('Update Studio workflow installation', () => {
  it('creates the bundled workflow and makes repeat installation idempotent', () => {
    expect(installUpdateWorkflow({ root })).toEqual({ created: true, path });
    expect(readFileSync(join(root, path))).toEqual(template);
    expect(installUpdateWorkflow({ root })).toEqual({ created: false, path });
  });

  it('preserves a customized workflow and explains how to review the bundled version', () => {
    installUpdateWorkflow({ root });
    writeFileSync(join(root, path), 'name: Customer updater\n');
    expect(() => installUpdateWorkflow({ root })).toThrow('Compare it with scripts/templates/update-studio.yml');
    expect(readFileSync(join(root, path), 'utf8')).toBe('name: Customer updater\n');
  });

  it('rejects a different product before creating a workflow', () => {
    writeFileSync(join(root, 'package.json'), '{"name":"another-product"}');
    expect(() => installUpdateWorkflow({ root })).toThrow('ZeroPress Studio installation');
    expect(existsSync(join(root, '.github'))).toBe(false);
  });

  it('keeps symbolic links from redirecting installation outside the repository', () => {
    mkdirSync(join(root, 'outside'));
    symlinkSync(join(root, 'outside'), join(root, '.github'));
    expect(() => installUpdateWorkflow({ root })).toThrow('regular directory');
    expect(existsSync(join(root, 'outside/workflows'))).toBe(false);
  });

  it('runs from a clone without npm dependencies or Git mutations', () => {
    copyFileSync(join(scripts, 'install-update-studio.mjs'), join(root, 'scripts/install-update-studio.mjs'));
    const output = execFileSync(process.execPath, [join(root, 'scripts/install-update-studio.mjs')], {
      cwd: tmpdir(), encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' },
    });
    expect(readFileSync(join(root, path))).toEqual(template);
    expect(output).toContain('Commit and push');
    expect(output).toContain('Allow GitHub Actions to create and approve pull requests');
  });
});

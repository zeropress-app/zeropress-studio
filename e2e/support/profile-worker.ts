import { spawn, type ChildProcess } from 'node:child_process';
import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  profileEnvironment,
  profileTemplateState,
  type E2ERuntime,
  type StudioProfile,
} from './runtime';

export type RunningStudioProfile = {
  baseURL: string;
  runtime: E2ERuntime;
  stop(): Promise<void>;
};

async function waitForWorker(
  baseURL: string,
  child: ChildProcess,
  output: () => string,
): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Profile Worker exited before readiness.\n${output()}`);
    }
    try {
      const response = await fetch(`${baseURL}/api/system/status`, {
        signal: AbortSignal.timeout(1_000),
      });
      if (response.status < 500) return;
    } catch {
      // Wrangler is still starting.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error(`Timed out waiting for ${baseURL}.\n${output()}`);
}

export async function startStudioProfile(input: {
  profile: StudioProfile;
  runtime: E2ERuntime;
  runId: string;
}): Promise<RunningStudioProfile> {
  const runDirectory = join(
    input.runtime.repositoryRoot,
    '.wrangler/e2e/runs',
    input.runId,
  );
  const persistenceDirectory = join(runDirectory, 'state');
  const environmentFile = join(runDirectory, 'worker.env');
  await rm(runDirectory, { recursive: true, force: true });
  await mkdir(runDirectory, { recursive: true });
  const templateState = profileTemplateState(input.profile, input.runtime);
  if (templateState) {
    await cp(templateState, persistenceDirectory, { recursive: true });
  } else {
    await mkdir(persistenceDirectory, { recursive: true });
  }
  const variables = profileEnvironment(input.profile, input.runtime);
  await writeFile(
    environmentFile,
    `${Object.entries(variables)
      .map(([name, value]) => `${name}=${value}`)
      .join('\n')}\n`,
    { encoding: 'utf8', mode: 0o600 },
  );

  const executableSuffix = process.platform === 'win32' ? '.cmd' : '';
  const wranglerExecutable = join(
    input.runtime.repositoryRoot,
    `node_modules/.bin/wrangler${executableSuffix}`,
  );
  const child = spawn(wranglerExecutable, [
    'dev',
    '--config',
    input.runtime.wranglerConfig,
    '--local',
    '--persist-to',
    persistenceDirectory,
    '--env-file',
    environmentFile,
    '--ip',
    input.runtime.workerHost,
    '--port',
    String(input.runtime.workerPort),
    '--show-interactive-dev-session=false',
  ], {
    cwd: input.runtime.repositoryRoot,
    env: { ...process.env, WRANGLER_LOG_PATH: join(runDirectory, 'wrangler.log') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  const capture = (chunk: Buffer) => {
    output = `${output}${String(chunk)}`.slice(-30_000);
  };
  child.stdout?.on('data', capture);
  child.stderr?.on('data', capture);
  const baseURL = `http://${input.runtime.workerHost}:${input.runtime.workerPort}`;

  try {
    await waitForWorker(baseURL, child, () => output);
  } catch (error) {
    child.kill('SIGTERM');
    throw error;
  }

  return {
    baseURL,
    runtime: input.runtime,
    async stop() {
      if (child.exitCode === null) {
        const exited = new Promise<void>((resolvePromise) => {
          child.once('exit', () => resolvePromise());
        });
        child.kill('SIGTERM');
        await Promise.race([
          exited,
          new Promise<void>((resolvePromise) => {
            setTimeout(resolvePromise, 5_000);
          }),
        ]);
        if (child.exitCode === null) {
          child.kill('SIGKILL');
          await exited;
        }
      }
      await rm(runDirectory, { recursive: true, force: true });
    },
  };
}

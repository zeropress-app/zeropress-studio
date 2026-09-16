import { spawn } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import {
  cp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const supportDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(supportDirectory, '../..');
const e2eRuntimeDirectory = join(repositoryRoot, '.wrangler/e2e');
// Keep Wrangler diagnostic files inside the disposable, credential-bearing
// harness directory, not the developer's global log directory.
process.env.WRANGLER_LOG_PATH = join(e2eRuntimeDirectory, 'wrangler.log');
const baseStateDirectory = join(e2eRuntimeDirectory, 'templates/installed');
const invitationStateDirectory = join(
  e2eRuntimeDirectory,
  'templates/invitation',
);
const seedEnvironmentFile = join(e2eRuntimeDirectory, 'seed.env');
const invitationEnvironmentFile = join(
  e2eRuntimeDirectory,
  'invitation.env',
);
const runtimeManifestFile = join(e2eRuntimeDirectory, 'runtime.json');
const generatedWorkerDirectory = join(
  repositoryRoot,
  'dist/zeropress_studio',
);
const generatedWranglerConfig = join(
  generatedWorkerDirectory,
  'wrangler.json',
);
const generatedDevelopmentVariables = join(
  generatedWorkerDirectory,
  '.dev.vars',
);
const executableSuffix = process.platform === 'win32' ? '.cmd' : '';
const buildScript = join(repositoryRoot, 'scripts/build-deploy.mjs');
const wranglerExecutable = join(
  repositoryRoot,
  `node_modules/.bin/wrangler${executableSuffix}`,
);
const seedPort = 4299;
const preparationPort = 4198;
const host = '127.0.0.1';
const seedBaseUrl = `http://${host}:${seedPort}`;

const credentials = {
  admin: {
    name: 'Studio E2E Owner',
    email: 'owner@example.com',
    password: 'harbor lantern canyon marble circuit',
  },
  invitation: {
    name: 'Invited Editor',
    email: 'invited@example.com',
    password: 'violet river notebook orchard compass',
  },
  installToken: `e2e-install-${randomBytes(24).toString('hex')}`,
  operationsToken: process.env.ZEROPRESS_E2E_OPERATIONS_TOKEN
    ?? `e2e-operations-${randomBytes(24).toString('hex')}`,
  authSecret: `e2e-auth-${randomBytes(24).toString('hex')}`,
};

const profileEnvironmentNames = [
  'EDGE_MAINTENANCE_MODE',
  'STUDIO_AUTH_SECRET',
  'STUDIO_INSTALL_TOKEN',
  'STUDIO_OPERATIONS_ALLOWED_IPS',
  'STUDIO_OPERATIONS_TOKEN',
  'STUDIO_SITE_MODE',
];

let activeChild = null;
let preparationServer = null;
let stopping = false;

function base32Bytes(value) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const character of value.replace(/=+$/u, '').toUpperCase()) {
    const index = alphabet.indexOf(character);
    if (index < 0) throw new Error('Invalid base32 TOTP secret.');
    bits += index.toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let offset = 0; offset + 8 <= bits.length; offset += 8) {
    bytes.push(Number.parseInt(bits.slice(offset, offset + 8), 2));
  }
  return Buffer.from(bytes);
}

function totp(secret, timestamp = Date.now()) {
  const step = Math.floor(timestamp / 1000 / 30);
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const digest = createHmac('sha1', base32Bytes(secret))
    .update(counter)
    .digest();
  const offset = (digest.at(-1) ?? 0) & 0x0f;
  const binary = digest.readUInt32BE(offset) & 0x7fffffff;
  return String(binary % 1_000_000).padStart(6, '0');
}

function run(command, arguments_, options = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, arguments_, {
      cwd: repositoryRoot,
      env: process.env,
      stdio: options.quiet ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    });
    let output = '';
    if (options.quiet) {
      child.stdout?.on('data', (chunk) => {
        output = `${output}${String(chunk)}`.slice(-20_000);
      });
      child.stderr?.on('data', (chunk) => {
        output = `${output}${String(chunk)}`.slice(-20_000);
      });
    }
    child.once('error', rejectPromise);
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolvePromise({ output });
        return;
      }
      rejectPromise(new Error(
        `${command} exited with ${signal ?? `status ${String(code)}`}.\n${output}`,
      ));
    });
  });
}

async function writeEnvironment(file, values) {
  await writeFile(
    file,
    `${Object.entries(values)
      .map(([name, value]) => `${name}=${value}`)
      .join('\n')}\n`,
    { encoding: 'utf8', mode: 0o600 },
  );
}

async function stripGeneratedDevelopmentEnvironment() {
  const wranglerConfig = JSON.parse(
    await readFile(generatedWranglerConfig, 'utf8'),
  );
  if (
    wranglerConfig.vars
    && typeof wranglerConfig.vars === 'object'
    && !Array.isArray(wranglerConfig.vars)
  ) {
    for (const name of profileEnvironmentNames) {
      delete wranglerConfig.vars[name];
    }
  }
  await writeFile(
    generatedWranglerConfig,
    `${JSON.stringify(wranglerConfig, null, 2)}\n`,
    'utf8',
  );
  await rm(generatedDevelopmentVariables, { force: true });
}

async function waitForUrl(url, child, output) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`E2E seed Worker stopped before readiness.\n${output()}`);
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      if (response.status < 500) return;
    } catch {
      // Wrangler is still starting.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error(`Timed out waiting for ${url}.\n${output()}`);
}

async function startWorker({ persistTo, environmentFile }) {
  const child = spawn(wranglerExecutable, [
    'dev',
    '--config',
    generatedWranglerConfig,
    '--local',
    '--persist-to',
    persistTo,
    '--env-file',
    environmentFile,
    '--ip',
    host,
    '--port',
    String(seedPort),
    '--show-interactive-dev-session=false',
  ], {
    cwd: repositoryRoot,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  const capture = (chunk) => {
    output = `${output}${String(chunk)}`.slice(-30_000);
  };
  child.stdout?.on('data', capture);
  child.stderr?.on('data', capture);
  activeChild = child;
  await waitForUrl(`${seedBaseUrl}/api/system/status`, child, () => output);
  return { child, output: () => output };
}

async function stopWorker(worker) {
  if (worker.child.exitCode !== null) {
    activeChild = null;
    return;
  }
  const exited = new Promise((resolvePromise) => {
    worker.child.once('exit', resolvePromise);
  });
  worker.child.kill('SIGTERM');
  await Promise.race([
    exited,
    new Promise((resolvePromise) => setTimeout(resolvePromise, 5_000)),
  ]);
  if (worker.child.exitCode === null) {
    worker.child.kill('SIGKILL');
    await exited;
  }
  activeChild = null;
}

async function api(path, options = {}) {
  const response = await fetch(`${seedBaseUrl}${path}`, {
    ...options,
    headers: {
      Accept: 'application/json',
      Origin: seedBaseUrl,
      'Sec-Fetch-Site': 'same-origin',
      ...(options.body === undefined
        ? {}
        : { 'Content-Type': 'application/json' }),
      ...options.headers,
    },
  });
  const value = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(
      `${options.method ?? 'GET'} ${path} returned ${response.status}: ${JSON.stringify(value)}`,
    );
  }
  return { response, value };
}

async function seedInstalledDatabase() {
  await mkdir(baseStateDirectory, { recursive: true });
  await writeEnvironment(seedEnvironmentFile, {
    STUDIO_SITE_MODE: 'initial',
    STUDIO_INSTALL_TOKEN: credentials.installToken,
    STUDIO_OPERATIONS_ALLOWED_IPS: host,
    STUDIO_OPERATIONS_TOKEN: credentials.operationsToken,
    STUDIO_AUTH_SECRET: credentials.authSecret,
  });
  const worker = await startWorker({
    persistTo: baseStateDirectory,
    environmentFile: seedEnvironmentFile,
  });
  try {
    const authorization = `Bearer ${credentials.installToken}`;
    await api('/api/system/install/access', {
      headers: { Authorization: authorization },
    });
    const setup = await api('/api/system/install/mfa/setup', {
      method: 'POST',
      headers: { Authorization: authorization },
      body: JSON.stringify({ admin_email: credentials.admin.email }),
    });
    const enrollment = setup.value?.data;
    if (
      typeof enrollment?.secret !== 'string'
      || typeof enrollment?.enrollment_token !== 'string'
    ) {
      throw new Error('Install MFA setup returned incomplete data.');
    }
    const installed = await api('/api/system/install', {
      method: 'POST',
      headers: { Authorization: authorization },
      body: JSON.stringify({
        admin_name: credentials.admin.name,
        admin_email: credentials.admin.email,
        admin_password: credentials.admin.password,
        interface_locale: 'en',
        mfa: {
          enrollment_token: enrollment.enrollment_token,
          totp_code: totp(enrollment.secret),
        },
      }),
    });
    if (installed.value?.data?.status !== 'installed') {
      throw new Error('Install API did not report the installed state.');
    }
    credentials.admin.totpSecret = enrollment.secret;
  } finally {
    await stopWorker(worker);
  }

  // Installation consumes the enrollment TOTP step. Reset only the ephemeral
  // E2E template so login journeys do not depend on a 30-second wall clock.
  await run(wranglerExecutable, [
    'd1',
    'execute',
    'DB',
    '--local',
    '--persist-to',
    baseStateDirectory,
    '--config',
    generatedWranglerConfig,
    '--command',
    'UPDATE user_mfa_factors SET last_used_step = -1; DELETE FROM sessions;',
  ], { quiet: true });
}

function sessionCookie(response) {
  const setCookie = response.headers.get('set-cookie');
  if (!setCookie) throw new Error('Authentication did not set a session cookie.');
  return setCookie.split(';', 1)[0];
}

async function seedInvitation() {
  await cp(baseStateDirectory, invitationStateDirectory, { recursive: true });
  await writeEnvironment(invitationEnvironmentFile, {
    STUDIO_SITE_MODE: 'operational',
    STUDIO_OPERATIONS_ALLOWED_IPS: host,
    STUDIO_OPERATIONS_TOKEN: credentials.operationsToken,
    STUDIO_AUTH_SECRET: credentials.authSecret,
  });
  const worker = await startWorker({
    persistTo: invitationStateDirectory,
    environmentFile: invitationEnvironmentFile,
  });
  try {
    const login = await api('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({
        email: credentials.admin.email,
        password: credentials.admin.password,
      }),
    });
    const continuationToken = login.value?.data?.continuation_token;
    if (typeof continuationToken !== 'string') {
      throw new Error('Login did not return an MFA continuation token.');
    }
    const verified = await api('/api/auth/mfa/verify', {
      method: 'POST',
      body: JSON.stringify({
        continuation_token: continuationToken,
        method: 'totp',
        code: totp(credentials.admin.totpSecret),
      }),
    });
    const cookie = sessionCookie(verified.response);
    const session = await api('/api/auth/session', {
      headers: { Cookie: cookie },
    });
    const csrfToken = session.value?.data?.csrf_token;
    if (typeof csrfToken !== 'string') {
      throw new Error('Session API did not return a CSRF token.');
    }
    const authorization = await api('/api/auth/mfa/management/authorize', {
      method: 'POST',
      headers: {
        Cookie: cookie,
        'X-ZeroPress-CSRF': csrfToken,
      },
      body: JSON.stringify({
        operation: 'invite_user',
        password: credentials.admin.password,
      }),
    });
    const managementToken = authorization.value?.data?.management_token;
    if (typeof managementToken !== 'string') {
      throw new Error('MFA management authorization returned no token.');
    }
    const invitation = await api('/api/users/invitations', {
      method: 'POST',
      headers: {
        Cookie: cookie,
        'X-ZeroPress-CSRF': csrfToken,
      },
      body: JSON.stringify({
        email: credentials.invitation.email,
        name: credentials.invitation.name,
        role: 'editor',
        management_token: managementToken,
      }),
    });
    const setupUrl = invitation.value?.data?.setup_url;
    if (typeof setupUrl !== 'string') {
      throw new Error('Invitation API returned no setup URL.');
    }
    credentials.invitation.setupUrl = setupUrl;
  } finally {
    await stopWorker(worker);
  }
}

async function stop(signal) {
  if (stopping) return;
  stopping = true;
  if (activeChild && !activeChild.killed) activeChild.kill(signal);
  if (preparationServer) {
    await new Promise((resolvePromise) => {
      preparationServer.close(resolvePromise);
    });
  }
  await rm(e2eRuntimeDirectory, { recursive: true, force: true });
  process.exit(0);
}

process.once('SIGINT', () => void stop('SIGINT'));
process.once('SIGTERM', () => void stop('SIGTERM'));

await rm(e2eRuntimeDirectory, { recursive: true, force: true });
await mkdir(e2eRuntimeDirectory, { recursive: true });

await run(process.execPath, [buildScript, 'build', '--mode', 'local-preview']);
await stripGeneratedDevelopmentEnvironment();
await seedInstalledDatabase();
await seedInvitation();

const wranglerConfig = JSON.parse(
  await readFile(generatedWranglerConfig, 'utf8'),
);
await writeFile(runtimeManifestFile, `${JSON.stringify({
  version: 1,
  repositoryRoot,
  wranglerConfig: generatedWranglerConfig,
  workerHost: host,
  workerPort: 4199,
  baseStateDirectory,
  invitationStateDirectory,
  databaseName: wranglerConfig.d1_databases?.find(
    (database) => database.binding === 'DB',
  )?.database_name,
  credentials,
}, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });

preparationServer = createServer((request, response) => {
  if (request.url === '/ready') {
    response.writeHead(200, { 'Content-Type': 'text/plain' });
    response.end('ready');
    return;
  }
  response.writeHead(404);
  response.end();
});
preparationServer.listen(preparationPort, host, () => {
  console.log(`E2E runtime prepared at http://${host}:${preparationPort}/ready`);
});

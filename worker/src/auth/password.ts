import { logOperationalFailure } from '../lib/operational-error';

type Argon2idComputeHash = (params: {
  password: Uint8Array;
  salt: Uint8Array;
  parallelism: number;
  passes: number;
  memorySize: number;
  tagLength: number;
}) => Uint8Array;

type ParsedArgon2idHash = {
  memory: number;
  passes: number;
  parallelism: number;
  salt: Uint8Array;
  hash: Uint8Array;
};

type WebAssemblyInstantiatedSourceLike = {
  module: WebAssembly.Module;
  instance: WebAssembly.Instance;
};

let argon2idPromise: Promise<Argon2idComputeHash> | null = null;
const ARGON2_MEMORY = 19456;
const ARGON2_PASSES = 2;
const ARGON2_PARALLELISM = 1;
const ARGON2_TAG_LENGTH = 32;
const ARGON2_SALT_LENGTH = 16;

function isVitestRuntime(): boolean {
  const processLike = (globalThis as typeof globalThis & {
    process?: { env?: Record<string, string | undefined> };
  }).process;
  return Boolean(processLike?.env?.VITEST);
}

async function loadArgon2idForWorkers(): Promise<Argon2idComputeHash> {
  const [{ default: setupWasm }, { default: simdWasm }, { default: nonSimdWasm }] = await Promise.all([
    import('argon2id/lib/setup'),
    import('argon2id/dist/simd.wasm'),
    import('argon2id/dist/no-simd.wasm'),
  ]);

  return setupWasm(
    async (imports) => ({
      module: simdWasm as WebAssembly.Module,
      instance: await WebAssembly.instantiate(simdWasm as WebAssembly.Module, imports),
    }),
    async (imports) => ({
      module: nonSimdWasm as WebAssembly.Module,
      instance: await WebAssembly.instantiate(nonSimdWasm as WebAssembly.Module, imports),
    }),
  ) as Promise<Argon2idComputeHash>;
}

async function loadArgon2idForVitest(): Promise<Argon2idComputeHash> {
  const [{ default: setupWasm }, fs, { fileURLToPath }] = await Promise.all([
    import('argon2id/lib/setup'),
    import('node:fs/promises'),
    import('node:url'),
  ]);

  const loadModuleFromFile = async (url: URL, imports: WebAssembly.Imports) => {
    const bytes = await fs.readFile(fileURLToPath(url.href));
    const buffer = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(buffer).set(bytes);
    const instantiated = await WebAssembly.instantiate(buffer, imports) as unknown as WebAssemblyInstantiatedSourceLike;
    return { module: instantiated.module, instance: instantiated.instance };
  };

  return setupWasm(
    (imports) => loadModuleFromFile(new URL('../../../node_modules/argon2id/dist/simd.wasm', import.meta.url), imports),
    (imports) => loadModuleFromFile(new URL('../../../node_modules/argon2id/dist/no-simd.wasm', import.meta.url), imports),
  ) as Promise<Argon2idComputeHash>;
}

async function getArgon2id(): Promise<Argon2idComputeHash> {
  if (!argon2idPromise) {
    argon2idPromise = isVitestRuntime() ? loadArgon2idForVitest() : loadArgon2idForWorkers();
  }
  return argon2idPromise;
}

function toBytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=+$/u, '');
}

function decodeBase64(value: string): Uint8Array {
  const padding = '='.repeat((4 - (value.length % 4)) % 4);
  const binary = atob(value.replaceAll('-', '+').replaceAll('_', '/') + padding);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes;
}

function asPositiveInteger(value: string | null): number {
  const numberValue = value ? Number.parseInt(value, 10) : Number.NaN;
  if (!Number.isInteger(numberValue) || numberValue <= 0) {
    throw new Error('Argon2id parameter must be a positive integer.');
  }
  return numberValue;
}

function parseArgon2idHash(encoded: string): ParsedArgon2idHash {
  const parts = encoded.split('$');
  if (parts.length !== 6 || parts[1] !== 'argon2id' || parts[2] !== 'v=19') {
    throw new Error('Unsupported password hash format.');
  }

  const params = new URLSearchParams(parts[3].replaceAll(',', '&'));
  return {
    memory: asPositiveInteger(params.get('m')),
    passes: asPositiveInteger(params.get('t')),
    parallelism: asPositiveInteger(params.get('p')),
    salt: decodeBase64(parts[4]),
    hash: decodeBase64(parts[5]),
  };
}

function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;

  let diff = 0;
  for (let index = 0; index < left.length; index += 1) {
    diff |= left[index] ^ right[index];
  }
  return diff === 0;
}

export async function hashPassword(password: string): Promise<string> {
  const argon2id = await getArgon2id();
  const salt = crypto.getRandomValues(new Uint8Array(ARGON2_SALT_LENGTH));
  const hash = argon2id({
    password: toBytes(password),
    salt,
    parallelism: ARGON2_PARALLELISM,
    passes: ARGON2_PASSES,
    memorySize: ARGON2_MEMORY,
    tagLength: ARGON2_TAG_LENGTH,
  });
  return `$argon2id$v=19$m=${ARGON2_MEMORY},t=${ARGON2_PASSES},p=${ARGON2_PARALLELISM}$${encodeBase64(salt)}$${encodeBase64(hash)}`;
}

export async function verifyPassword(password: string, encodedHash: string): Promise<boolean> {
  try {
    const parsed = parseArgon2idHash(encodedHash);
    if (parsed.parallelism !== 1) {
      throw new Error('Cloudflare Workers require Argon2id parallelism=1.');
    }

    const argon2id = await getArgon2id();
    const derivedHash = argon2id({
      password: toBytes(password),
      salt: parsed.salt,
      parallelism: parsed.parallelism,
      passes: parsed.passes,
      memorySize: parsed.memory,
      tagLength: parsed.hash.length,
    });
    return constantTimeEqual(derivedHash, parsed.hash);
  } catch (error) {
    logOperationalFailure('PASSWORD_VERIFICATION_NOT_AVAILABLE', {
      cause: error,
      metadata: {
        component: 'argon2id',
        action: 'verify_password',
      },
    });
    return false;
  }
}

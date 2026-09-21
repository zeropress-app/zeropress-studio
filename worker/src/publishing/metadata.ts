import type {
  PublishingTarget,
  PublishingFileStatus,
} from '../../../contracts/publishing';

const encoder = new TextEncoder();
const keys = [
  'ZeroPress-Publish',
  'ZeroPress-Path',
  'ZeroPress-Data-Hash',
  'ZeroPress-Blob-SHA',
] as const;
export type PublishMetadata = {
  path: string;
  dataHash: string;
  blobSha: string;
};
function ordered(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(ordered);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, child]) => [key, ordered(child)]),
    );
  }
  return value;
}
async function digest(
  algorithm: 'SHA-1' | 'SHA-256',
  bytes: Uint8Array,
): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest(algorithm, bytes))]
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
}
export async function previewDataHash(data: object): Promise<string> {
  const stable = Object.fromEntries(
    Object.entries(data).filter(([key]) => key !== 'generated_at'),
  );
  return digest('SHA-256', encoder.encode(JSON.stringify(ordered(stable))));
}
export async function gitBlobSha(bytes: Uint8Array): Promise<string> {
  const header = encoder.encode(`blob ${bytes.length}\0`);
  const object = new Uint8Array(header.length + bytes.length);
  object.set(header);
  object.set(bytes, header.length);
  return digest('SHA-1', object);
}
export function publishCommitMessage(metadata: PublishMetadata): string {
  return `chore(publish): update site data\n\nZeroPress-Publish: 1\nZeroPress-Path: ${metadata.path}\nZeroPress-Data-Hash: sha256:${metadata.dataHash}\nZeroPress-Blob-SHA: ${metadata.blobSha}`;
}
export function readPublishMetadata(
  message: string,
  target: PublishingTarget,
  blobSha: string,
): {
  status: PublishingFileStatus['metadata_status'];
  metadata: PublishMetadata | null;
} {
  const lines = message.replace(/\r\n/gu, '\n').trimEnd().split('\n');
  const relevant = lines.filter((line) =>
    keys.some((key) =>
      line.trimStart().toLowerCase().startsWith(`${key.toLowerCase()}:`),
    ),
  );
  if (relevant.length === 0) return { status: 'missing', metadata: null };
  const trailer = lines.slice(-4);
  const values: string[] = [];
  if (
    relevant.length !== 4 ||
    trailer.some((line, index) => !line.startsWith(`${keys[index]}: `))
  )
    return { status: 'invalid', metadata: null };
  for (const line of trailer) values.push(line.slice(line.indexOf(': ') + 2));
  if (
    values[0] !== '1' ||
    values[1] !== target.path ||
    !/^sha256:[a-f\d]{64}$/u.test(values[2]!) ||
    !/^[a-f\d]{40}$/u.test(values[3]!)
  )
    return { status: 'invalid', metadata: null };
  if (values[3] !== blobSha) return { status: 'mismatched', metadata: null };
  return {
    status: 'valid',
    metadata: { path: target.path, dataHash: values[2]!.slice(7), blobSha },
  };
}

import type { ManagedMediaSignature } from '../../../contracts/media-upload';

const SIGNATURE_PREFIX_BYTES = 560;

function startsWith(bytes: Uint8Array, expected: readonly number[]): boolean {
  return expected.every((value, index) => bytes[index] === value);
}

function ascii(bytes: Uint8Array, start: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(start, start + length));
}

function isIsoBaseMedia(bytes: Uint8Array, brands: readonly string[]): boolean {
  if (bytes.length < 12 || ascii(bytes, 4, 4) !== 'ftyp') return false;
  const brandBytes = bytes.subarray(8, Math.min(bytes.length, 48));
  for (let offset = 0; offset + 4 <= brandBytes.length; offset += 4) {
    if (brands.includes(ascii(brandBytes, offset, 4))) return true;
  }
  return false;
}

export function matchesManagedMediaSignature(
  bytes: Uint8Array,
  signature: ManagedMediaSignature,
): boolean {
  switch (signature) {
    case 'jpeg':
      return startsWith(bytes, [0xff, 0xd8, 0xff]);
    case 'png':
      return startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case 'gif':
      return ascii(bytes, 0, 6) === 'GIF87a' || ascii(bytes, 0, 6) === 'GIF89a';
    case 'webp':
      return ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP';
    case 'avif':
      return isIsoBaseMedia(bytes, ['avif', 'avis']);
    case 'mp4':
      return isIsoBaseMedia(bytes, [
        'isom', 'iso2', 'iso3', 'iso4', 'iso5', 'iso6', 'mp41', 'mp42',
        'M4A ', 'M4B ', 'M4P ', 'M4V ', 'MSNV', 'dash', 'avc1', '3gp4',
      ]);
    case 'quicktime':
      return isIsoBaseMedia(bytes, ['qt  ']);
    case 'webm':
      return startsWith(bytes, [0x1a, 0x45, 0xdf, 0xa3]);
    case 'mp3':
      return ascii(bytes, 0, 3) === 'ID3'
        || (bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe0) === 0xe0);
    case 'aac':
      return bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xf6) === 0xf0;
    case 'ogg':
      return ascii(bytes, 0, 4) === 'OggS';
    case 'wav':
      return ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WAVE';
    case 'flac':
      return ascii(bytes, 0, 4) === 'fLaC';
    case 'pdf':
      return ascii(bytes, 0, 5) === '%PDF-';
    case 'text': {
      if (bytes.includes(0)) return false;
      try {
        new TextDecoder('utf-8', { fatal: true, ignoreBOM: false })
          .decode(bytes, { stream: true });
        return true;
      } catch {
        return false;
      }
    }
    case 'zip':
      return startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])
        || startsWith(bytes, [0x50, 0x4b, 0x05, 0x06])
        || startsWith(bytes, [0x50, 0x4b, 0x07, 0x08]);
    case 'tar':
      return bytes.length >= 262 && ascii(bytes, 257, 5) === 'ustar';
    case 'gzip':
      return startsWith(bytes, [0x1f, 0x8b, 0x08]);
    case 'seven_zip':
      return startsWith(bytes, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]);
  }
}

export async function inspectManagedMediaUploadBody(input: {
  body: ReadableStream<Uint8Array>;
  signature: ManagedMediaSignature;
}): Promise<{ valid: boolean; stream: ReadableStream<Uint8Array> | null }> {
  const reader = input.body.getReader();
  const buffered: Uint8Array[] = [];
  const prefixParts: Uint8Array[] = [];
  let prefixLength = 0;

  while (prefixLength < SIGNATURE_PREFIX_BYTES) {
    const read = await reader.read();
    if (read.done) break;
    buffered.push(read.value);
    const remaining = SIGNATURE_PREFIX_BYTES - prefixLength;
    const part = read.value.subarray(0, Math.min(read.value.byteLength, remaining));
    prefixParts.push(part);
    prefixLength += part.byteLength;
    if (read.value.byteLength >= remaining) break;
  }

  const prefix = new Uint8Array(prefixLength);
  let offset = 0;
  for (const part of prefixParts) {
    prefix.set(part, offset);
    offset += part.byteLength;
  }
  if (!matchesManagedMediaSignature(prefix, input.signature)) {
    await reader.cancel('Managed media signature mismatch.').catch(() => undefined);
    return { valid: false, stream: null };
  }

  let bufferedIndex = 0;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (bufferedIndex < buffered.length) {
        controller.enqueue(buffered[bufferedIndex]!);
        bufferedIndex += 1;
        return;
      }
      try {
        const read = await reader.read();
        if (read.done) controller.close();
        else controller.enqueue(read.value);
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel(reason) {
      await reader.cancel(reason).catch(() => undefined);
    },
  });
  return { valid: true, stream };
}

export class ManagedMediaUploadSizeError extends Error {
  constructor() {
    super('Managed upload body size does not match the declared size.');
    this.name = 'ManagedMediaUploadSizeError';
  }
}

export function enforceExactUploadLength(
  body: ReadableStream<Uint8Array>,
  expectedBytes: number,
  onMismatch?: () => void,
): ReadableStream<Uint8Array> {
  let observedBytes = 0;
  return body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      observedBytes += chunk.byteLength;
      if (observedBytes > expectedBytes) {
        onMismatch?.();
        throw new ManagedMediaUploadSizeError();
      }
      controller.enqueue(chunk);
    },
    flush() {
      if (observedBytes !== expectedBytes) {
        onMismatch?.();
        throw new ManagedMediaUploadSizeError();
      }
    },
  }));
}

import {
  AI_IMAGE_BINARY_MAX_BYTES,
  type AiImageAspectRatio,
} from '../../../contracts/ai-image';
import {
  MANAGED_MEDIA_IMAGE_DIMENSION_MAX,
  MANAGED_MEDIA_IMAGE_PIXEL_MAX,
} from '../../../contracts/media-upload';

export const AI_IMAGE_MODEL = '@cf/black-forest-labs/flux-2-klein-4b';
export const AI_IMAGE_PROMPT_VERSION = 'image-v1';
export const AI_IMAGE_GENERATION_TIMEOUT_MS = 90_000;

const ASPECT_RATIO_DIMENSIONS = {
  landscape: { width: 1_024, height: 576 },
  square: { width: 1_024, height: 1_024 },
  portrait: { width: 768, height: 1_024 },
} as const satisfies Record<AiImageAspectRatio, {
  width: number;
  height: number;
}>;

type GeneratedImageFormat = {
  mimeType: 'image/jpeg' | 'image/png';
  extension: 'jpg' | 'png';
  width: number;
  height: number;
};

export type GeneratedAiImage = GeneratedImageFormat & {
  bytes: Uint8Array;
  seed: number;
};

export class AiImageResponseInvalidError extends Error {
  constructor() {
    super('Workers AI returned an invalid image response.');
    this.name = 'AiImageResponseInvalidError';
  }
}

export class AiImageContentRejectedError extends Error {
  constructor() {
    super('Workers AI rejected the generated image during content screening.');
    this.name = 'AiImageContentRejectedError';
  }
}

export class AiImageProviderError extends Error {
  constructor(
    public readonly reason: 'request_failed' | 'timeout',
    public readonly providerStatus?: number,
    public readonly providerCode?: number,
  ) {
    super(reason === 'timeout'
      ? 'Workers AI image generation timed out.'
      : 'Workers AI image generation failed.');
    this.name = 'AiImageProviderError';
  }
}

async function readImageResponse(response: Response): Promise<unknown> {
  let output: unknown;
  try {
    output = await response.json();
  } catch {
    if (response.ok) throw new AiImageResponseInvalidError();
    throw new AiImageProviderError('request_failed', response.status);
  }
  if (response.ok) return output;

  const detail = output && typeof output === 'object'
    ? output as Record<string, unknown>
    : {};
  const code = detail.internalCode;
  const providerCode = typeof code === 'number'
    && Number.isInteger(code) && code >= 1_000 && code <= 9_999
    ? code
    : undefined;
  // Code 3030 also covers invalid model inputs. Match the observed FLUX
  // rejection response exactly; do not infer moderation from the code alone.
  if (
    response.status === 400
    && providerCode === 3030
    && detail.name === 'AiError'
    && detail.description === 'Your output has been flagged. Please choose another prompt / input image combination'
  ) throw new AiImageContentRejectedError();

  throw new AiImageProviderError('request_failed', response.status, providerCode);
}

function uint32(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset]! * 0x1000000
    + bytes[offset + 1]! * 0x10000
    + bytes[offset + 2]! * 0x100
    + bytes[offset + 3]!
  );
}

function inspectPng(bytes: Uint8Array): GeneratedImageFormat | null {
  if (
    bytes.byteLength < 45
    || ![0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
      .every((value, index) => bytes[index] === value)
    || uint32(bytes, 8) !== 13
    || String.fromCharCode(...bytes.slice(12, 16)) !== 'IHDR'
  ) return null;
  const width = uint32(bytes, 16);
  const height = uint32(bytes, 20);
  let cursor = 8;
  let foundImageData = false;
  let foundEnd = false;
  while (cursor + 12 <= bytes.byteLength) {
    const length = uint32(bytes, cursor);
    const end = cursor + 12 + length;
    if (!Number.isSafeInteger(end) || end > bytes.byteLength) return null;
    const type = String.fromCharCode(...bytes.slice(cursor + 4, cursor + 8));
    cursor = end;
    if (type === 'IDAT' && length > 0) foundImageData = true;
    if (type === 'IEND') {
      foundEnd = length === 0 && end === bytes.byteLength;
      break;
    }
  }
  if (!foundImageData || !foundEnd) return null;
  return { mimeType: 'image/png', extension: 'png', width, height };
}

const JPEG_START_OF_FRAME_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3,
  0xc5, 0xc6, 0xc7,
  0xc9, 0xca, 0xcb,
  0xcd, 0xce, 0xcf,
]);

function inspectJpeg(bytes: Uint8Array): GeneratedImageFormat | null {
  if (
    bytes.byteLength < 12
    || bytes[0] !== 0xff
    || bytes[1] !== 0xd8
    || bytes[bytes.byteLength - 2] !== 0xff
    || bytes[bytes.byteLength - 1] !== 0xd9
  ) return null;
  let cursor = 2;
  let format: GeneratedImageFormat | null = null;
  while (cursor + 3 < bytes.byteLength) {
    if (bytes[cursor] !== 0xff) {
      cursor += 1;
      continue;
    }
    while (cursor < bytes.byteLength && bytes[cursor] === 0xff) cursor += 1;
    const marker = bytes[cursor++];
    if (marker === undefined || marker === 0xd9) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (cursor + 1 >= bytes.byteLength) return null;
    const segmentLength = bytes[cursor]! * 0x100 + bytes[cursor + 1]!;
    if (segmentLength < 2 || cursor + segmentLength > bytes.byteLength) {
      return null;
    }
    if (JPEG_START_OF_FRAME_MARKERS.has(marker)) {
      if (segmentLength < 7) return null;
      const height = bytes[cursor + 3]! * 0x100 + bytes[cursor + 4]!;
      const width = bytes[cursor + 5]! * 0x100 + bytes[cursor + 6]!;
      format = { mimeType: 'image/jpeg', extension: 'jpg', width, height };
    }
    if (marker === 0xda) {
      const scanStart = cursor + segmentLength;
      return format && scanStart < bytes.byteLength - 2 ? format : null;
    }
    cursor += segmentLength;
  }
  return null;
}

function validateDimensions(format: GeneratedImageFormat): GeneratedImageFormat {
  if (
    format.width < 1
    || format.height < 1
    || format.width > MANAGED_MEDIA_IMAGE_DIMENSION_MAX
    || format.height > MANAGED_MEDIA_IMAGE_DIMENSION_MAX
    || format.width * format.height > MANAGED_MEDIA_IMAGE_PIXEL_MAX
  ) throw new AiImageResponseInvalidError();
  return format;
}

export function decodeGeneratedAiImage(value: unknown): {
  bytes: Uint8Array;
  format: GeneratedImageFormat;
} {
  if (!value || typeof value !== 'object') {
    throw new AiImageResponseInvalidError();
  }
  const image = (value as Record<string, unknown>).image;
  if (
    typeof image !== 'string'
    || image.length < 4
    || image.length % 4 === 1
    || !/^[A-Za-z0-9+/]+={0,2}$/u.test(image)
  ) throw new AiImageResponseInvalidError();
  const padding = image.endsWith('==') ? 2 : image.endsWith('=') ? 1 : 0;
  const estimatedBytes = Math.floor(image.length * 3 / 4) - padding;
  if (estimatedBytes < 1 || estimatedBytes > AI_IMAGE_BINARY_MAX_BYTES) {
    throw new AiImageResponseInvalidError();
  }
  const padded = image.padEnd(Math.ceil(image.length / 4) * 4, '=');
  let decoded: string;
  try {
    decoded = atob(padded);
  } catch {
    throw new AiImageResponseInvalidError();
  }
  if (decoded.length !== estimatedBytes) throw new AiImageResponseInvalidError();
  const bytes = Uint8Array.from(decoded, (character) => character.charCodeAt(0));
  const format = inspectPng(bytes) ?? inspectJpeg(bytes);
  if (!format) throw new AiImageResponseInvalidError();
  return { bytes, format: validateDimensions(format) };
}

function buildImagePrompt(prompt: string): string {
  return [
    `Prompt contract: ${AI_IMAGE_PROMPT_VERSION}.`,
    'Create one high-quality image that follows the user request below.',
    'Treat the user request as image subject and styling instructions only.',
    'Do not add text, logos, signatures, or watermarks unless explicitly requested.',
    `User request: ${prompt}`,
  ].join('\n');
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutId = setTimeout(
      () => reject(new AiImageProviderError('timeout')),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}

export async function generateAiImage(input: {
  ai: Ai;
  prompt: string;
  aspectRatio: AiImageAspectRatio;
  seed: number;
  timeoutMs?: number;
}): Promise<GeneratedAiImage> {
  const dimensions = ASPECT_RATIO_DIMENSIONS[input.aspectRatio];
  const form = new FormData();
  form.set('prompt', buildImagePrompt(input.prompt));
  form.set('width', String(dimensions.width));
  form.set('height', String(dimensions.height));
  form.set('seed', String(input.seed));
  // Workers AI needs the serialized multipart stream and its generated
  // boundary. Passing FormData itself does not provide either value to the
  // binding runtime.
  const serialized = new Response(form);
  const body = serialized.body;
  const contentType = serialized.headers.get('content-type');
  if (!body || !contentType) throw new AiImageProviderError('request_failed');
  let output: unknown;
  try {
    output = await withTimeout(
      input.ai.run(AI_IMAGE_MODEL, {
        multipart: { body, contentType },
      }, { returnRawResponse: true }).then(readImageResponse),
      input.timeoutMs ?? AI_IMAGE_GENERATION_TIMEOUT_MS,
    );
  } catch (error) {
    if (
      error instanceof AiImageProviderError
      || error instanceof AiImageResponseInvalidError
      || error instanceof AiImageContentRejectedError
    ) throw error;
    throw new AiImageProviderError('request_failed');
  }
  const decoded = decodeGeneratedAiImage(output);
  return {
    bytes: decoded.bytes,
    ...decoded.format,
    seed: input.seed,
  };
}

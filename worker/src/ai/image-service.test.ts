import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AI_IMAGE_MODEL,
  AI_IMAGE_PROMPT_VERSION,
  AiImageContentRejectedError,
  AiImageProviderError,
  AiImageResponseInvalidError,
  decodeGeneratedAiImage,
  generateAiImage,
} from './image-service';

const ONE_PIXEL_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

const THREE_BY_TWO_JPEG_BASE64 = btoa(String.fromCharCode(
  0xff, 0xd8,
  0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x02, 0x00, 0x03, 0x03,
  0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00,
  0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00,
  0x00,
  0xff, 0xd9,
));

const CONTENT_REJECTION = {
  internalCode: 3030,
  name: 'AiError',
  description: 'Your output has been flagged. Please choose another prompt / input image combination',
};

function generateWith(run: ReturnType<typeof vi.fn>, timeoutMs?: number) {
  return generateAiImage({
    ai: { run } as unknown as Ai,
    prompt: 'A quiet library at sunrise',
    aspectRatio: 'landscape',
    seed: 42,
    timeoutMs,
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('AI image output boundary', () => {
  it('decodes a complete PNG and obtains intrinsic dimensions from bytes', () => {
    const result = decodeGeneratedAiImage({ image: ONE_PIXEL_PNG_BASE64 });
    expect(result.format).toEqual({
      mimeType: 'image/png',
      extension: 'png',
      width: 1,
      height: 1,
    });
    expect(result.bytes.byteLength).toBeGreaterThan(40);
  });

  it('decodes a structurally complete JPEG and obtains intrinsic dimensions', () => {
    const result = decodeGeneratedAiImage({ image: THREE_BY_TWO_JPEG_BASE64 });
    expect(result.format).toEqual({
      mimeType: 'image/jpeg',
      extension: 'jpg',
      width: 3,
      height: 2,
    });
  });

  it.each([
    null,
    {},
    { image: 'data:image/png;base64,AAAA' },
    { image: 'not base64!' },
    { image: btoa('not an image') },
  ])('rejects malformed provider output without guessing a format', (output) => {
    expect(() => decodeGeneratedAiImage(output))
      .toThrow(AiImageResponseInvalidError);
  });

  it('uses the fixed model and multipart image-v1 contract', async () => {
    const run = vi.fn().mockResolvedValue(Response.json({ image: ONE_PIXEL_PNG_BASE64 }));
    const result = await generateWith(run);
    expect(result).toMatchObject({
      mimeType: 'image/png',
      extension: 'png',
      width: 1,
      height: 1,
      seed: 42,
    });
    const multipart = run.mock.calls[0]![1].multipart as {
      body: ReadableStream<Uint8Array>;
      contentType: string;
    };
    expect(run).toHaveBeenCalledWith(AI_IMAGE_MODEL, {
      multipart: {
        body: expect.any(ReadableStream),
        contentType: expect.stringMatching(
          /^multipart\/form-data;\s*boundary=.+$/u,
        ),
      },
    }, { returnRawResponse: true });
    const form = await new Response(multipart.body, {
      headers: { 'Content-Type': multipart.contentType },
    }).formData();
    expect(form.get('prompt')).toContain(`Prompt contract: ${AI_IMAGE_PROMPT_VERSION}.`);
    expect(form.get('prompt')).toContain('A quiet library at sunrise');
    expect(form.get('width')).toBe('1024');
    expect(form.get('height')).toBe('576');
    expect(form.get('seed')).toBe('42');
  });

  it('classifies the verified provider content rejection separately', async () => {
    const run = vi.fn().mockResolvedValue(Response.json(CONTENT_REJECTION, {
      status: 400,
    }));
    await expect(generateWith(run)).rejects.toBeInstanceOf(AiImageContentRejectedError);
  });

  it.each([
    { status: 400, detail: { ...CONTENT_REJECTION, description: 'Model input is not valid: missing required input mask_image' } },
    { status: 500, detail: CONTENT_REJECTION },
    { status: 403, detail: { internalCode: 3023, description: 'Service unavailable for account' } },
  ])('keeps provider failure diagnostics for HTTP $status: $detail.description', async ({ status, detail }) => {
    const run = vi.fn().mockResolvedValue(Response.json(detail, { status }));
    await expect(generateWith(run)).rejects.toMatchObject({
      name: 'AiImageProviderError',
      reason: 'request_failed',
      providerStatus: status,
      providerCode: detail.internalCode,
    });
  });

  it.each([
    { body: '<html>provider failure</html>' },
    { body: JSON.stringify({ internalCode: '3030: private-provider-text' }) },
    { body: JSON.stringify({ internalCode: 3030.5 }) },
    { body: JSON.stringify({ internalCode: 100_000 }) },
  ])('keeps the HTTP status when provider diagnostics are malformed: $body', async ({ body }) => {
    const run = vi.fn().mockResolvedValue(new Response(body, { status: 502 }));
    await expect(generateWith(run)).rejects.toMatchObject({
      name: 'AiImageProviderError',
      reason: 'request_failed',
      providerStatus: 502,
      providerCode: undefined,
    });
  });

  it('treats malformed successful JSON as unusable image output', async () => {
    const run = vi.fn().mockResolvedValue(new Response('{', { status: 200 }));
    await expect(generateWith(run)).rejects.toBeInstanceOf(AiImageResponseInvalidError);
  });

  it('keeps binding exceptions separate from structured provider rejections', async () => {
    const run = vi.fn().mockRejectedValue(new Error(CONTENT_REJECTION.description));
    await expect(generateWith(run)).rejects.toEqual(new AiImageProviderError('request_failed'));
  });

  it.each(['request', 'response body'])('times out while waiting for the %s', async (stage) => {
    vi.useFakeTimers();
    const pending = new Promise<never>(() => {});
    const response = Response.json({});
    vi.spyOn(response, 'json').mockReturnValue(pending);
    const run = vi.fn().mockReturnValue(stage === 'request'
      ? pending
      : Promise.resolve(response));
    const result = expect(generateWith(run, 100)).rejects.toMatchObject({
      name: 'AiImageProviderError',
      reason: 'timeout',
    });
    await vi.advanceTimersByTimeAsync(100);
    await result;
  });
});

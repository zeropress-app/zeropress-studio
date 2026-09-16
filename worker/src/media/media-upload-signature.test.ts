import { describe, expect, it } from 'vitest';
import {
  enforceExactUploadLength,
  inspectManagedMediaUploadBody,
  matchesManagedMediaSignature,
} from './media-upload-signature';

function bytes(...values: number[]) {
  return new Uint8Array(values);
}

describe('managed Media signature inspection', () => {
  it('recognizes representative binary and text formats', () => {
    expect(matchesManagedMediaSignature(
      bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a),
      'png',
    )).toBe(true);
    expect(matchesManagedMediaSignature(
      new TextEncoder().encode('%PDF-1.7'),
      'pdf',
    )).toBe(true);
    expect(matchesManagedMediaSignature(
      new TextEncoder().encode('hello,세계\n'),
      'text',
    )).toBe(true);
    expect(matchesManagedMediaSignature(bytes(0x00, 0x41), 'text')).toBe(false);
  });

  it('preserves all stream chunks after bounded prefix inspection', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes(0xff, 0xd8));
        controller.enqueue(bytes(0xff, 0x01, 0x02));
        controller.close();
      },
    });
    const inspected = await inspectManagedMediaUploadBody({
      body,
      signature: 'jpeg',
    });
    expect(inspected.valid).toBe(true);
    const output = await new Response(inspected.stream).bytes();
    expect([...output]).toEqual([0xff, 0xd8, 0xff, 0x01, 0x02]);
  });

  it('rejects mismatched signatures and declared-length drift', async () => {
    const inspected = await inspectManagedMediaUploadBody({
      body: new Blob(['not a png']).stream(),
      signature: 'png',
    });
    expect(inspected).toEqual({ valid: false, stream: null });
    await expect(new Response(enforceExactUploadLength(
      new Blob(['1234']).stream(),
      3,
    )).arrayBuffer()).rejects.toThrow('does not match');
  });
});

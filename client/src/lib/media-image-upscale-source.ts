import {
  MediaImageUpscaleError,
} from './media-image-upscale';

export type DecodedMediaImageUpscaleSource = {
  canvas: HTMLCanvasElement;
  pixels: ImageData;
  hasTransparency: boolean;
};

export async function decodeMediaImageUpscaleSource(input: {
  blob: Blob;
  expectedWidth: number;
  expectedHeight: number;
}): Promise<DecodedMediaImageUpscaleSource> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(input.blob);
  } catch (error) {
    throw new MediaImageUpscaleError('DECODE_FAILED', error);
  }

  try {
    if (
      bitmap.width !== input.expectedWidth
      || bitmap.height !== input.expectedHeight
    ) {
      throw new MediaImageUpscaleError('SOURCE_DIMENSION_MISMATCH');
    }
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext('2d', {
      alpha: true,
      willReadFrequently: true,
    });
    if (!context) throw new MediaImageUpscaleError('DECODE_FAILED');
    context.drawImage(bitmap, 0, 0);
    let pixels: ImageData;
    try {
      pixels = context.getImageData(0, 0, canvas.width, canvas.height);
    } catch (error) {
      throw new MediaImageUpscaleError('DECODE_FAILED', error);
    }
    let hasTransparency = false;
    for (let index = 3; index < pixels.data.length; index += 4) {
      if (pixels.data[index] !== 255) {
        hasTransparency = true;
        break;
      }
    }
    return { canvas, pixels, hasTransparency };
  } finally {
    bitmap.close();
  }
}

export async function inspectMediaImageUpscaleSource(input: {
  blob: Blob;
  expectedWidth: number;
  expectedHeight: number;
}): Promise<{ hasTransparency: boolean }> {
  const decoded = await decodeMediaImageUpscaleSource(input);
  decoded.canvas.width = 0;
  decoded.canvas.height = 0;
  return { hasTransparency: decoded.hasTransparency };
}

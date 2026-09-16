/// <reference lib="webworker" />

import '../lib/zod-runtime';
import {
  drawMediaImage,
  validateMediaImageTransformRecipe,
  type MediaImageRenderWorkerRequest,
} from '../lib/media-image-transform';

self.addEventListener('message', (event: MessageEvent<MediaImageRenderWorkerRequest>) => {
  void (async () => {
    let bitmap: ImageBitmap | null = null;
    try {
      bitmap = await createImageBitmap(event.data.blob);
      if (!validateMediaImageTransformRecipe(
        event.data.recipe,
        bitmap.width,
        bitmap.height,
      )) throw new TypeError('Invalid image transform recipe.');
      const canvas = new OffscreenCanvas(
        event.data.recipe.outputWidth,
        event.data.recipe.outputHeight,
      );
      const context = canvas.getContext('2d');
      if (!context) throw new Error('2D canvas is unavailable.');
      drawMediaImage({
        context,
        source: bitmap,
        recipe: event.data.recipe,
        targetWidth: event.data.recipe.outputWidth,
        targetHeight: event.data.recipe.outputHeight,
        outputMimeType: event.data.outputMimeType,
        onSharpenProgress: (completedRows, totalRows) => self.postMessage({
          type: 'progress',
          progress: totalRows > 0 ? completedRows / totalRows : 1,
        }),
      });
      const output = await canvas.convertToBlob({
        type: event.data.outputMimeType,
        quality: event.data.outputMimeType === 'image/png'
          ? undefined
          : event.data.quality,
      });
      self.postMessage({ type: 'result', success: true, blob: output });
    } catch (error) {
      self.postMessage({
        type: 'result',
        success: false,
        diagnostic: error instanceof Error
          ? `${error.name}: ${error.message}`
          : 'Unknown image render failure.',
      });
    } finally {
      bitmap?.close();
    }
  })();
});

export {};

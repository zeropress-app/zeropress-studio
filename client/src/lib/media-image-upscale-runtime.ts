import * as tf from '@tensorflow/tfjs-core';
import {
  loadGraphModel,
  type GraphModel,
} from '@tensorflow/tfjs-converter';
import '@tensorflow/tfjs-backend-webgl';
import {
  MANAGED_MEDIA_UPLOAD_MAX_BYTES,
} from '../../../contracts/media-upload';
import {
  MEDIA_IMAGE_UPSCALE_MODEL_SCALE,
  MEDIA_IMAGE_UPSCALE_TILE_SIZE,
  isMediaImageUpscaleDimensioned,
  type MediaImageUpscaleScale,
} from '../../../contracts/media-image-upscale';
import type { MediaImageEditorOutputMimeType } from '../../../contracts/media-image-editor';
import {
  MEDIA_IMAGE_UPSCALE_MODEL,
  MediaImageUpscaleError,
  createMediaImageUpscaleTileInput,
  createMediaImageUpscaleTilePlan,
  isMediaImageUpscaleModelDescriptorCompatible,
  mediaImageUpscaleModelCrop,
  mediaImageUpscaleOutputRect,
  type MediaImageUpscaleProgress,
} from './media-image-upscale';
import { decodeMediaImageUpscaleSource } from './media-image-upscale-source';

let modelPromise: Promise<GraphModel> | null = null;

function abortIfRequested(signal: AbortSignal) {
  if (signal.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new DOMException('Image upscale cancelled.', 'AbortError');
  }
}

function isExpectedModelShape(shape: readonly (number | null)[], expected: number[]) {
  return shape.length === expected.length
    && shape.every((value, index) => value === expected[index]);
}

async function loadUpscaleModel(
  signal: AbortSignal,
  onProgress: (progress: MediaImageUpscaleProgress) => void,
): Promise<GraphModel> {
  abortIfRequested(signal);
  if (!modelPromise) {
    modelPromise = (async () => {
      let backendReady = false;
      try {
        backendReady = await tf.setBackend('webgl');
        await tf.ready();
      } catch (error) {
        throw new MediaImageUpscaleError('WEBGL_UNAVAILABLE', error);
      }
      if (!backendReady || tf.getBackend() !== 'webgl') {
        throw new MediaImageUpscaleError('WEBGL_UNAVAILABLE');
      }

      let model: GraphModel;
      try {
        model = await loadGraphModel(MEDIA_IMAGE_UPSCALE_MODEL.modelUrl, {
          onProgress: (fraction) => onProgress({
            stage: 'loading_model',
            progress: Math.max(0, Math.min(1, fraction)),
          }),
        });
      } catch (error) {
        if (error instanceof MediaImageUpscaleError) throw error;
        throw new MediaImageUpscaleError('MODEL_LOAD_FAILED', error);
      }

      if (!isMediaImageUpscaleModelDescriptorCompatible({
        inputs: model.inputs,
        outputs: model.outputs,
      })) {
        model.dispose();
        throw new MediaImageUpscaleError('MODEL_INVALID');
      }
      return model;
    })().catch((error) => {
      modelPromise = null;
      throw error;
    });
  } else {
    onProgress({ stage: 'loading_model', progress: 1 });
  }
  const model = await modelPromise;
  abortIfRequested(signal);
  return model;
}

function canvasContext(
  canvas: HTMLCanvasElement,
  options?: CanvasRenderingContext2DSettings,
): CanvasRenderingContext2D {
  const context = canvas.getContext('2d', options);
  if (!context) throw new MediaImageUpscaleError('INFERENCE_FAILED');
  return context;
}

function outputTensorFromPrediction(
  prediction: tf.Tensor | tf.Tensor[] | tf.NamedTensorMap,
): tf.Tensor {
  const tensors = Array.isArray(prediction)
    ? prediction
    : 'shape' in prediction
      ? [prediction as tf.Tensor]
      : Object.values(prediction);
  const output = tensors[0];
  if (!output || !isExpectedModelShape(output.shape, [1, 256, 256, 3])) {
    tensors.forEach((tensor) => tensor.dispose());
    throw new MediaImageUpscaleError('MODEL_INVALID');
  }
  tensors.slice(1).forEach((tensor) => tensor.dispose());
  return output;
}

function encodeCanvas(
  canvas: HTMLCanvasElement,
  mimeType: MediaImageEditorOutputMimeType,
  quality: number,
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob || blob.type !== mimeType) {
        reject(new MediaImageUpscaleError('ENCODE_FAILED'));
        return;
      }
      resolve(blob);
    }, mimeType, quality);
  });
}

export async function upscaleMediaImage(input: {
  blob: Blob;
  width: number;
  height: number;
  scale: MediaImageUpscaleScale;
  outputMimeType: MediaImageEditorOutputMimeType;
  quality: number;
  hasTransparency: boolean;
  signal: AbortSignal;
  onProgress: (progress: MediaImageUpscaleProgress) => void;
}): Promise<{ blob: Blob; width: number; height: number }> {
  if (!isMediaImageUpscaleDimensioned(input, input.scale)) {
    throw new MediaImageUpscaleError('OUTPUT_TOO_LARGE');
  }
  if (
    input.hasTransparency
    && input.outputMimeType === 'image/jpeg'
  ) {
    throw new MediaImageUpscaleError('ALPHA_JPEG_UNSUPPORTED');
  }
  if (!Number.isFinite(input.quality) || input.quality < 0.1 || input.quality > 1) {
    throw new MediaImageUpscaleError('ENCODE_FAILED');
  }

  input.onProgress({ stage: 'preparing' });
  abortIfRequested(input.signal);
  const decoded = await decodeMediaImageUpscaleSource({
    blob: input.blob,
    expectedWidth: input.width,
    expectedHeight: input.height,
  });
  if (decoded.hasTransparency !== input.hasTransparency) {
    decoded.canvas.width = 0;
    decoded.canvas.height = 0;
    throw new MediaImageUpscaleError('SOURCE_DIMENSION_MISMATCH');
  }

  const outputWidth = input.width * input.scale;
  const outputHeight = input.height * input.scale;
  const outputCanvas = document.createElement('canvas');
  outputCanvas.width = outputWidth;
  outputCanvas.height = outputHeight;
  const outputContext = canvasContext(outputCanvas, { alpha: true });
  outputContext.imageSmoothingEnabled = true;
  outputContext.imageSmoothingQuality = 'high';

  const modelCanvas = document.createElement('canvas');
  modelCanvas.width = MEDIA_IMAGE_UPSCALE_TILE_SIZE
    * MEDIA_IMAGE_UPSCALE_MODEL_SCALE;
  modelCanvas.height = MEDIA_IMAGE_UPSCALE_TILE_SIZE
    * MEDIA_IMAGE_UPSCALE_MODEL_SCALE;
  const modelContext = canvasContext(modelCanvas, { alpha: false });
  const modelPixels = modelContext.createImageData(
    modelCanvas.width,
    modelCanvas.height,
  );

  try {
    const model = await loadUpscaleModel(input.signal, input.onProgress);
    const tiles = createMediaImageUpscaleTilePlan(input.width, input.height);
    input.onProgress({ stage: 'processing', completed: 0, total: tiles.length });

    for (let index = 0; index < tiles.length; index += 1) {
      abortIfRequested(input.signal);
      const tile = tiles[index]!;
      const tensor = tf.tensor4d(
        createMediaImageUpscaleTileInput({
          source: decoded.pixels.data,
          sourceWidth: input.width,
          sourceHeight: input.height,
          tile,
        }),
        [1, MEDIA_IMAGE_UPSCALE_TILE_SIZE, MEDIA_IMAGE_UPSCALE_TILE_SIZE, 3],
        'float32',
      );
      let output: tf.Tensor | null = null;
      try {
        output = outputTensorFromPrediction(model.predict(tensor));
        const values = await output.data();
        for (let pixel = 0; pixel < modelCanvas.width * modelCanvas.height; pixel += 1) {
          const source = pixel * 3;
          const target = pixel * 4;
          modelPixels.data[target] = Math.round(
            Math.max(0, Math.min(1, values[source]!)) * 255,
          );
          modelPixels.data[target + 1] = Math.round(
            Math.max(0, Math.min(1, values[source + 1]!)) * 255,
          );
          modelPixels.data[target + 2] = Math.round(
            Math.max(0, Math.min(1, values[source + 2]!)) * 255,
          );
          modelPixels.data[target + 3] = 255;
        }
        modelContext.putImageData(modelPixels, 0, 0);
      } catch (error) {
        if (error instanceof MediaImageUpscaleError) throw error;
        throw new MediaImageUpscaleError('INFERENCE_FAILED', error);
      } finally {
        tensor.dispose();
        output?.dispose();
      }

      const crop = mediaImageUpscaleModelCrop(tile);
      const destination = mediaImageUpscaleOutputRect(tile, input.scale);
      outputContext.drawImage(
        modelCanvas,
        crop.x,
        crop.y,
        crop.width,
        crop.height,
        destination.x,
        destination.y,
        destination.width,
        destination.height,
      );
      input.onProgress({
        stage: 'processing',
        completed: index + 1,
        total: tiles.length,
      });
      if ((index + 1) % 4 === 0) await tf.nextFrame();
    }

    abortIfRequested(input.signal);
    if (input.hasTransparency) {
      outputContext.save();
      outputContext.globalCompositeOperation = 'destination-in';
      outputContext.drawImage(decoded.canvas, 0, 0, outputWidth, outputHeight);
      outputContext.restore();
    }
    input.onProgress({ stage: 'encoding' });
    const blob = await encodeCanvas(
      outputCanvas,
      input.outputMimeType,
      input.quality,
    );
    if (blob.size > MANAGED_MEDIA_UPLOAD_MAX_BYTES) {
      throw new MediaImageUpscaleError('OUTPUT_TOO_LARGE');
    }
    abortIfRequested(input.signal);
    return { blob, width: outputWidth, height: outputHeight };
  } finally {
    decoded.canvas.width = 0;
    decoded.canvas.height = 0;
    modelCanvas.width = 0;
    modelCanvas.height = 0;
    outputCanvas.width = 0;
    outputCanvas.height = 0;
  }
}

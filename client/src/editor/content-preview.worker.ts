import { createContentPreviewDocument } from './content-preview-document';
import type { ContentPreviewRequest, ContentPreviewResponse } from './content-preview';

self.onmessage = (event: MessageEvent<ContentPreviewRequest>) => {
  let response: ContentPreviewResponse;
  try {
    response = { success: true, document: createContentPreviewDocument(event.data) };
  } catch {
    response = { success: false };
  }
  self.postMessage(response);
};

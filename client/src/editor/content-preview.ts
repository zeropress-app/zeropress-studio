import type { DocumentType } from '@zeropress/build-core/content';

export type ContentPreviewSource = {
  title: string;
  content: string;
  documentType: DocumentType;
  baseUrl: string;
};

export type ContentPreviewRequest = ContentPreviewSource & {
  language: string;
  dark: boolean;
  labels: {
    linkDetails: string;
    address: string;
    target: string;
    newWindow: string;
    sameWindow: string;
    embedTitle: string;
    embedUnavailable: string;
    missingAddress: string;
    close: string;
  };
};

export type ContentPreviewResponse =
  | { success: true; document: string }
  | { success: false };

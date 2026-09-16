import type { AiPostEditSelectionKind } from '../../../contracts/ai-post-edit';

type ContentAiSelectionBase = {
  baseContent: string;
  selectedContent: string;
  contextBefore: string;
  contextAfter: string;
  selectionKind: AiPostEditSelectionKind;
};

export type SourceContentAiSelection = ContentAiSelectionBase & {
  kind: 'source';
  start: number;
  end: number;
  selectionKind: 'source';
};

export type VisualContentAiSelection = ContentAiSelectionBase & {
  kind: 'visual';
  from: number;
  to: number;
  selectionKind: 'inline' | 'block';
};

export type ContentAiSelection =
  | SourceContentAiSelection
  | VisualContentAiSelection;

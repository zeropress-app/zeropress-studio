import type { Page, TestInfo } from '@playwright/test';
import { z } from 'zod';

export const EDITOR_DIAGNOSTIC_ANNOTATION = 'zeropress:editor-state';

const stageSchema = z.enum([
  'source-input', 'conversion-review', 'conversion-confirmation',
  'source-round-trip', 'visual-round-trip',
]);
export type EditorDiagnosticStage = z.infer<typeof stageSchema>;

const countSchema = z.number().int().nonnegative();
const diagnosticSchema = z.discriminatedUnion('captured', [
  z.object({ stage: stageSchema, captured: z.literal(false) }),
  z.object({
    stage: stageSchema,
    captured: z.literal(true),
    mode: z.enum(['source', 'visual', 'unknown']),
    conversionDialogOpen: z.boolean(),
    sourceEditorCount: countSchema,
    sourceReady: z.boolean(),
    sourceContainsExpectedText: z.boolean(),
    visualEditorCount: countSchema,
    strongCount: countSchema,
    visualTextMatches: z.boolean(),
  }),
]);
export type EditorDiagnostic = z.infer<typeof diagnosticSchema>;

export function readEditorDiagnostic(
  annotations: ReadonlyArray<{ type: string; description?: string }>,
): EditorDiagnostic | undefined {
  const annotation = annotations.findLast(({ type }) => type === EDITOR_DIAGNOSTIC_ANNOTATION);
  if (!annotation?.description) return undefined;
  try {
    // Project only the allowed enum, boolean and numeric fields; never retain raw JSON.
    const parsed = diagnosticSchema.safeParse(JSON.parse(annotation.description));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

export async function recordEditorFailure(
  page: Page,
  testInfo: Pick<TestInfo, 'annotations'>,
  stage: EditorDiagnosticStage,
  expectedText: string,
): Promise<void> {
  const unavailable: EditorDiagnostic = { stage, captured: false };
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    const diagnostic = await Promise.race([
      page.evaluate(({ stage, expectedText }): EditorDiagnostic => {
        const normalize = (text: string | null | undefined) => (text ?? '').replace(/\s+/gu, ' ').trim();
        const modeButtons = [...document.querySelectorAll('.content-editor-mode-buttons button')];
        const active = modeButtons.filter((button) => button.getAttribute('aria-pressed') === 'true');
        const label = active.length === 1 ? normalize(active[0].textContent) : '';
        const sources = document.querySelectorAll('.content-editor-source-monaco');
        const sourceInput = sources.length === 1
          ? sources[0].querySelector<HTMLElement>('[role="textbox"]') : null;
        const visuals = [...document.querySelectorAll('.studio-visual-editor-surface')];
        return {
          stage, captured: true,
          mode: label === 'HTML source' ? 'source' : label === 'Visual' ? 'visual' : 'unknown',
          conversionDialogOpen: [...document.querySelectorAll('[role="dialog"]')].some((dialog) => (
            normalize(dialog.querySelector('h2')?.textContent) === 'Use the visual editor?'
            && dialog.checkVisibility()
          )),
          sourceEditorCount: sources.length,
          sourceReady: sourceInput !== null && sourceInput.checkVisibility()
            && !sourceInput.closest('[inert]')
            && sourceInput.getAttribute('aria-readonly') !== 'true'
            && (sourceInput.isContentEditable || (
              sourceInput instanceof HTMLTextAreaElement && !sourceInput.disabled && !sourceInput.readOnly
            )),
          sourceContainsExpectedText: sources.length === 1
            && normalize(sources[0].querySelector('.view-lines')?.textContent).includes(expectedText),
          visualEditorCount: visuals.length,
          strongCount: visuals.reduce((count, editor) => count + editor.querySelectorAll('strong').length, 0),
          visualTextMatches: visuals.length === 1 && normalize(visuals[0].textContent) === expectedText,
        };
      }, { stage, expectedText }),
      new Promise<EditorDiagnostic>((resolve) => {
        deadline = setTimeout(() => resolve(unavailable), 1_000);
      }),
    ]).catch(() => unavailable);
    testInfo.annotations.push({
      type: EDITOR_DIAGNOSTIC_ANNOTATION,
      description: JSON.stringify(diagnostic),
    });
  } finally {
    clearTimeout(deadline);
  }
}

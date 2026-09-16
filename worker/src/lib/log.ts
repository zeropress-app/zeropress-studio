type StudioLogMetadata = Record<string, unknown>;

function compactMetadata(
  metadata: StudioLogMetadata | undefined,
): StudioLogMetadata | undefined {
  if (!metadata) {
    return undefined;
  }

  const entries = Object.entries(metadata).filter(([, value]) => value !== undefined);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function createStudioLog(
  message: string,
  metadata?: StudioLogMetadata,
): Record<string, unknown> {
  const compactedMetadata = compactMetadata(metadata);
  return compactedMetadata
    ? { message, $zeropress: compactedMetadata }
    : { message };
}

export function getLogErrorType(error: unknown): string {
  // Exception messages, names, stacks and causes can contain credentials or
  // bound SQL/request data. Emit only an application-owned classification.
  if (error instanceof TypeError) return 'TypeError';
  if (error instanceof RangeError) return 'RangeError';
  if (error instanceof SyntaxError) return 'SyntaxError';
  if (error instanceof Error) return 'Error';
  return 'NonError';
}

export function logError(message: string, metadata?: StudioLogMetadata): void {
  console.error(createStudioLog(message, metadata));
}

export function logWarn(message: string, metadata?: StudioLogMetadata): void {
  console.warn(createStudioLog(message, metadata));
}

export function logInfo(message: string, metadata?: StudioLogMetadata): void {
  console.log(createStudioLog(message, metadata));
}

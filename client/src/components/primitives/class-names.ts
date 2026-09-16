/**
 * Class-name helper for primitives.
 *
 * A minimal implementation avoids another utility dependency. Filter false, null, and undefined,
 * then join remaining tokens with spaces.
 */
export function classNames(
  ...values: readonly (string | false | null | undefined)[]
): string | undefined {
  const tokens = values.filter(
    (value): value is string => typeof value === 'string' && value.length > 0,
  );
  return tokens.length > 0 ? tokens.join(' ') : undefined;
}

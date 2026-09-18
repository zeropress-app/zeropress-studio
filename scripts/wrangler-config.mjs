import { applyEdits, format, parse, printParseErrorCode } from 'jsonc-parser';

function parseConfig(contents) {
  const errors = [];
  const config = parse(contents, errors, { allowTrailingComma: true });
  if (errors.length) {
    const { error, offset } = errors[0];
    const lines = contents.slice(0, offset).split(/\r\n|\r|\n/u);
    throw new Error(`Invalid JSONC in wrangler.jsonc at line ${lines.length}, column ${lines.at(-1).length + 1}: ${printParseErrorCode(error)}.`);
  }
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('wrangler.jsonc must contain a JSON object.');
  }
  return config;
}

export function formatWranglerConfig(contents) {
  parseConfig(contents);
  // Match Wrangler's configuration write-back formatter and default options.
  return applyEdits(contents, format(contents, undefined, {}));
}

export function serializeWranglerConfig(contents) {
  return JSON.stringify(parseConfig(contents), (_key, value) => {
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      return Object.fromEntries(Object.keys(value).sort().map((key) => [key, value[key]]));
    }
    return value;
  });
}

// Studio uses sax.parser(), not its optional Node SAXStream wrapper. Exposing
// an empty browser-side Stream value selects sax's built-in parser-only
// fallback without bundling a Node stream polyfill.
export const Stream = undefined;

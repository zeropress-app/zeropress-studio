declare module 'sax' {
  const sax: {
    parser(strict: boolean, options?: Record<string, unknown>): {
      onerror: ((error: Error) => void) | null;
      ondoctype: (() => void) | null;
      onopentag: ((node: SaxTag) => void) | null;
      ontext: ((text: string) => void) | null;
      oncdata: ((text: string) => void) | null;
      onclosetag: (() => void) | null;
      write(chunk: string): unknown;
      close(): unknown;
    };
  };

  type SaxAttribute = {
    name?: string;
    local?: string;
    uri?: string;
    value?: unknown;
  };

  type SaxTag = {
    name: string;
    local?: string;
    uri?: string;
    ns?: Record<string, string>;
    attributes?: Record<string, SaxAttribute>;
  };

  export default sax;
}

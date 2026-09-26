declare module 'parse-srcset' {
  export default function parseSrcset(value: string): Array<{ url: string; w?: number; d?: number; h?: number }>;
}

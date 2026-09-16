declare module 'argon2id/dist/simd.wasm' {
  const module: WebAssembly.Module;
  export default module;
}

declare module 'argon2id/dist/no-simd.wasm' {
  const module: WebAssembly.Module;
  export default module;
}

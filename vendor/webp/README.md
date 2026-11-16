# libwebp encoder for browsers without WebP canvas export

Safari, and so every browser on iOS, cannot export a canvas as WebP: `toBlob('image/webp')`
quietly returns a PNG (WebKit bug 226950, closed WONTFIX). The avatars bucket stores WebP,
so the avatar editor loads this encoder in that case only and encodes in the browser. It
makes no network request besides fetching `webp_enc.wasm` next to it.

- Files: `codec/enc/webp_enc.js` and `codec/enc/webp_enc.wasm` from the npm package
  `@jsquash/webp` 1.5.0 (https://github.com/jamsinclair/jSquash), unmodified.
  The encoder is libwebp (https://github.com/webmproject/libwebp) compiled with Emscripten.
- Licenses: `LICENSE-jSquash` (Apache-2.0, the build and wrapper) and `LICENSE-libwebp.md`
  (BSD-3-Clause, libwebp).
- SHA-256:
  - `webp_enc.js`   5fd62301662e37785aec38e38807926f72933d4c8b919018a43faf1b1ca760f6
  - `webp_enc.wasm` b6085bb6702f144e9dc6016d58d230b34a84976bf0d080b7390b4b4b137d6ab7
- The Content-Security-Policy needs `'wasm-unsafe-eval'` in `script-src` to compile it.
  That allows WebAssembly only; JavaScript `eval` stays blocked.

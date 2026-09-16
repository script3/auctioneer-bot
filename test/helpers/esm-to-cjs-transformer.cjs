/* eslint-disable */
// Jest transformer that transpiles ESM-only node_modules sources (e.g.
// @noble/*, pulled in by @stellar/stellar-sdk) to CommonJS so the SDK's CJS
// build can require() them. ts-jest can't be used here: under the project's
// "node16" module setting it honors the packages' "type":"module" and keeps
// ESM output. A plain transpileModule to CommonJS avoids that.
const ts = require('typescript');
const crypto = require('crypto');

module.exports = {
  // Cache key so Jest can cache transform output across runs.
  getCacheKey(src, filename) {
    return crypto
      .createHash('md5')
      .update(src)
      .update(filename)
      .update('esm-to-cjs-v1')
      .digest('hex');
  },
  process(src, filename) {
    const { outputText } = ts.transpileModule(src, {
      fileName: filename,
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        moduleResolution: ts.ModuleResolutionKind.Node10,
        target: ts.ScriptTarget.ES2022,
        allowJs: true,
        esModuleInterop: true,
      },
    });
    return { code: outputText };
  },
};

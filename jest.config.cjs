/* eslint-disable */

// ESM-only packages pulled in (transitively) by @stellar/stellar-sdk / blend-sdk
// whose CJS builds require() them. Jest runs the SDKs' CJS builds, so these must
// be transpiled to CommonJS to be require()-able. Add new offenders here.
const esmOnlyDeps = ['@noble/.+', 'uint8array-extras'];
const esmOnlyPattern = `node_modules[/\\\\](?:${esmOnlyDeps.join('|')})[/\\\\].+\\.js$`;
// e.g. @noble  ->  @noble  (drop the trailing "/.+" for the ignore whitelist)
const esmOnlyScopes = esmOnlyDeps.map((d) => d.replace(/\/.*$/, '')).join('|');

/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['<rootDir>/test/**/*.test.ts'],
  transform: {
    // ESM-only deps -> CommonJS. Listed first so it wins over the ts-jest rule.
    [esmOnlyPattern]: '<rootDir>/test/helpers/esm-to-cjs-transformer.cjs',
    '\\.[jt]sx?$': ['ts-jest', { useESM: true }],
  },
  moduleNameMapper: {
    '^(\\.\\.?\\/.+)\\.js$': '$1',
  },
  extensionsToTreatAsEsm: ['.ts'],
  // Let the ESM-only deps through the default node_modules ignore so they get
  // transformed above.
  transformIgnorePatterns: [`/node_modules/(?!(?:${esmOnlyScopes})/)`],
  maxWorkers: 1,
};

module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: '.',
  testRegex: '(/test/.*|(\\.|/)(test|spec))\\.tsx?$',
  moduleFileExtensions: ['ts', 'js', 'json'],
  moduleNameMapper: {
    // A relative import carries its extension - the packages ship an ESM build
    // - and jest reads the TypeScript, which has none.
    '^(\.{1,2}/.*)\.js$': '$1', '^@softwarity/livewire-protocol$': '<rootDir>/../protocol/src/index.ts' },
  collectCoverageFrom: ['src/**/*.ts', '!src/index.ts'],
  coverageDirectory: 'coverage',
  testPathIgnorePatterns: ['/node_modules/', '/dist/'],
};

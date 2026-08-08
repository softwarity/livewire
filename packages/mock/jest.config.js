module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: '.',
  testRegex: '(/test/.*|(\\.|/)(test|spec))\\.tsx?$',
  moduleFileExtensions: ['ts', 'js', 'json'],
  // A relative import carries its extension, because Node's module resolver
  // wants one and the packages ship an ESM build. Jest reads the TypeScript, so
  // it is pointed back at the file without it.
  moduleNameMapper: { '^(\\.{1,2}/.*)\\.js$': '$1' },
  collectCoverageFrom: ['src/**/*.ts', '!src/index.ts'],
  testPathIgnorePatterns: ['/node_modules/', '/dist/'],
};

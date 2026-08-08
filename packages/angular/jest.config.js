module.exports = {
  preset: 'jest-preset-angular',
  testEnvironment: 'jsdom',
  rootDir: '.',
  setupFilesAfterEnv: ['<rootDir>/test/setup.ts'],
  testRegex: '(/test/.*|(\\.|/)(test|spec))\\.tsx?$',
  moduleFileExtensions: ['ts', 'js', 'json', 'mjs'],
  testPathIgnorePatterns: ['/node_modules/', '/dist/', '<rootDir>/test/setup.ts'],
  transformIgnorePatterns: ['node_modules/(?!.*\\.mjs$)'],
  globals: { 'ts-jest': { tsconfig: '<rootDir>/tsconfig.spec.json' } },
};

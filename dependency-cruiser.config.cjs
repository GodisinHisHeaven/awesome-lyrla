/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'no-circular-dependencies',
      severity: 'error',
      comment: 'Cycles make ownership and failure propagation ambiguous.',
      from: {},
      to: { circular: true },
    },
    {
      name: 'client-must-not-import-server',
      severity: 'error',
      comment: 'Server code and secrets must never enter the browser bundle.',
      from: { path: '^src/client' },
      to: { path: '^src/server' },
    },
    {
      name: 'server-must-not-import-client',
      severity: 'error',
      comment: 'The server cannot depend on browser implementation details.',
      from: { path: '^src/server' },
      to: { path: '^src/client' },
    },
    {
      name: 'shared-must-remain-independent',
      severity: 'error',
      comment: 'Shared contracts and pure policies cannot depend on either runtime.',
      from: { path: '^src/shared' },
      to: { path: '^src/(client|server)' },
    },
    {
      name: 'tests-must-not-be-production-dependencies',
      severity: 'error',
      comment: 'Runtime code must not import test fixtures or test-only helpers.',
      from: { path: '^src/(client|server|shared)', pathNot: '\\.test\\.[cm]?[jt]sx?$' },
      to: { path: '(^|/)(test|tests)/|\\.test\\.[cm]?[jt]sx?$' },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: '(^|/)(coverage|dist|dist-server|node_modules|reports)/' },
    tsConfig: { fileName: 'tsconfig.json' },
    enhancedResolveOptions: {
      conditionNames: ['import', 'node', 'default'],
      exportsFields: ['exports'],
    },
  },
};

// eslint-disable-next-line @typescript-eslint/no-var-requires
const path = require('node:path');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { getDefaultConfig } = require('expo/metro-config');

const projectRoot = __dirname;
const config = getDefaultConfig(projectRoot);

// `src/deviceProbe.ts` imports the scoring harness from a sibling directory so
// that the device run and the Node reference run are graded by identical code.
// Metro only watches the project root by default, so the sibling has to be
// declared explicitly or the import fails to resolve at bundle time.
const probeCore = path.resolve(projectRoot, '..', 'clip-probe-core');
config.watchFolders = [probeCore];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(probeCore, 'node_modules'),
];

module.exports = config;

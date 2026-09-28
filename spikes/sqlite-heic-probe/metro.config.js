// eslint-disable-next-line @typescript-eslint/no-var-requires
const path = require('node:path');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { getDefaultConfig } = require('expo/metro-config');

const projectRoot = __dirname;
const config = getDefaultConfig(projectRoot);

// `src/` imports the corpus, both index implementations, and the grading harness
// from a sibling directory so that the device run and the Node reference run are
// graded by identical code. Metro only watches the project root by default, so
// the sibling has to be declared explicitly or the import fails at bundle time.
const probeCore = path.resolve(projectRoot, '..', 'sqlite-heic-probe-core');
config.watchFolders = [probeCore];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(probeCore, 'node_modules'),
];

// `.heic` is not a default asset extension, so without this the bundled fixture
// resolves as a module and the require throws.
config.resolver.assetExts = [...config.resolver.assetExts, 'heic'];

module.exports = config;

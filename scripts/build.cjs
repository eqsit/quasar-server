const path = require('node:path')
const { buildSync } = require(require.resolve('esbuild', { paths: [path.dirname(require.resolve('tsx/package.json'))] }))
const pkg = require('../package.json')
buildSync({
  entryPoints: ['src/main.ts'], bundle: true, platform: 'node', target: 'node22',
  format: 'cjs', outfile: 'dist/main.cjs', sourcemap: true,
  external: Object.keys(pkg.dependencies).filter(name => name !== '@v3rt3p/types' && name !== 'quasar-server')
})

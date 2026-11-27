// electron-builder can reach its downloader on a cache miss even with
// ELECTRON_BUILDER_OFFLINE set. Fail before opening any HTTP connection.
function unavailable() {
  throw new Error('Release builds are offline. The required electron-builder tool is missing from the local cache.')
}

for (const protocol of ['node:http', 'node:https']) {
  const transport = require(protocol)
  transport.get = unavailable
  transport.request = unavailable
}
globalThis.fetch = unavailable
require('node:module').syncBuiltinESMExports()

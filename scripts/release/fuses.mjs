import { FuseV1Options, FuseVersion, getCurrentFuseWire } from '@electron/fuses'
import { FuseState } from '@electron/fuses/dist/constants.js'

const policy = {
  RunAsNode: false,
  EnableNodeOptionsEnvironmentVariable: false,
  EnableNodeCliInspectArguments: false,
  OnlyLoadAppFromAsar: true,
  EnableEmbeddedAsarIntegrityValidation: true,
}
const cookie = 'EnableCookieEncryption'

export function parseFuseWire(wire) {
  if (wire.version !== FuseVersion.V1) throw new Error(`Unexpected fuse wire version: ${wire.version}`)
  return Object.fromEntries([...Object.keys(policy), cookie].map((name) => {
    const state = wire[FuseV1Options[name]]
    if (state !== FuseState.ENABLE && state !== FuseState.DISABLE) {
      throw new Error(`Invalid fuse state for ${name}: ${state}`)
    }
    return [name, state === FuseState.ENABLE]
  }))
}

export function verifyFusePolicy(actual, defaults) {
  for (const [name, expected] of Object.entries({ ...policy, [cookie]: defaults[cookie] })) {
    if (actual[name] !== expected) {
      throw new Error(`Packaged fuse ${name}: expected ${expected}, got ${actual[name]}`)
    }
  }
}

export async function verifyPackagedFuses(packagedExe, stockExe) {
  const actual = parseFuseWire(await getCurrentFuseWire(packagedExe))
  verifyFusePolicy(actual, parseFuseWire(await getCurrentFuseWire(stockExe)))
  return actual
}

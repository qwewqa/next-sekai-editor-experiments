import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import type { MemoryStorage } from '../../src/local/journal/store'

// The support gate (`public/gate.js`) as the browser runs it, for tests: plain ES5 that runs before
// the bundle and reads the stored formats on its own.

const source = readFileSync('public/gate.js', 'utf8')

export type GateFile = { name: string; type: string; data: string | Uint8Array; label?: string }

export type Gate = {
    browserFamily: (win: object) => string
    PREFIX: string
    missingFeatures: (win: object) => string[]
    isWebKit: (win: object) => boolean
    message: (win: object) => string
    toRecoveryFile: (text: string) => GateFile
    recoveryFiles: (storage: MemoryStorage) => GateFile[]
    run: (win: object) => boolean
}

// The script as the browser runs it, with `module` defined so that it exports instead of running.
export const loadGate = (): Gate => {
    const context = { module: { exports: {} as unknown }, atob }
    vm.runInNewContext(source, context)
    const loaded = context.module.exports as Gate
    // Arrays made in the script's realm compare as foreign to deepEqual.
    return {
        ...loaded,
        missingFeatures: (win) => Array.from(loaded.missingFeatures(win)),
        recoveryFiles: (storage) => Array.from(loaded.recoveryFiles(storage)),
    }
}

export { source as gateSource }

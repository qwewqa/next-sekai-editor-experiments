import { platform as buildPlatform } from '#platform'
import { startDetection } from './detect'
import type { Platform, SaveRequest } from './types'

export { diskStateOfBytes, levelDataDiskState } from './fingerprint'
export * from './types'
export { appVersion, type AppVersion } from './version'

let beforeHandleWrite: ((handle: FileSystemFileHandle) => Promise<void>) | undefined

/**
 * Runs before every write to a file handle, wherever it comes from, before the write starts: a
 * write may commit even when it then fails. Only the web writes to handles, and only within
 * `SaveRequest.lock`.
 */
export const onBeforeHandleWrite = (run: (handle: FileSystemFileHandle) => Promise<void>) => {
    beforeHandleWrite = run
}

/**
 * A platform whose `saveFile` runs `beforeHandleWrite` just before a write to a handle, inside the
 * caller's lock: after the call the gesture's activation is for, and before anything is written.
 */
const guarded = (inner: Platform): Platform =>
    new Proxy(inner, {
        get: (target, key) =>
            key === 'saveFile'
                ? (request: SaveRequest) => {
                      const handle =
                          request.target?.kind === 'handle' ? request.target.handle : undefined
                      const before = beforeHandleWrite
                      if (!handle || !before) return target.saveFile(request)
                      const { lock } = request
                      return target.saveFile({
                          ...request,
                          lock: <T>(run: () => Promise<T>) => {
                              const write = async () => {
                                  await before(handle)
                                  return run()
                              }
                              return lock ? lock(write) : write()
                          },
                      })
                  }
                : (Reflect.get(target, key) as unknown),
    })

/** The platform this build runs on; tests swap it with setPlatformForTests. */
export let platform: Platform = guarded(buildPlatform)

/** Injects a platform, such as the mock; undefined restores the build's own. */
export const setPlatformForTests = (p: Platform | undefined) => {
    platform = guarded(p ?? buildPlatform)
}

// Latch the standalone flag at startup, before any fullscreen.
if (typeof window !== 'undefined') startDetection()

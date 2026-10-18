import { inspectNxsp } from '../../local/nxsp/inspect'
import { isObject } from '../../local/nxsp/json'
import type { DiskVersion } from './dialogs'

// What a `.nxsp` on disk is, read on the page from a `File` the check pinned (Part 0 §0.9.6): its
// `project.json` for the conflict dialog and the Replace guard, and its chronology's last entry for
// our own completed Save (§1.4.7).

export type DiskFacts = {
    projectJson?: unknown
    /** The last entry of the file's chronology, when it has history. */
    last?: Record<string, unknown>
    version: DiskVersion
}

const entriesOf = (part: unknown) =>
    isObject(part) && Array.isArray(part.entries) ? (part.entries as unknown[]) : []

/** Reads a `.nxsp`'s facts; a file that doesn't read is `unknown`. */
export const readDiskFacts = async (file: Blob, deviceId: string): Promise<DiskFacts> => {
    let projectJson: unknown
    let last: unknown
    try {
        const inspected = await inspectNxsp(file, {
            token: 'disk',
            role: 'target',
            fingerprint: '',
        })
        projectJson = inspected.projectJson
        if (inspected.manifest) {
            const parts = [...inspected.manifest.segments, inspected.manifest.manifest]
            for (const part of parts) last = entriesOf(part).at(-1) ?? last
        }
    } catch (error) {
        // A NotReadableError means the file changed again: the caller's check says so.
        if (error instanceof DOMException) throw error
        return { version: { kind: 'unknown' } }
    }
    const project = isObject(projectJson) ? projectJson : undefined
    const revision = isObject(project?.revision) ? project.revision : undefined
    const device = isObject(revision?.device) ? revision.device : undefined
    const savedAt = typeof revision?.savedAt === 'string' ? Date.parse(revision.savedAt) : NaN
    const summary = isObject(project?.summary) ? project.summary : undefined
    const notes = typeof summary?.noteCount === 'number' ? summary.noteCount : 0
    const version: DiskVersion =
        device && typeof device.id === 'string' && typeof device.label === 'string' && savedAt
            ? {
                  kind: 'saved',
                  device: { id: device.id, label: device.label },
                  thisDevice: device.id === deviceId,
                  savedAt,
                  notes,
              }
            : { kind: 'unknown' }
    return {
        projectJson,
        ...(isObject(last) ? { last } : {}),
        version,
    }
}

/** A file of another project: its `id` isn't the chain's (§0.9.5). */
export const otherProject = (facts: DiskFacts, docId: string): DiskVersion | undefined => {
    const project = isObject(facts.projectJson) ? facts.projectJson : undefined
    if (!project || project.id === docId) return
    const name = typeof project.name === 'string' && project.name ? project.name : undefined
    return name ? { kind: 'otherProject', name } : undefined
}

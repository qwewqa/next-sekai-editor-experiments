import { inspectNxsp } from '../../local/nxsp/inspect'
import { isObject } from '../../local/nxsp/json'
import { currentSummary, parseSavedAt, readProject } from '../../local/nxsp/project'
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
export const readDiskFacts = async (file: Blob): Promise<DiskFacts> => {
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
    // The reader's rules, not a looser copy: `savedAt` is RFC 3339 or absent, and `summary` counts
    // only when it was computed for this revision (Part 0 §0.9.10).
    const project =
        isObject(projectJson) && projectJson.format === 'nxsp'
            ? readProject(projectJson).project
            : undefined
    const revision = project?.revision
    const device = revision?.device
    const savedAt = parseSavedAt(revision?.savedAt)
    // Absent when the file has no summary for this revision: never taken as 0.
    const notes = project ? currentSummary(project)?.noteCount : undefined
    const version: DiskVersion =
        device && savedAt !== undefined
            ? {
                  kind: 'saved',
                  device: { id: device.id, label: device.label },
                  savedAt,
                  ...(notes === undefined ? {} : { notes }),
              }
            : { kind: 'unknown' }
    return {
        projectJson,
        ...(isObject(last) ? { last } : {}),
        version,
    }
}

/**
 * A file of another project: its `id` isn't the chain's (§0.9.5). It carries the project's name
 * when the file has one; a file whose `project.json` has no `id` is not told apart.
 */
export const otherProject = (facts: DiskFacts, docId: string): DiskVersion | undefined => {
    const project = isObject(facts.projectJson) ? facts.projectJson : undefined
    if (!project || typeof project.id !== 'string' || project.id === docId) return
    const name = typeof project.name === 'string' && project.name ? project.name : undefined
    return { kind: 'otherProject', ...(name ? { name } : {}) }
}

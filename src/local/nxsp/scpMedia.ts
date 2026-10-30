import { EngineArchetypeDataName, EngineArchetypeName, type LevelDataEntity } from '@sonolus/core'
import { deflate } from 'pako'
import { isNoteEntity } from '../../levelData/note'
import type { State } from '../../state'
import type { Integral } from '../../state/integrals'
import { beatToTime, calculateBpms } from '../../state/integrals/bpms'
import { crc32 } from '../../zip/crc32'
import { isObject } from './json'
import { PlanError } from './plan'

export const SCP_COVER = 'sonolus/cover.png'
export const SCP_BGM = 'sonolus/bgm.mp3'
export const SCP_MEDIA_PATHS = [SCP_COVER, SCP_BGM]

/** Only included bytes supply a package resource; metadata alone needs a fallback. */
export const scpMediaFiles = (project: Record<string, unknown>) => {
    const metadata = isObject(project.metadata) ? project.metadata : {}
    const file = (value: unknown) =>
        isObject(value) && typeof value.file === 'string' ? value.file : undefined
    return { cover: file(metadata.cover), bgm: file(project.bgm) }
}

/** The note clock follows BPM, independently of scrolling and stage events. */
export const scpSilenceSeconds = (level: unknown) => {
    if (!isObject(level) || !Array.isArray(level.entities))
        throw new PlanError('No level entities for the silent BGM')
    const bpms: { x: number; y: number; s: number }[] = []
    let last: number | undefined
    const number = (entity: LevelDataEntity, name: string) => {
        const field = entity.data.find((item) => item.name === name)
        if (!field || !('value' in field) || !Number.isFinite(field.value))
            throw new PlanError(`No finite ${name} for the silent BGM`)
        return field.value
    }
    for (const entity of level.entities as LevelDataEntity[]) {
        if (isNoteEntity(entity)) {
            const beat = number(entity, EngineArchetypeDataName.Beat)
            last = last === undefined ? beat : Math.max(last, beat)
        } else if (entity.archetype === EngineArchetypeName.BpmChange) {
            const bpm = number(entity, EngineArchetypeDataName.Bpm)
            if (bpm <= 0) throw new PlanError('Nonpositive BPM for the silent BGM')
            bpms.push({ x: number(entity, EngineArchetypeDataName.Beat), y: 0, s: 60 / bpm })
        }
    }
    return silenceSeconds(calculateBpms(bpms), last, level.bgmOffset)
}

const silenceSeconds = (clock: Integral[], last: number | undefined, offset: unknown) => {
    if (last === undefined) return 1
    const first = clock[0]
    if (!first) throw new PlanError('No BPM for the silent BGM')
    const time = last < first.x ? (last - first.x) * first.s : beatToTime(clock, last)
    if (typeof offset !== 'number' || !Number.isFinite(offset))
        throw new PlanError('No finite offset for the silent BGM')
    return Math.max(1, Math.ceil(time + offset + 1))
}

/** Uses the same note clock for a live or decoded head without serializing its level. */
export const scpSilenceSecondsFromState = (state: State) => {
    let last: number | undefined
    for (const slide of state.store.slides.info.values())
        for (const { note } of slide)
            last = last === undefined ? note.beat : Math.max(last, note.beat)
    return silenceSeconds(state.bpms, last, state.bgm.offset)
}

/** MPEG-1 Layer III mono, 32 kbps at 32 kHz: 144 bytes and 1,152 samples per frame. */
export const scpSilentMp3Size = (seconds: number, cap: number) => {
    const frames = Math.ceil((seconds * 32000) / 1152)
    const size = frames * 144
    if (!Number.isSafeInteger(size) || size < 144 || size > cap)
        throw new PlanError('The silent BGM is over its cap', 'bgm')
    return size
}

export const scpSilentMp3 = (seconds: number, cap: number) => {
    const size = scpSilentMp3Size(seconds, cap)
    const bytes = new Uint8Array(size)
    for (let at = 0; at < size; at += 144) {
        bytes.set([0xff, 0xfb, 0x18, 0xc0], at)
        // Zero side information uses no reservoir, scalefactors or Huffman values.
    }
    return bytes
}

/** One opaque RGB pixel, with PNG chunk CRCs. */
export const scpBlackPng = () => {
    const chunk = (type: string, data: Uint8Array) => {
        const bytes = new Uint8Array(12 + data.length)
        const view = new DataView(bytes.buffer)
        view.setUint32(0, data.length)
        bytes.set(new TextEncoder().encode(type), 4)
        bytes.set(data, 8)
        view.setUint32(8 + data.length, crc32(bytes.subarray(4, 8 + data.length)))
        return bytes
    }
    const parts = [
        new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
        chunk('IHDR', new Uint8Array([0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0])),
        chunk('IDAT', deflate(new Uint8Array(4))),
        chunk('IEND', new Uint8Array()),
    ]
    const bytes = new Uint8Array(parts.reduce((size, part) => size + part.length, 0))
    let at = 0
    for (const part of parts) {
        bytes.set(part, at)
        at += part.length
    }
    return bytes
}

export const scpFallbackMedia = (project: Record<string, unknown>, level: unknown, cap: number) => {
    const media = scpMediaFiles(project)
    const entries = new Map<string, Uint8Array>()
    if (media.cover === undefined) entries.set(SCP_COVER, scpBlackPng())
    if (media.bgm === undefined) entries.set(SCP_BGM, scpSilentMp3(scpSilenceSeconds(level), cap))
    return entries
}

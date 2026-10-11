import type { LevelDataEntity } from '@sonolus/core'
import { computed, markRaw, ref } from 'vue'
import type { Chart } from '../chart'
import type { NoteObject } from '../chart/note'
import { parseLevelDataChart } from '../chart/parse/levelData'
import { parseClipboardData } from './data/parse'
import type { ClipboardData } from './data/schema'

type ClipboardEntry = {
    name: string
    text: string
    data?: {
        lane: number
        beat: number
        chart: Chart
        source?: ClipboardData['source']
        /** Anchor index in the parsed, flattened note list. */
        anchor?: number
    }
}

export const clipboardEntries = ref<ClipboardEntry[]>([])

export const clipboardEntry = computed(() => clipboardEntries.value[0])

// The read running now; another caller waits for it instead of starting its own.
let reading: Promise<void> | undefined

const readClipboard = async () => {
    try {
        const text = await navigator.clipboard.readText()
        if (!text) return

        updateClipboardEntries(text)
    } catch {
        return
    }
}

// Waiting on a read stops after this long; its text still lands when it arrives.
const readWait = 15000

const waitForRead = async (read: Promise<void>) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
        await Promise.race([
            read,
            new Promise((resolve) => (timer = setTimeout(resolve, readWait))),
        ])
    } finally {
        clearTimeout(timer)
    }
}

/** Waits on the read running now, if any, without starting one. */
export const joinClipboardRead = () => (reading ? waitForRead(reading) : undefined)

export const updateClipboard = () => {
    if (!reading) {
        const read = readClipboard()
        reading = read
        void read.finally(() => {
            if (reading === read) reading = undefined
        })
    }
    return waitForRead(reading)
}

export const setClipboardData = (data: ClipboardData) => {
    const text = JSON.stringify(data)
    updateClipboardEntries(text)

    void writeClipboardText(text)
}

export const setClipboardEntry = (entry: ClipboardEntry) => {
    clipboardEntries.value.splice(clipboardEntries.value.indexOf(entry), 1)
    clipboardEntries.value.unshift(markRaw(entry))

    void writeClipboardText(entry.text)
}

const writeClipboardText = async (text: string) => {
    try {
        await navigator.clipboard.writeText(text)
    } catch {
        return
    }
}

const updateClipboardEntries = (text: string) => {
    const entry = clipboardEntries.value.find((entry) => entry.text === text)
    if (entry) {
        clipboardEntries.value.splice(clipboardEntries.value.indexOf(entry), 1)
        clipboardEntries.value.unshift(markRaw(entry))
        return
    }

    clipboardEntries.value.unshift(markRaw(getClipboardEntry(text)))
    if (clipboardEntries.value.length > 10) clipboardEntries.value.pop()
}

let i = 0

const getClipboardEntry = (text: string): ClipboardEntry => {
    try {
        const data = parseClipboardData(JSON.parse(text))
        const anchorEntity = data.anchor === undefined ? undefined : data.entities[data.anchor]
        const noteSources = anchorEntity ? new Map<NoteObject, LevelDataEntity>() : undefined
        const chart = parseLevelDataChart(data.entities, data.defaultGuideColors, noteSources)
        const anchor = noteSources
            ? chart.slides.flat().findIndex((note) => noteSources.get(note) === anchorEntity)
            : -1

        return {
            name: `#${++i} (${
                chart.cameraEvents.length +
                chart.stageMaskEvents.length +
                chart.stagePivotEvents.length +
                chart.stageStyleEvents.length +
                chart.stageTransformEvents.length +
                chart.timeScales.length +
                chart.slides.reduce((sum, slide) => sum + slide.length, 0)
            })`,
            text,
            data: {
                lane: data.lane,
                beat: data.beat,
                chart,
                source: data.source,
                anchor: anchor >= 0 ? anchor : undefined,
            },
        }
    } catch {
        return {
            name: `${Math.random()}`,
            text,
        }
    }
}

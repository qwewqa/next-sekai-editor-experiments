<script lang="ts">
// The link is kept for the tab while the editor is open, never stored.
let keptLink = ''
</script>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, useId, useTemplateRef } from 'vue'
import { i18n } from '../../i18n'
import {
    ROWS,
    type Category,
    type ChartMode,
    type ChartStatistics,
    type Row,
} from '../../levelData/statistics'
import { readMediaBlob } from '../../local/mediaBlob'
import BaseModal from '../../modals/BaseModal.vue'
import NoteShapeIcon from '../../modals/form/NoteShapeIcon.vue'
import { FileError, platform } from '../../platform'
import { PRODUCT_NAME } from '../../product'
import type { LevelInfo } from '../../state/levelInfo'
import { fileErrorText } from '../commands/exportLevel/ui'
import { notify } from '../notification'
import SeverityIcon from '../SeverityIcon.vue'
import { isCoarsePointer } from '../workspace'
import { rowShapes } from './marks'
import { drawCard, type CardTheme, type Rgb } from './shareCard'
import { settings } from '../../settings'
import { statisticsStrings } from './text'

// Share Image: the card as a PNG for a Link value, previewed as the PNG itself, then copied,
// shared or downloaded. A press takes the card for Link as it is at that moment. The card is drawn
// from the statistics and Level Info as they were when the dialog opened.

const props = defineProps<{
    stats: ChartStatistics
    every: Float64Array
    bgmEnd: number | undefined
    drawable: boolean
    chosen: readonly Category[]
    mode: ChartMode
    /** Level Info when the dialog opened, read with the statistics. */
    levelInfo: LevelInfo
    /** The preview's alt text: the Copy Text summary. */
    summary: string
}>()

const emit = defineEmits<{
    close: []
}>()

const formId = useId()
const link = ref(keptLink)
// A failed download keeps the file error the status line names.
const failure = shallowRef<'copy' | 'share' | { name: string; error: FileError }>()
const failureText = () => {
    const shown = failure.value
    if (!shown) return ''
    if (typeof shown === 'object') return fileErrorText(shown.name, shown.error)
    return shown === 'copy'
        ? i18n.value.statistics.notCopiedImage
        : i18n.value.statistics.notSharedImage
}

// Share on a phone or tablet that shares files; elsewhere Copy Image where the clipboard takes
// images. Download Image is always there. Insecure origins have no clipboard object.
const probeFile = new File([new Uint8Array()], 'card.png', { type: 'image/png' })
const canShare =
    isCoarsePointer.value &&
    typeof navigator.share === 'function' &&
    typeof navigator.canShare === 'function' &&
    navigator.canShare({ files: [probeFile] })
const clipboard = navigator.clipboard as Clipboard | undefined
const canCopy = typeof ClipboardItem === 'function' && typeof clipboard?.write === 'function'
const primary = canShare ? 'share' : canCopy ? 'copy' : 'download'

const fileName = computed(
    () => `${props.levelInfo.title.trim() || i18n.value.save.placeholder}.png`,
)

// --- The glyphs: the dialog's own SVG, drawn as images.
// Fake Note is not on the card.
const cardRows = ROWS.filter((row) => row !== 'fakeNote')
const glyphHost = useTemplateRef<HTMLDivElement>('glyphHost')
const loadGlyphs = () =>
    Promise.all(
        cardRows.map(
            (row) =>
                new Promise<[Row, HTMLImageElement | undefined]>((resolve) => {
                    const svg = glyphHost.value?.querySelector(`[data-glyph="${row}"] svg`)
                    if (!svg) {
                        resolve([row, undefined])
                        return
                    }
                    const copy = svg.cloneNode(true) as SVGElement
                    copy.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
                    copy.setAttribute('width', '96')
                    copy.setAttribute('height', '96')
                    // The glyphs that take the text colour draw in the card's ink.
                    copy.style.color = getComputedStyle(svg).color
                    const image = new Image()
                    image.onload = () => {
                        resolve([row, image])
                    }
                    image.onerror = () => {
                        resolve([row, undefined])
                    }
                    image.src = `data:image/svg+xml,${encodeURIComponent(new XMLSerializer().serializeToString(copy))}`
                }),
        ),
    ).then((entries) => Object.fromEntries(entries) as Partial<Record<Row, HTMLImageElement>>)

// --- The cover, decoded from its stored bytes; none when it is absent or does not decode.
const loadCover = async () => {
    const ref = props.levelInfo.cover
    if (!ref) return undefined
    try {
        const result = await readMediaBlob(ref)
        return result.kind === 'blob' ? await createImageBitmap(result.blob) : undefined
    } catch {
        return undefined
    }
}

const themeOf = (): CardTheme => {
    const style = getComputedStyle(document.documentElement)
    const color = (name: string): Rgb => {
        const [r = 0, g = 0, b = 0] = style.getPropertyValue(name).trim().split(/\s+/).map(Number)
        return [r, g, b]
    }
    const modal = color('--color-modal')
    return {
        modal,
        recess: style.getPropertyValue('--color-recess').trim(),
        header: color('--color-header'),
        fg: color('--color-fg'),
        dark: modal[0] + modal[1] + modal[2] < 3 * 128,
    }
}

let assets: Promise<{
    glyphs: Partial<Record<Row, HTMLImageElement>>
    cover?: ImageBitmap
}>

// --- One PNG per Link value: the current value's render, started when none is running or done.
type Card = { link: string; promise: Promise<Blob>; blob?: Blob }
let card: Card | undefined
const previewUrl = ref<string>()
const render = (value: string) =>
    assets.then(
        ({ glyphs, cover }) =>
            new Promise<Blob>((resolve, reject) => {
                const canvas = document.createElement('canvas')
                const levelInfo = props.levelInfo
                drawCard(canvas, {
                    info: {
                        title: levelInfo.title,
                        artists: levelInfo.artists,
                        author: levelInfo.author,
                        rating: levelInfo.rating,
                    },
                    cover,
                    link: value,
                    stats: props.stats,
                    every: props.every,
                    bgmEnd: props.bgmEnd,
                    drawable: props.drawable,
                    chosen: props.chosen,
                    mode: props.mode,
                    glyphs,
                    theme: themeOf(),
                    fontFamily: getComputedStyle(document.body).fontFamily,
                    locale: settings.locale,
                    strings: {
                        ...statisticsStrings.value,
                        untitled: i18n.value.save.placeholder,
                        author: i18n.value.historyChanges.fields.author,
                        rating: i18n.value.historyChanges.fields.rating,
                        product: PRODUCT_NAME,
                    },
                })
                canvas.toBlob((blob) => {
                    if (blob) resolve(blob)
                    else reject(new Error('The card did not encode'))
                }, 'image/png')
            }),
    )
let open = true
const cardFor = (): Card => {
    const value = link.value.trim()
    if (card?.link === value) return card
    const next: Card = { link: value, promise: render(value) }
    card = next
    void next.promise.then(
        (blob) => {
            next.blob = blob
            // A render that finishes after a newer one started, or after the dialog closed, shows nothing.
            if (card !== next || !open) return
            if (previewUrl.value) URL.revokeObjectURL(previewUrl.value)
            previewUrl.value = URL.createObjectURL(blob)
        },
        () => {
            // A failed render is not kept: the next press renders again.
            if (card === next) card = undefined
        },
    )
    return next
}

let timer: ReturnType<typeof setTimeout> | undefined
const onInput = () => {
    keptLink = link.value
    clearTimeout(timer)
    timer = setTimeout(cardFor, 150)
}

// --- The actions, each in its press or Enter handler.
const copy = () => {
    failure.value = undefined
    // No await before the write: Safari takes it only within the gesture, with a promise-valued item.
    navigator.clipboard.write([new ClipboardItem({ 'image/png': cardFor().promise })]).then(
        () => notify(() => i18n.value.statistics.copiedImage),
        () => {
            if (open) failure.value = 'copy'
        },
    )
}
// Share: the file goes in the call itself. A ready card is shared at once; otherwise the press waits
// for the render in flight, tens of milliseconds, well within the press's activation. One share at
// a time: a second call before the first settles would reject.
let sharing = false
const share = async () => {
    if (sharing) return
    sharing = true
    failure.value = undefined
    try {
        const current = cardFor()
        const blob = current.blob ?? (await current.promise)
        // A dialog closed while the card rendered shares nothing.
        if (!open) return
        // The card alone: the link is on it, and iOS leaves Save Image off a sheet that has text.
        await navigator.share({ files: [new File([blob], fileName.value, { type: 'image/png' })] })
    } catch (error) {
        // Dismissing the share sheet is no failure; nothing shows once the dialog has closed.
        if (open && !(error instanceof DOMException && error.name === 'AbortError'))
            failure.value = 'share'
    } finally {
        sharing = false
    }
}
const download = async () => {
    failure.value = undefined
    const name = fileName.value
    const promise = cardFor().promise
    // A render that fails is a failed build, which the file error card names.
    const build = () =>
        promise.catch((error: unknown) => {
            throw new FileError('io', String(error), undefined, 'build')
        })
    try {
        await platform.saveFile({ kind: 'image', suggestedName: name, build })
    } catch (error) {
        if (!(error instanceof FileError)) throw error
        if (open) failure.value = { name, error }
    }
}
const submit = () => {
    if (primary === 'share') void share()
    else if (primary === 'copy') copy()
    else void download()
}
// A held Enter or Space repeats keydown; only the first press acts, in Link and on the buttons.
const onKeydown = (event: KeyboardEvent) => {
    if ((event.key === 'Enter' || event.key === ' ') && event.repeat) event.preventDefault()
}

let dialog: HTMLDialogElement | null | undefined
onMounted(() => {
    dialog = glyphHost.value?.closest('dialog')
    dialog?.addEventListener('keydown', onKeydown, true)
    assets = Promise.all([loadGlyphs(), loadCover()]).then(([glyphs, cover]) => ({
        glyphs,
        cover,
    }))
    cardFor()
})
onBeforeUnmount(() => {
    dialog?.removeEventListener('keydown', onKeydown, true)
    clearTimeout(timer)
    open = false
    card = undefined
    if (previewUrl.value) URL.revokeObjectURL(previewUrl.value)
})

const buttonClass = 'btn h-9 min-w-24 max-w-full truncate rounded-full px-4'
</script>

<template>
    <BaseModal :title="i18n.statistics.shareImageTitle" @close="emit('close')">
        <img
            v-if="previewUrl"
            :src="previewUrl"
            :alt="summary"
            class="block aspect-video h-auto w-full rounded-xl shadow-[0_0_0_1px_rgb(var(--color-fg)/0.15)]"
            data-share-preview
        />
        <div v-else class="aspect-video w-full rounded-xl bg-fg/5" />
        <form :id="formId" class="flex items-center gap-4" @submit.prevent="submit">
            <label :for="`${formId}-link`" class="shrink-0">{{ i18n.statistics.link }}</label>
            <input
                :id="`${formId}-link`"
                v-model="link"
                class="field w-full min-w-0 appearance-none rounded-full px-4 py-1"
                type="text"
                maxlength="120"
                spellcheck="false"
                autocomplete="off"
                data-share-link
                @input="onInput"
            />
        </form>
        <p class="flex items-start gap-2 text-sm empty:hidden" role="status">
            <template v-if="failure">
                <SeverityIcon severity="error" class="mt-0.5 size-4 shrink-0" />
                <span data-share-failure>{{ failureText() }}</span>
            </template>
        </p>
        <div ref="glyphHost" class="hidden" aria-hidden="true">
            <span v-for="row in cardRows" :key="row" :data-glyph="row">
                <NoteShapeIcon :shape="rowShapes[row]" />
            </span>
        </div>
        <template #footer>
            <button
                v-if="primary !== 'download'"
                type="button"
                :class="[buttonClass, 'btn-secondary']"
                data-share-download
                @click="download"
            >
                {{ i18n.statistics.downloadImage }}
            </button>
            <button
                type="submit"
                :form="formId"
                :class="[buttonClass, 'btn-primary']"
                data-autofocus
                :data-share-primary="primary"
            >
                {{
                    primary === 'share'
                        ? i18n.statistics.share
                        : primary === 'copy'
                          ? i18n.statistics.copyImage
                          : i18n.statistics.downloadImage
                }}
            </button>
        </template>
    </BaseModal>
</template>

<script setup lang="ts">
import { computed, nextTick, useTemplateRef } from 'vue'
import { AUDIO_BITRATES, RESOLUTIONS, type Quality } from '../../exportVideo/estimate'
import { i18n } from '../../i18n'
import { formatList } from '../../levelData/statistics'
import ChoiceField from '../../modals/form/ChoiceField.vue'
import NumberField from '../../modals/form/NumberField.vue'
import SelectField from '../../modals/form/SelectField.vue'
import ToggleField from '../../modals/form/ToggleField.vue'
import { previewAspectRatios, previewNoteSpeed } from '../../preview/options'
import { settings } from '../../settings'
import { interpolateRaw } from '../../utils/interpolate'
import ChevronIcon from '../workspace/ChevronIcon.vue'
import type { ExportDialog, Unavailable } from './dialog'

// The settings column: Main, then Advanced folded away (design: Export Video, settings model).
const props = defineProps<{ dialog: ExportDialog }>()
const d = props.dialog
const form = d.form
const busy = d.busy
const strings = computed(() => i18n.value.exportVideo)
const root = useTemplateRef<HTMLDivElement>('root')

const fps = (value: number) => interpolateRaw(strings.value.fps, `${value}`)
const resolutionOptions = RESOLUTIONS.map((value) => [`${value}p`, value] as const)
const frameRateOptions = computed(() => [[fps(30), 30] as const, [fps(60), 60] as const])
const qualityOptions = computed(() => {
    const names = strings.value.qualities
    const options: (readonly [string, Quality | 'custom'])[] = [
        [names.low, 'low'],
        [names.standard, 'standard'],
        [names.high, 'high'],
    ]
    if (form.quality === 'custom') options.push([names.custom, 'custom'])
    return options
})
const formatOptions = computed((): (readonly [string, 'automatic' | 'mp4' | 'webm'])[] => [
    [strings.value.formats.automatic, 'automatic'],
    ['MP4', 'mp4'],
    ['WebM', 'webm'],
])
const scaleOptions: (readonly [string, 1 | 1.5 | 2])[] = [
    ['1x', 1],
    ['1.5x', 1.5],
    ['2x', 2],
]
const audioOptions = computed(() =>
    AUDIO_BITRATES.map(
        (value) => [interpolateRaw(strings.value.kbps, `${value / 1000}`), value] as const,
    ),
)

// --- Choices this browser or device cannot make, and why.
const off = <T,>(prefix: string, options: readonly (readonly [string, T])[]) => {
    const reasons = new Map<Unavailable, string[]>()
    const values: T[] = []
    for (const [name, value] of options) {
        const reason = d.unavailable.value[`${prefix}:${String(value)}`]
        if (!reason) continue
        values.push(value)
        reasons.set(reason, [...(reasons.get(reason) ?? []), name])
    }
    const notes = [...reasons].map(([reason, names]) =>
        interpolateRaw(
            reason === 'browser' ? strings.value.notInBrowser : strings.value.tooLarge,
            formatList(names, settings.locale),
        ),
    )
    return { values, notes }
}
const resolutionOff = computed(() => off('resolution', resolutionOptions))
const frameRateOff = computed(() => off('frameRate', frameRateOptions.value))
const formatOff = computed(() => off('format', formatOptions.value))
const scaleOff = computed(() => off('renderScale', scaleOptions))
const audioOff = computed(() => off('audioBitrate', audioOptions.value))

const bgmNotes = computed(() =>
    d.input.bgmMissing === 'notLoaded'
        ? [i18n.value.save.bgmNotLoaded]
        : d.input.bgmMissing
          ? [strings.value.noBgm]
          : [],
)

const bitrateValue = computed({
    get: () => Math.round(d.videoBitrate.value / 1e5) / 10,
    set: (value: number) => {
        d.setBitrate(value)
    },
})


// --- Advanced: opening it scrolls it to the top of its scroller, so its first fields show.
const advanced = computed(() => settings.exportVideoAdvanced)
const toggleAdvanced = async () => {
    settings.exportVideoAdvanced = !settings.exportVideoAdvanced
    if (!settings.exportVideoAdvanced) return
    d.used.advanced = true
    await nextTick()
    const disclosure = root.value?.querySelector<HTMLElement>('[data-export-advanced]')
    const scroller = disclosure?.closest<HTMLElement>('[data-export-scroller]')
    if (!disclosure || !scroller) return
    const offset = disclosure.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 8
    scroller.scrollBy({
        top: offset,
        behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth',
    })
}

const formatDescription = computed(() => ({
    intro: strings.value.formatDescription.intro,
    choices: strings.value.formatDescription.choices,
}))
</script>

<template>
    <div ref="root" class="export-settings-grid p-4" data-export-settings>
        <ChoiceField
            v-model="form.aspect"
            :label="i18n.settings.preview.aspectRatio"
            :options="previewAspectRatios"
            :disabled="busy"
        />
        <SelectField
            v-model="form.resolution"
            :label="strings.resolution"
            :options="resolutionOptions"
            :disabled="busy"
            :disabled-values="resolutionOff.values"
            :notes="resolutionOff.notes"
        />
        <ChoiceField
            v-model="form.frameRate"
            :label="strings.frameRate"
            :options="frameRateOptions"
            :disabled="busy"
            :disabled-values="frameRateOff.values"
            :notes="frameRateOff.notes"
        />
        <SelectField
            v-model="form.quality"
            :label="strings.quality"
            :options="qualityOptions"
            :description="strings.qualityDescription"
            :disabled="busy"
        />
        <ToggleField
            v-model="form.bgm"
            :label="i18n.save.bgm"
            :disabled="busy || !!d.input.bgmMissing"
            :notes="bgmNotes"
        />
        <ToggleField v-model="form.sfx" :label="i18n.modals.form.sfx.label" :disabled="busy" />
        <div class="export-span -mx-2 mt-1 border-t border-fg/15 pt-2">
            <button
                type="button"
                class="export-hit-tall ghost relative flex min-h-9 w-full items-center gap-2 rounded-lg px-2 text-left font-bold"
                :aria-expanded="advanced"
                data-export-advanced
                @click="toggleAdvanced"
            >
                <ChevronIcon :direction="advanced ? 'down' : 'right'" />
                <span>{{ strings.advanced }}</span>
            </button>
        </div>
        <template v-if="advanced">
            <h3 class="export-span mt-1 text-sm font-bold">{{ strings.video }}</h3>
            <SelectField
                v-model="form.format"
                :label="strings.format"
                :options="formatOptions"
                :description="formatDescription"
                :disabled="busy"
                :disabled-values="formatOff.values"
                :notes="formatOff.notes"
            />
            <NumberField
                v-model="bitrateValue"
                :label="strings.videoBitrate"
                :min="1"
                :max="100"
                :step="0.5"
                :disabled="busy"
            />
            <ToggleField
                v-model="form.antialias"
                :label="i18n.settings.preview.antialias"
                :description="i18n.settings.descriptions.previewAntialias"
                :disabled="busy"
            />
            <ChoiceField
                v-model="form.renderScale"
                :label="i18n.settings.preview.renderScale"
                :options="scaleOptions"
                :description="strings.renderScaleDescription"
                :disabled="busy"
                :disabled-values="scaleOff.values"
                :notes="scaleOff.notes"
            />
            <h3 class="export-span mt-1 text-sm font-bold">{{ strings.picture }}</h3>
            <NumberField
                v-model="form.noteSpeed"
                :label="i18n.settings.preview.noteSpeed"
                :min="previewNoteSpeed.min"
                :max="previewNoteSpeed.max"
                :step="previewNoteSpeed.step"
                :disabled="busy"
            />
            <ToggleField
                v-model="form.showEffects"
                :label="i18n.settings.preview.showEffects"
                :disabled="busy"
            />
            <ToggleField
                v-model="form.showCombo"
                :label="i18n.settings.preview.showCombo"
                :disabled="busy"
            />
            <NumberField
                v-model="form.fadeIn"
                :label="strings.fadeIn"
                :min="0"
                :max="d.fadeLimits.value.fadeIn"
                :step="0.1"
                :disabled="busy"
            />
            <NumberField
                v-model="form.fadeOut"
                :label="strings.fadeOut"
                :min="0"
                :max="d.fadeLimits.value.fadeOut"
                :step="0.1"
                :disabled="busy"
            />
            <h3 class="export-span mt-1 text-sm font-bold">{{ strings.sound }}</h3>
            <NumberField
                v-model="form.bgmVolume"
                :label="i18n.settings.play.bgmVolume"
                :min="0"
                :max="100"
                :step="1"
                :disabled="busy || !form.bgm"
            />
            <NumberField
                v-model="form.sfxVolume"
                :label="i18n.settings.play.sfxVolume"
                :min="0"
                :max="100"
                :step="1"
                :disabled="busy || !form.sfx"
            />
            <SelectField
                v-model="form.audioBitrate"
                :label="strings.audioBitrate"
                :options="audioOptions"
                :disabled="busy || !d.hasAudio.value"
                :disabled-values="audioOff.values"
                :notes="audioOff.notes"
            />
            <div class="export-span pt-1">
                <button
                    type="button"
                    class="export-hit btn btn-secondary relative h-9 max-w-full truncate rounded-full px-4"
                    :disabled="busy"
                    data-export-restore
                    @click="d.restoreDefaults"
                >
                    {{ strings.restoreDefaults }}
                </button>
            </div>
        </template>
    </div>
</template>

<style scoped>
.export-settings-grid {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    column-gap: 2rem;
    row-gap: 0.75rem;
}

@container export-settings (min-width: 40rem) {
    .export-settings-grid {
        grid-template-columns: repeat(2, minmax(0, 1fr));
    }
}

.export-span {
    grid-column: 1 / -1;
}

.export-hit::before {
    content: '';
    position: absolute;
    inset: -0.25rem;
}

.export-hit-tall::before {
    content: '';
    position: absolute;
    inset: -0.375rem -0.25rem;
}
</style>

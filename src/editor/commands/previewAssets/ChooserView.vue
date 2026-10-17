<script setup lang="ts">
import { computed, nextTick, onMounted, useId, useTemplateRef, watch } from 'vue'
import { i18n } from '../../../i18n'
import type { AssetType } from '../../../preview/assets'
import { typeNoun } from '../../../preview/assets/fallbackText'
import type { AssetChooser } from '../../../preview/assets/files/chooser'
import { interpolateRaw } from '../../../utils/interpolate'
import { pickFile } from '../../../utils/file'
import AssetGlyph from './AssetGlyph.vue'
import AssetRow from './AssetRow.vue'

// The chooser, in the tab in place of the source list (Part 2, 2.6): From a File only until a
// server can be chosen from, so there is no switch between the two yet. Reading the file and its
// errors show under Select File…; storing and a failed Use show next to Use, which stays in view
// at the bottom of the tab while the dialog's own footer is inactive.
const props = defineProps<{
    type: AssetType
    chooser: AssetChooser
}>()

const strings = computed(() => i18n.value.commands.previewAssets)
const groupName = useId()
const errorId = useId()

const titles = computed(
    () =>
        ({
            skin: strings.value.chooseSkin,
            particle: strings.value.chooseParticle,
            background: strings.value.chooseBackground,
            effect: strings.value.chooseEffect,
        })[props.type],
)

const { phase, items, selected, also, error, useError, fileName, thumbnails } = props.chooser
const isListed = computed(() => phase.value === 'listed' || phase.value === 'working')

const selectFile = async () => {
    const file = await pickFile()
    if (file) await props.chooser.pick(file, file.name)
}

const selectButton = useTemplateRef<HTMLButtonElement>('selectButton')
const useButton = useTemplateRef<HTMLButtonElement>('useButton')
const list = useTemplateRef<HTMLElement>('list')

onMounted(() => {
    // A chooser opened with a file already picked lands on its list; otherwise on the file button.
    if (phase.value === 'idle') selectButton.value?.focus({ focusVisible: false })
})

// After the items are listed, focus goes where the next key is useful: Use for a lone item,
// the list for several, so arrows work at once.
watch(phase, async (now, before) => {
    if (before !== 'reading' || now !== 'listed') return
    await nextTick()
    if (selected.value !== undefined) useButton.value?.focus({ focusVisible: false })
    else list.value?.querySelector<HTMLElement>('input')?.focus({ focusVisible: false })
})

const alsoText = (option: (typeof also.value)[number]) =>
    interpolateRaw(strings.value.alsoFile, typeNoun(option.type), option.title)

const baseClass =
    'h-9 min-w-24 max-w-full truncate rounded-full px-4 shadow-md outline-none -outline-offset-2 transition-colors hover:shadow-accent focus-visible:ring-2 focus-visible:ring-fg disabled:pointer-events-none disabled:opacity-40 [@media(pointer:coarse)]:h-11'
const buttonClass = `${baseClass} bg-button active:bg-accent active:text-on-accent`
const primaryClass = `${baseClass} bg-accent text-on-accent active:bg-button active:text-fg`
</script>

<template>
    <section
        class="flex flex-col gap-3 px-1 pb-1"
        role="group"
        :aria-label="titles"
        data-asset-chooser
    >
        <h3 class="px-2 pt-1 text-base font-bold" data-chooser-title>{{ titles }}</h3>

        <div class="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 px-2">
            <button
                ref="selectButton"
                type="button"
                :class="buttonClass"
                :disabled="phase === 'working'"
                data-chooser-select-file
                @click="selectFile"
            >
                {{ i18n.modals.form.file.select }}
            </button>
            <span
                v-if="fileName"
                class="min-w-0 truncate opacity-75"
                :title="fileName"
                data-chooser-file-name
                >{{ fileName }}</span
            >
        </div>

        <div v-if="phase === 'reading'" class="px-2" role="status" data-chooser-progress>
            <p class="text-sm">{{ strings.progress.reading }}</p>
            <div
                class="chooser-bar mt-1 h-1 overflow-hidden rounded-full bg-fg/20"
                aria-hidden="true"
            >
                <div class="chooser-bar-fill h-full w-1/3 rounded-full bg-fg" />
            </div>
        </div>

        <p v-if="error" class="relative pl-8 pr-2 text-sm" aria-live="polite" data-chooser-error>
            <AssetGlyph type="warning" class="absolute left-2 top-[0.1875rem]" />{{ error }}
        </p>

        <template v-if="isListed">
            <div
                v-if="items.length"
                ref="list"
                class="flex flex-col rounded-xl"
                role="radiogroup"
                :aria-label="titles"
                data-chooser-list
            >
                <AssetRow
                    v-for="item in items"
                    :key="item.name"
                    :type="type"
                    :name="item.title"
                    :detail="item.author"
                    :image="thumbnails.get(item.name)"
                    :checked="item.name === selected"
                    :group="groupName"
                    :disabled="phase === 'working'"
                    :data-chooser-item="item.name"
                    @select="chooser.select(item.name)"
                />
            </div>
            <p v-else class="px-2 opacity-75" data-chooser-empty>
                {{ interpolateRaw(strings.noneInFile, typeNoun(type)) }}
            </p>

            <div v-if="also.length" class="flex flex-col" data-chooser-also>
                <label
                    v-for="option in also"
                    :key="option.type"
                    class="relative flex min-h-10 cursor-pointer items-center gap-3 rounded-xl px-3 py-1 transition-colors has-[:active]:bg-accent has-[:active]:text-on-accent has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-fg [@media(hover:hover)]:hover:bg-band-hover [@media(pointer:coarse)]:min-h-12"
                >
                    <input
                        type="checkbox"
                        class="peer absolute inset-0 size-full cursor-pointer opacity-0 focus-visible:outline-none"
                        :checked="option.ticked"
                        :disabled="phase === 'working'"
                        :data-chooser-also-type="option.type"
                        @change="
                            chooser.toggle(option.type, ($event.target as HTMLInputElement).checked)
                        "
                    />
                    <span
                        class="pointer-events-none relative size-4 shrink-0 rounded border-2 border-fg after:absolute after:inset-0.5 after:scale-0 after:rounded-[1px] after:bg-fg after:transition-transform peer-checked:after:scale-100"
                        aria-hidden="true"
                    />
                    <span class="pointer-events-none min-w-0 flex-1">{{ alsoText(option) }}</span>
                </label>
            </div>
        </template>

        <p class="px-2 text-sm opacity-75" data-chooser-rights>{{ strings.rights }}</p>

        <div
            class="sticky -bottom-2 -mx-1 -mb-1 flex flex-wrap items-center justify-end gap-x-3 gap-y-2 border-t border-fg/25 bg-modal px-3 py-3 max-[440px]:flex-col max-[440px]:items-stretch"
            data-chooser-actions
        >
            <div
                v-if="phase === 'working'"
                class="min-w-0 flex-1 basis-40"
                role="status"
                data-chooser-progress
            >
                <p class="text-sm">{{ strings.progress.storing }}</p>
                <div
                    class="chooser-bar mt-1 h-1 overflow-hidden rounded-full bg-fg/20"
                    aria-hidden="true"
                >
                    <div class="chooser-bar-fill h-full w-1/3 rounded-full bg-fg" />
                </div>
            </div>
            <p
                v-else-if="useError"
                :id="errorId"
                class="relative min-w-0 flex-1 basis-40 pl-6 text-sm"
                aria-live="polite"
                data-chooser-error
            >
                <AssetGlyph type="warning" class="absolute left-0 top-[0.1875rem]" />{{ useError }}
            </p>
            <div class="flex gap-2 max-[440px]:flex-col">
                <button
                    type="button"
                    :class="[buttonClass, 'max-[440px]:w-full']"
                    data-chooser-cancel
                    @click="chooser.cancel()"
                >
                    {{ i18n.modals.confirm.cancel }}
                </button>
                <button
                    ref="useButton"
                    type="button"
                    :class="[
                        selected !== undefined && phase === 'listed' ? primaryClass : buttonClass,
                        'max-[440px]:w-full',
                    ]"
                    :disabled="selected === undefined || phase !== 'listed'"
                    :aria-describedby="useError ? errorId : undefined"
                    data-chooser-use
                    @click="chooser.use()"
                >
                    {{ strings.use }}
                </button>
            </div>
        </div>
    </section>
</template>

<style scoped>
.chooser-bar-fill {
    animation: chooser-slide 1.1s ease-in-out infinite;
}

@keyframes chooser-slide {
    from {
        transform: translateX(-100%);
    }
    to {
        transform: translateX(300%);
    }
}

@media (prefers-reduced-motion: reduce) {
    .chooser-bar-fill {
        animation: none;
        width: 100%;
        opacity: 0.4;
    }
}
</style>

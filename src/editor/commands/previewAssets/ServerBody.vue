<script setup lang="ts">
import { computed, onBeforeUnmount, shallowRef, useId, watch } from 'vue'
import { vFocusRescue } from '../../../directives/focusRescue'
import { i18n } from '../../../i18n'
import type { AssetType } from '../../../preview/assets'
import { typeNoun } from '../../../preview/assets/fallbackText'
import type { ServerChooser } from '../../../preview/assets/server/chooser'
import { serverFailureText } from '../../../preview/assets/server/liveText'
import { interpolateRaw } from '../../../utils/interpolate'
import SeverityIcon from '../../SeverityIcon.vue'
import AlsoOptions from './AlsoOptions.vue'
import AssetRow from './AssetRow.vue'
import ChooserProgress from './ChooserProgress.vue'

// The chooser's From a Server view, in the apps: the address, the server's
// list with its quick search and More, and the other types' items of the same name. The footer is
// the chooser's.
const props = defineProps<{
    type: AssetType
    server: ServerChooser
}>()

const strings = computed(() => i18n.value.commands.previewAssets)
const groupName = useId()
const errorId = useId()

const { address, phase, loading, title, items, hasMore, selected, also, error, query, thumbnails } =
    props.server

const isListed = computed(() => phase.value === 'listed' || phase.value === 'working')
const errorText = computed(() => (error.value ? serverFailureText(error.value) : undefined))
// The address is read-only while a connection or a download is under way.
const isBusy = computed(() => phase.value === 'connecting' || phase.value === 'working')
// The field's name is the placeholder without its ellipsis.
const searchLabel = computed(() => strings.value.search.replace(/(…|\.\.\.)$/, ''))

// A quick search runs a moment after typing stops, or at once on Enter.
const searchText = shallowRef(query.value)
let timer: ReturnType<typeof setTimeout> | undefined
const runSearch = () => {
    clearTimeout(timer)
    if (searchText.value.trim() !== query.value.trim()) void props.server.search(searchText.value)
}
watch(searchText, () => {
    clearTimeout(timer)
    timer = setTimeout(runSearch, 350)
})
// A reset or a new connection empties the search too.
watch(query, (now) => {
    if (now.trim() !== searchText.value.trim()) searchText.value = now
})
onBeforeUnmount(() => {
    clearTimeout(timer)
})

// More goes once the last page is in: focus moves to the list.
const listedItem = () =>
    document.querySelector<HTMLElement>(
        '[data-chooser-list] input:checked, [data-chooser-list] input',
    )

const alsoText = (option: (typeof also.value)[number]) =>
    interpolateRaw(strings.value.alsoServerItem, typeNoun(option.type), option.title)

const buttonClass = 'btn btn-secondary h-9 min-w-24 max-w-full truncate rounded-full px-4'
const inputClass = 'field h-9 min-w-0 appearance-none rounded-full px-4 placeholder:opacity-60'
</script>

<template>
    <form
        class="flex min-w-0 items-center gap-2 px-2"
        novalidate
        data-server-form
        @submit.prevent="server.connect()"
    >
        <input
            v-model="address"
            v-focus-rescue:return
            type="text"
            inputmode="url"
            autocomplete="off"
            autocapitalize="none"
            spellcheck="false"
            placeholder="https://example.com/server"
            :class="[inputClass, 'flex-1']"
            :aria-label="strings.serverAddress"
            :aria-invalid="error?.kind === 'address' || undefined"
            :aria-describedby="errorText ? errorId : undefined"
            :disabled="isBusy"
            data-server-address
        />
        <button
            v-focus-rescue:return
            type="submit"
            :class="buttonClass"
            :disabled="isBusy"
            data-server-connect
        >
            {{ strings.connect }}
        </button>
    </form>

    <!-- Mounted while empty, so what appears in it is announced; empty, it takes no gap. -->
    <div class="flex flex-col gap-3 empty:-mt-3" role="status" data-server-status>
        <ChooserProgress v-if="phase === 'connecting'" :text="strings.progress.connecting" />
        <div v-if="errorText" :id="errorId" class="relative pl-8 pr-2 text-sm" data-server-error>
            <SeverityIcon severity="error" class="absolute left-2 top-[0.125rem] size-4" />
            <p data-server-error-text>{{ errorText }}</p>
        </div>
    </div>

    <template v-if="isListed">
        <div class="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 px-2">
            <span
                class="min-w-0 flex-1 basis-32 truncate font-bold"
                :title="title"
                data-server-title
                >{{ title }}</span
            >
            <form
                class="min-w-0 flex-1 basis-44"
                role="search"
                novalidate
                data-server-search-form
                @submit.prevent="runSearch"
            >
                <input
                    v-model="searchText"
                    v-focus-rescue:return
                    type="search"
                    autocomplete="off"
                    spellcheck="false"
                    :placeholder="strings.search"
                    :class="[inputClass, 'w-full']"
                    :aria-label="searchLabel"
                    :disabled="phase === 'working'"
                    data-server-search
                />
            </form>
        </div>

        <div
            v-if="items.length"
            class="flex flex-col rounded-xl"
            role="radiogroup"
            :aria-label="title || strings[type]"
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
                @select="server.select(item.name)"
            />
        </div>
        <p v-else-if="!loading" class="px-2 text-fg/80" data-chooser-empty>
            {{ strings.noneFound }}
        </p>

        <div v-if="hasMore || loading" class="flex items-center gap-3 px-2">
            <button
                v-if="hasMore"
                v-focus-rescue:return="listedItem"
                type="button"
                :class="buttonClass"
                :disabled="loading || phase === 'working'"
                data-server-more
                @click="server.more()"
            >
                {{ strings.more }}
            </button>
            <span v-if="loading" class="text-sm text-fg/80" role="status" data-server-loading>{{
                i18n.modals.loading.loading
            }}</span>
        </div>

        <AlsoOptions
            v-if="also.length"
            :options="also"
            :text="alsoText"
            :disabled="phase === 'working'"
            @toggle="server.toggle"
        />
    </template>
</template>

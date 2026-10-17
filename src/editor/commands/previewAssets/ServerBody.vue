<script setup lang="ts">
import { computed, onBeforeUnmount, shallowRef, useId, watch } from 'vue'
import { i18n } from '../../../i18n'
import type { AssetType } from '../../../preview/assets'
import { typeNoun } from '../../../preview/assets/fallbackText'
import type { ServerChooser } from '../../../preview/assets/server/chooser'
import { serverFailureText } from '../../../preview/assets/server/liveText'
import { interpolateRaw } from '../../../utils/interpolate'
import AlsoOptions from './AlsoOptions.vue'
import AssetGlyph from './AssetGlyph.vue'
import AssetRow from './AssetRow.vue'
import ChooserProgress from './ChooserProgress.vue'

// The chooser's From a Server view (Part 2, 2.5.3, 2.6): the address, the server's list with its
// quick search and More, and the other types' items of the same name. The footer is the chooser's.
const props = defineProps<{
    type: AssetType
    server: ServerChooser
}>()

const strings = computed(() => i18n.value.commands.previewAssets)
const groupName = useId()
const errorId = useId()

const { address, phase, loading, title, items, hasMore, selected, also, error, query } =
    props.server

const isListed = computed(() => phase.value === 'listed' || phase.value === 'working')
const errorText = computed(() => (error.value ? serverFailureText(error.value) : undefined))
// The address is read-only while a connection or a download is under way.
const isBusy = computed(() => phase.value === 'connecting' || phase.value === 'working')

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

const alsoText = (option: (typeof also.value)[number]) =>
    interpolateRaw(strings.value.alsoServerItem, typeNoun(option.type), option.title)

const buttonClass =
    'h-9 min-w-24 max-w-full truncate rounded-full bg-button px-4 shadow-md outline-none -outline-offset-2 transition-colors hover:shadow-accent focus-visible:ring-2 focus-visible:ring-fg active:bg-accent active:text-on-accent disabled:pointer-events-none disabled:opacity-40 [@media(pointer:coarse)]:h-11'
const inputClass =
    'h-9 min-w-0 appearance-none rounded-full bg-button px-4 shadow-md outline-none transition-colors placeholder:opacity-60 hover:shadow-accent focus:ring-2 focus:ring-fg disabled:opacity-40 [@media(pointer:coarse)]:h-11'
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
        <button type="submit" :class="buttonClass" :disabled="isBusy" data-server-connect>
            {{ strings.connect }}
        </button>
    </form>

    <ChooserProgress
        v-if="isBusy"
        :text="phase === 'connecting' ? strings.progress.connecting : strings.progress.downloading"
    />

    <div v-if="errorText" :id="errorId" class="relative pl-8 pr-2 text-sm" data-server-error>
        <AssetGlyph type="warning" class="absolute left-2 top-[0.1875rem]" />
        <p aria-live="polite" data-server-error-text>{{ errorText.text }}</p>
        <p v-if="errorText.route" class="mt-1" data-server-error-route>{{ errorText.route }}</p>
        <details v-if="errorText.owners" class="mt-1" data-server-owners>
            <summary
                class="cursor-pointer rounded outline-none focus-visible:ring-2 focus-visible:ring-fg"
            >
                {{ strings.forServerOwners }}
            </summary>
            <p class="mt-1 break-words">{{ errorText.owners }}</p>
        </details>
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
                    type="search"
                    autocomplete="off"
                    spellcheck="false"
                    :placeholder="strings.search"
                    :class="[inputClass, 'w-full']"
                    :aria-label="strings.search"
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
                :image="item.thumbnail"
                :checked="item.name === selected"
                :group="groupName"
                :data-chooser-item="item.name"
                @select="server.select(item.name)"
            />
        </div>
        <p v-else-if="!loading" class="px-2 opacity-75" data-chooser-empty>
            {{ strings.noneFound }}
        </p>

        <div v-if="hasMore || loading" class="flex items-center gap-3 px-2">
            <button
                v-if="hasMore"
                type="button"
                :class="buttonClass"
                :disabled="loading || phase === 'working'"
                data-server-more
                @click="server.more()"
            >
                {{ strings.more }}
            </button>
            <span v-if="loading" class="text-sm opacity-75" role="status" data-server-loading>{{
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

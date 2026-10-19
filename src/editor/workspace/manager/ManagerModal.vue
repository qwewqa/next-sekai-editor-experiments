<script setup lang="ts">
import { computed, provide, shallowRef, useId, useTemplateRef } from 'vue'
import { i18n } from '../../../i18n'
import BaseModal from '../../../modals/BaseModal.vue'
import { panelTitle } from '../panels'
import { groupManager } from './groups'
import ManagerList from './ManagerList.vue'
import type { ManagerTab } from './modal'
import { managerDisclosureOwnerKey, type ManagerDisclosureRequest } from './disclosure'
import StagesManager from './StagesManager.vue'

const props = defineProps<{
    tab: ManagerTab
    disclosureRequest?: ManagerDisclosureRequest
}>()

if (props.disclosureRequest) provide(managerDisclosureOwnerKey, props.disclosureRequest)

const emit = defineEmits<{
    close: []
}>()

const tabs = ['groups', 'stages'] as const satisfies ManagerTab[]
const active = shallowRef(props.tab)
const title = computed(() =>
    active.value === 'groups'
        ? i18n.value.commands.manageGroups.modal.title
        : i18n.value.commands.manageStages.modal.title,
)

const uid = useId()
const tabId = (tab: ManagerTab) => `${uid}-${tab}-tab`
const panelId = `${uid}-panel`
const tablist = useTemplateRef<HTMLElement>('tablist')

const onTab = (event: MouseEvent, tab: ManagerTab) => {
    active.value = tab
    // Pointer clicks leave no focus ring behind.
    if (event.detail > 0) (event.currentTarget as HTMLElement).blur()
}

const onTabKeydown = (event: KeyboardEvent) => {
    const index = tabs.indexOf(active.value)
    const next = {
        ArrowLeft: tabs[(index + tabs.length - 1) % tabs.length],
        ArrowRight: tabs[(index + 1) % tabs.length],
        Home: tabs[0],
        End: tabs[tabs.length - 1],
    }[event.key]
    if (!next) return
    event.preventDefault()
    active.value = next
    tablist.value?.querySelector<HTMLElement>(`#${tabId(next)}`)?.focus()
}
</script>

<template>
    <BaseModal :title fill @close="emit('close')">
        <template #header>
            <div ref="tablist" class="flex h-full min-w-0 self-stretch text-base" role="tablist">
                <button
                    v-for="item in tabs"
                    :id="tabId(item)"
                    :key="item"
                    type="button"
                    role="tab"
                    class="manager-modal-tab flex min-w-0 items-center outline-none"
                    :class="{ 'manager-modal-tab-active': item === active }"
                    :title="panelTitle(item)"
                    :aria-selected="item === active"
                    :aria-controls="item === active ? panelId : undefined"
                    :tabindex="item === active ? 0 : -1"
                    @click="onTab($event, item)"
                    @keydown="onTabKeydown"
                >
                    <!-- The band's height is the hit area; the pill carries hover, press and focus. -->
                    <span
                        class="manager-modal-tab-pill flex h-9 min-w-0 items-center rounded-full px-3 transition-colors"
                    >
                        <span class="manager-modal-tab-label relative min-w-0">
                            <span class="block truncate">{{ panelTitle(item) }}</span>
                        </span>
                    </span>
                </button>
            </div>
        </template>
        <div
            :id="panelId"
            class="manager-modal-panel flex min-h-0 flex-1 flex-col"
            role="tabpanel"
            :aria-labelledby="tabId(active)"
        >
            <ManagerList
                v-if="active === 'groups'"
                class="min-h-0 flex-1"
                :model="groupManager"
                scroll-key="modal:groups"
                autofocus-target
                @select-objects="emit('close')"
            />
            <StagesManager
                v-else
                class="min-h-0 flex-1"
                scroll-key="modal:stages"
                autofocus-target
                @select-objects="emit('close')"
            />
        </div>
    </BaseModal>
</template>

<style scoped>
/* Keeps the manager's band from merging with the header band above it. */
.manager-modal-panel :deep(.manager-band) {
    @apply border-t border-fg/25;
}

/* The shown tab's bar sits on the header's lower edge, as in Properties. */
.manager-modal-tab-active .manager-modal-tab-label::after {
    content: '';
    @apply pointer-events-none absolute -bottom-3 -left-2 -right-2 h-1 rounded-t-full bg-fg;
}

@media (forced-colors: active) {
    .manager-modal-tab-active .manager-modal-tab-label::after {
        background-color: CanvasText;
    }
}

/* The pill is the face, so the tab's state steps it with the band's tokens (inner-face pattern in
   docs/color-system.md): hover one step, press one more, focus a ring 2px inside in its ink. */
@media (hover: hover) and (pointer: fine) {
    .manager-modal-tab:not(.manager-modal-tab-active):not(:active):hover .manager-modal-tab-pill {
        @apply bg-band-hover;
    }
}

.manager-modal-tab:active .manager-modal-tab-pill {
    @apply bg-band-press text-fg-strong;
}

.manager-modal-tab:focus-visible .manager-modal-tab-pill {
    outline: 2px solid currentColor;
    outline-offset: -4px;
}

@media (forced-colors: active) {
    .manager-modal-tab:focus-visible .manager-modal-tab-pill {
        outline-width: 4px;
    }
}
</style>

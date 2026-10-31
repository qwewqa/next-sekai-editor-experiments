<script setup lang="ts">
import { computed, nextTick, useTemplateRef } from 'vue'
import { vScrollEdges } from '../../../directives/scrollEdges'
import type { PackageLevel } from '../../../files/package/inventory'
import BaseModal from '../../../modals/BaseModal.vue'
import type { ListRow, PackageList } from './packageList'
import PackageRow from './PackageRow.vue'

// Open's list of a Sonolus package: Open on each level whose data is in the file, and Import or
// Use on each asset. Open closes the list with the level; the header's close button or Escape
// closes it with nothing.
const props = defineProps<{
    title: string
    list: PackageList
}>()

const emit = defineEmits<{
    close: [level?: PackageLevel]
}>()

const rows = computed(() => props.list.rows.value)
const busy = computed(() => props.list.working.value !== undefined)
const scroller = useTemplateRef<HTMLElement>('scroller')

const hasButton = (row: ListRow) =>
    row.kind === 'level'
        ? row.level.data !== undefined
        : row.state === 'import' || row.state === 'use'

// The level whose Open failed or was cancelled takes the focus again; otherwise the first button.
const focusId = computed(() => {
    const pressed = rows.value.find((row) => row.id === props.list.pressed.value)
    return pressed && hasButton(pressed) ? pressed.id : rows.value.find(hasButton)?.id
})

/**
 * After an Import or a Use, the focus stays on the row's button while it has one (an Import that
 * failed); otherwise it moves to the next button, or the one before, or the list. Focus that the
 * user moved elsewhere meanwhile stays where it is.
 */
const settleFocus = async (id: string) => {
    await nextTick()
    const list = scroller.value
    if (!list) return
    const row = list.querySelector(`[data-package-row="${CSS.escape(id)}"]`)
    const focused = document.activeElement
    // A removed button leaves the focus on the body, or on the dialog.
    const lost = !focused || focused === document.body || focused === list.closest('dialog')
    if (!lost && !row?.contains(focused)) return
    const own = row?.querySelector<HTMLElement>('button:not(:disabled)')
    if (own) {
        own.focus()
        return
    }
    const buttons = [
        ...list.querySelectorAll<HTMLElement>('[data-package-row] button:not(:disabled)'),
    ]
    const after = buttons.find(
        (button) => row && row.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING,
    )
    ;(after ?? buttons.at(-1) ?? list).focus()
}

const onImport = async (row: ListRow & { kind: 'asset' }) => {
    await props.list.importRow(row)
    await settleFocus(row.id)
}

const onUse = (row: ListRow & { kind: 'asset' }) => {
    props.list.useRow(row)
    void settleFocus(row.id)
}

const onOpen = (row: ListRow & { kind: 'level' }) => {
    props.list.press(row.id)
    emit('close', row.level)
}
const firstAsset = computed(() => rows.value.find((row) => row.kind === 'asset')?.id)
</script>

<template>
    <BaseModal :title="title" fill @close="emit('close')">
        <!-- Announces Storing… and each result: in the page before its text changes. -->
        <p class="sr-only" role="status" data-package-status>{{ list.status.value }}</p>
        <div
            ref="scroller"
            v-scroll-edges
            class="min-h-0 flex-1 overflow-y-auto p-2"
            tabindex="-1"
            data-package-list
        >
            <template v-for="row in rows" :key="row.id">
                <p
                    v-if="row.id === firstAsset && list.safeModeLine.value"
                    class="px-3 pb-1 pt-2 text-sm text-fg/80"
                >
                    {{ list.safeModeLine.value }}
                </p>
                <PackageRow
                    :row="row"
                    :image="list.pictures.value.get(row.id)"
                    :disabled="busy && list.working.value !== row.id"
                    :working="list.working.value === row.id"
                    :error="list.errors.value.get(row.id)"
                    :autofocus="row.id === focusId"
                    @open="row.kind === 'level' && onOpen(row)"
                    @import="row.kind === 'asset' && onImport(row)"
                    @use="row.kind === 'asset' && onUse(row)"
                />
            </template>
        </div>
    </BaseModal>
</template>

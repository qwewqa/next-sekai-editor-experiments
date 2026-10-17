<script setup lang="ts">
import type { AssetType } from '../../../preview/assets'
import type { AlsoOption } from '../../../preview/assets/files/chooser'

// "Also use the particle "Neon" from this server": one unticked checkbox for each other type found.
defineProps<{
    options: AlsoOption[]
    text: (option: AlsoOption) => string
    disabled?: boolean
}>()

defineEmits<{
    toggle: [type: AssetType, ticked: boolean]
}>()
</script>

<template>
    <div class="flex flex-col" data-chooser-also>
        <label
            v-for="option in options"
            :key="option.type"
            class="relative flex min-h-10 cursor-pointer items-center gap-3 rounded-xl px-3 py-1 transition-colors has-[:active]:bg-accent has-[:active]:text-on-accent has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-fg [@media(hover:hover)]:hover:bg-band-hover [@media(pointer:coarse)]:min-h-12"
        >
            <input
                type="checkbox"
                class="peer absolute inset-0 size-full cursor-pointer opacity-0 focus-visible:outline-none"
                :checked="option.ticked"
                :disabled
                :data-chooser-also-type="option.type"
                @change="$emit('toggle', option.type, ($event.target as HTMLInputElement).checked)"
            />
            <span
                class="pointer-events-none relative size-4 shrink-0 rounded border-2 border-fg after:absolute after:inset-0.5 after:scale-0 after:rounded-[1px] after:bg-fg after:transition-transform peer-checked:after:scale-100"
                aria-hidden="true"
            />
            <span class="pointer-events-none min-w-0 flex-1">{{ text(option) }}</span>
        </label>
    </div>
</template>

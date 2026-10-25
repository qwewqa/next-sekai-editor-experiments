<script setup lang="ts">
import ToggleVolumeIcon from '../toggleVolume/ToggleVolumeIcon.vue'
import type { AssetType } from '../../../preview/assets'
import PreviewAssetsIcon from './PreviewAssetsIcon.vue'

// A neutral mark for a row without a picture.
defineProps<{
    type: AssetType
}>()
</script>

<template>
    <PreviewAssetsIcon v-if="type === 'skin'" class="size-5 fill-current" aria-hidden="true" />
    <ToggleVolumeIcon
        v-else-if="type === 'effect'"
        :state="true"
        class="size-5 fill-current"
        aria-hidden="true"
    />
    <!-- A four-point spark. -->
    <svg
        v-else-if="type === 'particle'"
        class="size-5 fill-current"
        viewBox="0 0 24 24"
        aria-hidden="true"
    >
        <path d="M12 1c1 6 5 10 11 11-6 1-10 5-11 11-1-6-5-10-11-11 6-1 10-5 11-11z" />
    </svg>
    <!-- A picture: sun and hills in a frame. -->
    <svg v-else class="size-5 fill-current" viewBox="0 0 24 24" aria-hidden="true">
        <path
            fill-rule="evenodd"
            d="M3 4h18a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zm3 3.5a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM3 18h18v-3l-5-5-5 6-3-3-5 5z"
        />
    </svg>
</template>

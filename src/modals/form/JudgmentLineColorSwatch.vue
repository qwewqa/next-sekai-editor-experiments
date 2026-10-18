<script setup lang="ts">
import type { JudgmentLineColor } from '../../chart/events/stage/style'
import { guideColors } from '../../utils/colors'
import ColorSwatch from './ColorSwatch.vue'

// The judgment line hue as the Default skin draws it.
defineProps<{ value: JudgmentLineColor }>()
</script>

<template>
    <ColorSwatch :color="guideColors[value]" />
</template>

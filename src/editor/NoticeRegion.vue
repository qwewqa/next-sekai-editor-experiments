<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { announcementOf, notification } from './notification'

// A polite live region announces changes, not what it holds when it is added. So it starts empty;
// `initial` puts the current notice in a moment after mount, and later notices replace it.
const props = defineProps<{ initial?: boolean }>()

const text = ref('')
const key = ref(notification.value.id)
let timer: ReturnType<typeof setTimeout> | undefined

onMounted(() => {
    if (!props.initial) return
    timer = setTimeout(() => {
        // A notice raised since has already been put in.
        if (!text.value) text.value = announcementOf(notification.value)
    }, 100)
})
onBeforeUnmount(() => {
    clearTimeout(timer)
})

// The key makes a repeated message read again.
watch(notification, (notice) => {
    clearTimeout(timer)
    key.value = notice.id
    text.value = announcementOf(notice)
})
</script>

<template>
    <div role="status" class="sr-only" data-notice-region>
        <span :key="key">{{ text }}</span>
    </div>
</template>

<script lang="ts">
// The notice a region last put in after it was on the page, so a region added later reads a
// notice no region has read yet and holds one that was already read.
let announced: object | undefined
</script>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { announcementOf, notification, type Notice } from './notification'

// A polite live region announces changes, not what it holds when it is added, and may miss a
// change made as it is added. So a region starts empty and takes the current notice a moment
// after it is mounted; notices raised in that moment wait for it, and later ones replace the text
// at once. A notice raised before any region existed, or while the page region was swapped for a
// dialog's, is read by the next region once it is ready.
const props = defineProps<{ initial?: boolean }>()

const SETTLE_MS = 100

const text = ref('')
const key = ref(notification.value.id)
const puts = ref(0)
let settling = true
let latest: Notice | undefined
let timer: ReturnType<typeof setTimeout> | undefined

// A page region put back after a dialog closes holds a notice the dialog already announced.
if (props.initial && announced === notification.value)
    text.value = announcementOf(notification.value)

const put = (notice: Notice) => {
    latest = notice
    key.value = notice.id
    text.value = announcementOf(notice)
    puts.value++
}

onMounted(() => {
    timer = setTimeout(() => {
        settling = false
        if (notification.value !== announced) put(notification.value)
    }, SETTLE_MS)
})
onBeforeUnmount(() => {
    clearTimeout(timer)
})

// Only a put that reached the page counts: a region unmounted in the same flush never runs this.
watch(
    puts,
    () => {
        announced = latest
    },
    { flush: 'post' },
)

// The key makes a repeated message read again.
watch(notification, (notice) => {
    if (!settling) put(notice)
})
</script>

<template>
    <div role="status" class="sr-only" data-notice-region>
        <span :key="key">{{ text }}</span>
    </div>
</template>

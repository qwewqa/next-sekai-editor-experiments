<script lang="ts">
// The notice a region last put in after it was on the page, so a region added later reads a
// notice no region has read yet and holds one that was already read.
let announced: object | undefined
</script>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
    announcementOf,
    cardInDialog,
    latestNotice,
    noticeCard,
    notification,
    quickInDialog,
    type Notice,
} from './notification'

// A polite live region announces changes, not what it holds when it is added, and may miss a
// change made as it is added. So a region starts empty and takes the current notice a moment
// after it is mounted; notices raised in that moment wait for it, and later ones replace the text
// at once. A notice raised before any region existed, or while the page region was swapped for a
// dialog's, is read by the next region once it is ready.
const props = defineProps<{
    initial?: boolean
    /**
     * A persistent dialog's region: it reads only notices drawn over its dialog. One under it cannot
     * be reached until the dialog closes, so the page region reads it then.
     */
    overOnly?: boolean
}>()

const SETTLE_MS = 100

const text = ref('')
const key = ref(latestNotice.value.id)
const puts = ref(0)
let settling = true
let latest: Notice | undefined
let timer: ReturnType<typeof setTimeout> | undefined

const drawnOver = (notice: Notice) =>
    (cardInDialog.value && noticeCard.value?.id === notice.id) ||
    (quickInDialog.value && notification.value.id === notice.id)

// A notice the page region read just before the persistent dialog covered it is read again after.
if (props.overOnly && announced === latestNotice.value && !drawnOver(latestNotice.value))
    announced = undefined

// A page region put back after a dialog closes holds a notice the dialog already announced.
if (props.initial && announced === latestNotice.value)
    text.value = announcementOf(latestNotice.value)

const put = (notice: Notice) => {
    if (props.overOnly && !drawnOver(notice)) return
    latest = notice
    key.value = notice.id
    text.value = announcementOf(notice)
    puts.value++
}

onMounted(() => {
    timer = setTimeout(() => {
        settling = false
        if (latestNotice.value !== announced) put(latestNotice.value)
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
watch(latestNotice, (notice) => {
    if (!settling) put(notice)
})
</script>

<template>
    <div role="status" class="sr-only" data-notice-region>
        <span :key="key">{{ text }}</span>
    </div>
</template>

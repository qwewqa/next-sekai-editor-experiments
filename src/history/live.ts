import { computed } from 'vue'
import { session } from './session'
import { liveState } from './stack'

// The current state's parts, for writers and exporters; a peeked state never shows here.

export const bgm = computed(() => liveState.value.bgm)

export const filename = computed(() => session.value.sourceName ?? liveState.value.bgm.filename)

export const groups = computed(() => liveState.value.groups)

export const groupFolders = computed(() => liveState.value.groupFolders)

export const initialLife = computed(() => liveState.value.initialLife)

export const isDynamicStages = computed(() => liveState.value.isDynamicStages)

export const stages = computed(() => liveState.value.stages)

export const stageFolders = computed(() => liveState.value.stageFolders)

export const store = computed(() => liveState.value.store)

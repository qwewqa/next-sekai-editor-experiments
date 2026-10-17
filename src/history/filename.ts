import { computed } from 'vue'
import { state } from '.'
import { session } from './session'

export const filename = computed(() => session.value.sourceName ?? state.value.bgm.filename)

import { computed } from 'vue'
import { i18n } from '../../i18n'
import { statisticsStringsOf } from './strings'

/** The names and messages the dialog, Copy Text and the share card share. */
export const statisticsStrings = computed(() => statisticsStringsOf(i18n.value))

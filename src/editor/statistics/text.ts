import { computed } from 'vue'
import { i18n } from '../../i18n'
import { settings } from '../../settings'
import { statisticsStringsOf } from './strings'

/** The UI locale, as the statistics' formatters take it. */
export const statisticsLocale = computed(() => settings.locale)

/** The names and messages the dialog, Copy Text and the share card share. */
export const statisticsStrings = computed(() => statisticsStringsOf(i18n.value))

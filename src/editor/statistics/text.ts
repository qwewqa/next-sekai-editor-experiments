import { computed } from 'vue'
import { i18n } from '../../i18n'
import { settings } from '../../settings'
import { statisticsStringsOf } from './strings'

/** The dialog's names and messages, for the chosen categories. */
export const statisticsStrings = computed(() =>
    statisticsStringsOf(i18n.value, settings.statisticsCategories),
)

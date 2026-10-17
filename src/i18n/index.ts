import { computed } from 'vue'
import { setDefaultGroupName } from '../chart/groups'
import { setKeyNames } from '../editor/controls/bindings'
import { settings } from '../settings'
import { setInterpolationLocale } from '../utils/interpolate'
import { localizations } from './localizations'

// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
export const i18n = computed(() => localizations[settings.locale]!)

setInterpolationLocale(() => settings.locale)
setKeyNames(() => i18n.value.modals.form.key.names)
setDefaultGroupName(() => i18n.value.group.default)

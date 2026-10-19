import { ref, shallowRef } from 'vue'
import type { ToolName } from '.'

export const toolName = ref<ToolName>('select')

export const toolChoiceRevision = ref(0)

// The tool a right press switched from, until it switches back.
export const secondarySwitchBack = shallowRef<ToolName>()

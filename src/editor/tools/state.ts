import { ref, shallowRef } from 'vue'
import type { ToolName } from '.'

export const toolName = ref<ToolName>('select')

// The tool a right press switched from, until it switches back.
export const secondarySwitchBack = shallowRef<ToolName>()

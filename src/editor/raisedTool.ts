import { computed } from 'vue'
import { toolChainOf } from './canvas/ordering'
import { secondarySwitchBack, toolName } from './tools/state'
import { view } from './view'

/** The chains the chosen tool raises, through a right press's switch to another. */
export const raisedToolChain = computed(() =>
    toolChainOf(secondarySwitchBack.value ?? toolName.value, view.stageId, view.groupId),
)

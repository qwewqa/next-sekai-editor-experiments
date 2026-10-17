import type { CommandName } from '../commands'
import type { CommandState } from './pressed'

/** A group's face, and the face a tool in use displaced, which returns when the tool ends. */
export type GroupFace = {
    face: CommandName | undefined
    displaced: CommandName | undefined
}

export type Pick = {
    name: CommandName
    /** The member's state once picked; a dialog it opened may have settled it. */
    state: CommandState | undefined
    keepsFace?: boolean
    inGroup: boolean
    toolInUse: boolean
}

/** Whether a member's state can move the face: a panel shows pressed but never takes it. */
export const movesFace = (state: CommandState | undefined): state is CommandState =>
    !!state && state.kind !== 'panel'

/** Where picking a member leaves its group's face. */
export const faceAfterPick = (group: GroupFace, pick: Pick): GroupFace => {
    // A toggle takes the face once in use; one a dialog cancels leaves it on the one in use.
    if (pick.keepsFace || pick.state?.current === false || !pick.inGroup) return group
    // Over a temporary face, a picked tool holds the face; anything else is where it returns.
    const displaced = group.displaced && (pick.state?.kind === 'tool' ? undefined : pick.name)
    // A value leaves the face to a tool in use.
    if (pick.state?.kind === 'value' && pick.toolInUse) return { face: group.face, displaced }
    return { face: pick.name, displaced }
}

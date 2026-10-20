// TEMPORARY: adapts the legacy model to the Step Details model of the proposal (section 5), so the
// dialog can run before P2's `operationDetails` lands. When P2 is merged, the dialog imports
// `operationDetails` from `history/operationPresentation` and this file is deleted.
import {
    describeMember,
    describeStep,
    isEntryDescription,
    operationDetails as legacyDetails,
    type DetailRow,
    type OperationDetails,
    type OperationRecipe,
    type OperationTextContext,
} from '../../history/operationPresentation'

export const operationDetails = (
    recipe: OperationRecipe,
    context: OperationTextContext,
): OperationDetails => {
    const fixture = (globalThis as { __detailsFixtures?: Record<string, OperationDetails> }).__detailsFixtures
    const named = recipe.members[0]?.id ? fixture?.[`${recipe.kind}:${recipe.members[0].id}`] : undefined
    if (named) return named
    const old = legacyDetails(recipe, context)
    const rows: DetailRow[] = []
    for (const section of old.sections) {
        const [first, second] = section.rows
        if (section.rows.length === 2 && first?.key === 'before' && second?.key === 'after')
            rows.push({
                kind: 'change',
                key: section.key,
                label: section.label,
                before: { text: first.value },
                after: { text: second.value },
            })
        else
            for (const row of section.rows)
                rows.push({
                    kind: 'value',
                    key: `${section.key}.${row.key}`,
                    label: row.label || section.label,
                    value: { text: row.value },
                })
    }
    const prefixless = recipe.kind === 'undo' || recipe.kind === 'redo'
    return {
        description: old.description,
        ...(old.explanation ? { note: old.explanation } : {}),
        rows,
        facts: [],
        ...(old.children.length
            ? {
                  steps: {
                      count: old.stepCount,
                      partial: old.partial,
                      members: [...old.children].reverse().map((member) => ({
                          member,
                          label:
                              prefixless &&
                              isEntryDescription(member.description) &&
                              member.description.step
                                  ? describeStep(member.description.step, context)
                                  : describeMember(member, context),
                          expandable: true,
                      })),
                      ...(prefixless ? { prefixless: true as const } : {}),
                  },
              }
            : {}),
        ...(old.recovery ? { recovery: old.recovery } : {}),
    }
}

import { i18n } from '../../i18n'
import { interpolateRaw } from '../../utils/interpolate'

/** A select's description in the locale: an optional sentence, then a text for each value. */
export type ChoiceDescription<T extends string> = {
    intro?: string
    choices: Record<T, string>
}

/** One choice's line: the select's name for it and the text after that name. */
export type ChoiceLine = { name: string; text: string }

/** What a field's ⓘ shows: prose, or an optional sentence and a line per choice, in order. */
export type FieldDescription = string | { intro?: string; lines: ChoiceLine[] }

/** What a select's ⓘ shows: prose, or a line per option, named and ordered as its options. */
export const describeChoices = <T>(
    description: string | ChoiceDescription<Extract<T, string>> | null | undefined,
    options: readonly (readonly [string, T])[],
): FieldDescription | null | undefined =>
    description == null || typeof description === 'string'
        ? description
        : {
              intro: description.intro,
              lines: options.map(([name, value]) => ({
                  name,
                  text: description.choices[value as Extract<T, string>],
              })),
          }

/** The start of a choice's line: its name and the locale's colon, as "Beat: ". */
export const choiceLine = (name: string) => {
    const template = i18n.value.modals.form.choiceLine
    return interpolateRaw(template.slice(0, template.indexOf('{1}')), name)
}

/** The description as screen readers hear it, the lines after the sentence. */
export const descriptionText = (description: FieldDescription) =>
    typeof description === 'string'
        ? description
        : [
              ...(description.intro ? [description.intro] : []),
              ...description.lines.map(({ name, text }) => choiceLine(name) + text),
          ].join(' ')

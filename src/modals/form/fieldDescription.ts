import { i18n } from '../../i18n'
import { interpolateRaw } from '../../utils/interpolate'

/** A select's description in the locale: a sentence, then a text for each of its values. */
export type ChoiceDescription<T extends string> = {
    intro: string
    choices: Record<T, string>
}

/** One choice's line: the select's name for it and the text after that name. */
export type ChoiceLine = { name: string; text: string }

/** What a field's ⓘ shows: prose, or a sentence and one line per choice in the select's order. */
export type FieldDescription = string | { intro: string; lines: ChoiceLine[] }

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
              description.intro,
              ...description.lines.map(({ name, text }) => choiceLine(name) + text),
          ].join(' ')

import en from '../../src/i18n/en/index.json' with { type: 'json' }

export { en }

/** A message with its {0}, {1}... filled. It does no plural selection or number formatting. */
export const said = (message: string, ...params: (string | number)[]) =>
    message.replace(/\{(\d+)\}/g, (_, index: string) => String(params[Number(index)]))

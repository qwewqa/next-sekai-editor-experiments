/** The error a member gives before the step that builds it. */
export const notYet = (member: string, step: string) =>
    new Error(`${member} is not available before ${step}`)

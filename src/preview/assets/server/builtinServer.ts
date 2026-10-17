/** Our own static server (Part 2, 2.5.7), at this site: `https://nse.qwewqa.dev/builtin-server/`. */
export const builtinServerUrl = () =>
    new URL(`${import.meta.env.BASE_URL}builtin-server/`, location.href).href

import type { EventData } from './catalogue'
import { measured } from './scales'

/** The workspace's size as an event sends it: width, height and width divided by height. */
export const viewportDetails = (
    width: number,
    height: number,
): Pick<EventData<'perf'>, 'viewport' | 'viewportHeight' | 'viewportAspect'> => {
    const viewport = measured('viewport', width)
    const viewportHeight = measured('viewportHeight', height)
    const viewportAspect = measured('viewportAspect', width / height)
    return {
        ...(viewport && { viewport }),
        ...(viewportHeight && { viewportHeight }),
        ...(viewportAspect && { viewportAspect }),
    }
}

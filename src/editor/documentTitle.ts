import { watchEffect } from 'vue'
import { PRODUCT_NAME } from '../product'
import { statusText } from './labelText'

// `document.title` mirrors the status bar's label: "Coconut (Master) · coconut.nxsp – Next SEKAI
// Editor" (Part 1 §1.3.4). A prefix the page was built with, such as the test site's, stays.
if (typeof document !== 'undefined') {
    const built = document.title
    const prefix = built.endsWith(PRODUCT_NAME) ? built.slice(0, -PRODUCT_NAME.length) : ''
    watchEffect(() => {
        document.title = `${prefix}${statusText.value} – ${PRODUCT_NAME}`
    })
}

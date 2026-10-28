<script setup lang="ts">
import { computed } from 'vue'
import { PRIVACY_PATH, TERMS_PATH } from '../../buildInfo'
import { i18n } from '../../i18n'
import { platform } from '../../platform'
import { linkParts } from '../../utils/linkParts'

// The agreement sentence, with the Terms of Service and the Privacy Notice as links in it.

const links = computed(() => [
    { name: i18n.value.agreement.terms, href: TERMS_PATH },
    { name: i18n.value.agreement.privacy, href: PRIVACY_PATH },
])
const parts = computed(() =>
    linkParts(
        i18n.value.agreement.sentence,
        links.value.map((link) => link.name),
    ),
)

const linkClass = 'focus-out rounded-sm underline outline outline-2 outline-transparent'

const open = (href: string) => {
    platform.openExternal(new URL(href, location.href).href)
}
</script>

<template>
    <p data-agreement-sentence>
        <template v-if="parts"
            ><template v-for="(part, i) in parts" :key="i"
                ><template v-if="'text' in part">{{ part.text }}</template
                ><span v-else class="whitespace-nowrap"
                    >{{ part.lead
                    }}<a
                        :href="links[part.link]!.href"
                        target="_blank"
                        rel="noopener"
                        :class="[linkClass, 'whitespace-normal']"
                        @click.prevent="open(links[part.link]!.href)"
                        >{{ part.name }}</a
                    >{{ part.trail }}</span
                ></template
            ></template
        >
        <template v-else
            >{{ i18n.agreement.sentence
            }}<template v-for="link in links" :key="link.href"
                >{{ ' '
                }}<a
                    :href="link.href"
                    target="_blank"
                    rel="noopener"
                    :class="linkClass"
                    @click.prevent="open(link.href)"
                    >{{ link.name }}</a
                ></template
            ></template
        >
    </p>
</template>

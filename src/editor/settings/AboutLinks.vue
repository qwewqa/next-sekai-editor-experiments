<script lang="ts">
export const aboutButtonClass =
    'btn btn-secondary inline-flex h-9 min-w-24 max-w-full items-center gap-1 rounded-full px-4'
</script>

<script setup lang="ts">
import { computed } from 'vue'
import {
    GITHUB_REPOSITORY,
    HAS_PRIVACY_PAGE,
    HAS_TERMS_PAGE,
    PRIVACY_PATH,
    RELEASE_NOTES_URL,
    TERMS_PATH,
} from '../../buildInfo'
import { i18n } from '../../i18n'
import { appVersion, platform } from '../../platform'

const about = computed(() => i18n.value.settings.about)

// Release Notes is CHANGELOG.md on main; a build with no release tag behind its version has none.
const { atTag, appVersion: shown } = appVersion()
const hasReleaseTag = atTag || shown.includes('+')

const links = computed(() => [
    ...(hasReleaseTag
        ? [{ key: 'releaseNotes', label: about.value.releaseNotes, href: RELEASE_NOTES_URL }]
        : []),
    { key: 'source', label: about.value.source, href: `https://github.com/${GITHUB_REPOSITORY}` },
    { key: 'license', label: about.value.license, href: '/LICENSE.txt' },
    { key: 'notices', label: about.value.notices, href: '/THIRD_PARTY_NOTICES.txt' },
    ...(HAS_PRIVACY_PAGE
        ? [{ key: 'privacy', label: about.value.privacy, href: PRIVACY_PATH }]
        : []),
    ...(HAS_TERMS_PAGE ? [{ key: 'terms', label: about.value.terms, href: TERMS_PATH }] : []),
])

const open = (href: string) => {
    platform.openExternal(new URL(href, location.href).href)
}
</script>

<template>
    <div class="flex flex-wrap gap-2" data-about-links>
        <a
            v-for="link in links"
            :key="link.key"
            :href="link.href"
            target="_blank"
            rel="noopener"
            :data-about-link="link.key"
            :class="aboutButtonClass"
            @click.prevent="open(link.href)"
        >
            <span class="truncate">{{ link.label }}</span>
            <span aria-hidden="true">↗</span>
        </a>
    </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import {
    GITHUB_REPOSITORY,
    HAS_PRIVACY_PAGE,
    RELEASE_NOTES_URL,
    SITE,
    TEST_SITE_ABOUT,
} from '../../buildInfo'
import { i18n } from '../../i18n'
import { showModal } from '../../modals'
import { appVersion, platform } from '../../platform'
import { PRODUCT_NAME } from '../../product'
import { interpolateRaw } from '../../utils/interpolate'
import { collectDiagnosticText } from './diagnosticInfo'
import DiagnosticsModal from './DiagnosticsModal.vue'
import SettingsSection from './SettingsSection.vue'

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
        ? [{ key: 'privacy', label: about.value.privacy, href: '/privacy/' }]
        : []),
])

const buttonClass =
    'inline-flex h-9 max-w-full items-center gap-1 rounded-full bg-button px-4 shadow-md outline-none -outline-offset-2 transition-colors hover:shadow-accent focus-visible:ring-2 focus-visible:ring-fg active:bg-accent active:text-on-accent [@media(pointer:coarse)]:h-11'

const open = (href: string) => {
    platform.openExternal(new URL(href, location.href).href)
}

const diagnostics = async () => {
    await showModal(DiagnosticsModal, { text: await collectDiagnosticText() })
}
</script>

<template>
    <SettingsSection id="about" :title="about.title">
        <div class="flex flex-col gap-1">
            <div class="font-medium" data-about-name>{{ PRODUCT_NAME }}</div>
            <div data-about-version>{{ interpolateRaw(about.version, shown) }}</div>
        </div>

        <div class="flex flex-wrap gap-2" data-about-links>
            <a
                v-for="link in links"
                :key="link.key"
                :href="link.href"
                target="_blank"
                rel="noopener"
                :data-about-link="link.key"
                :class="buttonClass"
                @click.prevent="open(link.href)"
            >
                <span class="truncate">{{ link.label }}</span>
                <span aria-hidden="true">↗</span>
            </a>
        </div>

        <div class="flex">
            <button type="button" data-about-diagnostics :class="buttonClass" @click="diagnostics">
                <span class="truncate">{{ about.diagnostics }}</span>
            </button>
        </div>

        <div v-if="SITE === 'test'" data-about-test-site>{{ TEST_SITE_ABOUT }}</div>
    </SettingsSection>
</template>

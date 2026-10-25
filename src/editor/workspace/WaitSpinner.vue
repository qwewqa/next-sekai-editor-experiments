<template>
    <!-- The one spinner (a slot that holds a glyph, the end of a list, the startup gate); the caller
         sets its size. Under reduced motion it pulses instead of turning, so a wait still looks live. -->
    <svg
        class="shrink-0 text-fg motion-safe:animate-spin motion-reduce:animate-pulse"
        viewBox="0 0 24 24"
        fill="none"
        aria-hidden="true"
    >
        <circle
            cx="12"
            cy="12"
            r="9"
            stroke="currentColor"
            stroke-opacity="0.25"
            stroke-width="3"
        />
        <path
            d="M21 12a9 9 0 0 0-9-9"
            stroke="currentColor"
            stroke-width="3"
            stroke-linecap="round"
        />
    </svg>
</template>

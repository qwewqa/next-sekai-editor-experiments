import { defineModelTests } from './sessionModel'

// The model test of spec A with the page's default journal writer (Chromium, Firefox 126 and
// later, Safari where it honours `durability`): a power loss is `loseRelaxed`. The Firefox-before-126
// runs are in `sessionModel.fx.test.ts`, so the two run side by side.
defineModelTests(false)

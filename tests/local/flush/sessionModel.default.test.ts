import { defineModelTests } from './sessionModel'

// The model test where a power loss is `loseRelaxed` (Chromium, Firefox 126 and later,
// Safari where it honours `durability`). The `loseCommits` runs are in `sessionModel.fx.test.ts`,
// so the two run side by side.
defineModelTests(false)

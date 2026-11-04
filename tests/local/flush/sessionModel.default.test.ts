import { defineModelTests } from './sessionModel'

// The model test where a power loss is `loseRelaxed`, as where IndexedDB honours `durability`. The `loseCommits` runs are in `sessionModel.fx.test.ts`,
// so the two run side by side.
defineModelTests(false)

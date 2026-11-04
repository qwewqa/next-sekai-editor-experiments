import { defineModelTests } from './sessionModel'

// The model test where a power loss is `loseCommits`, which undoes commits whatever their
// durability, as where IndexedDB ignores it. Its seeds are its own (the default runs' plus 1000).
defineModelTests(true)

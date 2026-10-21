import { defineModelTests } from './sessionModel'

// The model test of design A as Firefox before 126 runs it: the journal writer with
// `strictCommits: false`, and a power loss is `loseCommits`, which undoes commits whatever their
// durability. Its seeds are its own (the default writer's plus 1000).
defineModelTests(true)

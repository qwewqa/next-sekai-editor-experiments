import { worldDefaults } from '../../src/local/testing/world'

// Import for its effect: every world this test file creates asserts that a session's rows are
// written only by a page holding `nse-session:<id>` (design A I-1). A file whose tests fake a dead
// tab by leaving it alive (so a replay finds its lock held) must not import it; A2's acceptance
// moves those files over by killing their tabs.
worldDefaults.lock = true

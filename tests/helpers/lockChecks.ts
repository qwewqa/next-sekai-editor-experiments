import { worldDefaults } from '../../src/local/testing/world'

// Import for its effect: every world this test file creates asserts that a session's rows are
// written only by a page holding `nse-session:<id>` (spec A I-1). A test that fakes a dead tab must
// kill it (`tab.kill()`), so a replay finds its lock free as a real one would.
worldDefaults.lock = true

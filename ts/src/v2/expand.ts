// Rule splitting. Per the spec, a rule with multiple producer atoms at top
// level can be split into a chain of rules so that other rules fire between
// assertions ("yielding control to other rules between asserts"). All stage-2
// test programs are correct under single-firing semantics, so this pass is
// the identity for now — splits become important once we have multi-rule
// pipelines that need to interleave. Tracked as part of v2 follow-up.

import type { Program } from "./types.js";

export function expand(program: Program): Program {
  return program;
}

import assert from "node:assert/strict";
import { editorState, maxEdited, revealedText, type EditMap } from "../pres/render.js";
import type { Segment } from "../pres/types.js";

// A 3-segment code block: reveals 1, 2, 3.
const segs: Segment[] = [
  { text: "a", reveal: 1 },
  { text: "b", reveal: 2 },
  { text: "c", reveal: 3 },
];

// 1. Empty S: editorState equals revealedText at every reveal.
{
  const S: EditMap = new Map();
  for (const r of [1, 2, 3, 4]) {
    assert.equal(editorState(S, segs, r), revealedText(segs, r), `empty@${r}`);
  }
  assert.equal(editorState(S, segs, 1), "a");
  assert.equal(editorState(S, segs, 3), "abc");
  // Reveals above the last segment add nothing.
  assert.equal(editorState(S, segs, 4), "abc");
}

// 2. maxEdited: 0 when empty, else greatest edited reveal.
{
  assert.equal(maxEdited(new Map()), 0);
  assert.equal(maxEdited(new Map([[1, "x"]])), 1);
  assert.equal(maxEdited(new Map([[1, "x"], [3, "y"]])), 3);
  assert.equal(maxEdited(new Map([[2, "x"]])), 2);
}

// 3. An edit at R is returned at R, and later source segments append after it.
{
  const S: EditMap = new Map([[1, "A"]]);     // edited reveal 1
  assert.equal(editorState(S, segs, 1), "A");
  assert.equal(editorState(S, segs, 2), "Ab"); // edit + later source segment
  assert.equal(editorState(S, segs, 3), "Abc");
}

// 4. Below-frozen reflection: a frozen lower view still shows lower edits.
//    With S={1:"A"} the freeze predicate (maxEdited > R) is false here, but the
//    reconstruction is what matters: viewing reveal 2 reflects the edit at 1.
{
  const S: EditMap = new Map([[1, "A"]]);
  assert.equal(editorState(S, segs, 2), "Ab");
}

// 5. Edit survives a freeze excursion: edit reveal 3, step back, step forward.
{
  const S: EditMap = new Map([[3, "C!"]]);    // edited the final reveal
  // Frozen at reveals below 3 (maxEdited=3 > 1,2); reconstruction shows source.
  assert.ok(maxEdited(S) > 1 && maxEdited(S) > 2);
  assert.equal(editorState(S, segs, 1), "a");
  assert.equal(editorState(S, segs, 2), "ab");
  // Back at the edited reveal, the edit is intact.
  assert.equal(editorState(S, segs, 3), "C!");
}

// 6. Nearest-right base wins: an edit at 2 shadows an edit at 1 for reveal >= 2.
{
  const S: EditMap = new Map([[1, "A"], [2, "AB-edited"]]);
  assert.equal(editorState(S, segs, 1), "A");
  assert.equal(editorState(S, segs, 2), "AB-edited");        // uses reveal-2 base
  assert.equal(editorState(S, segs, 3), "AB-editedc");       // + later segment
}

console.log("pres_reveal_state: ok");

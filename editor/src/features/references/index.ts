// Find Usages — a walkable list of LSP references, as opposed to Monaco's peek
// widget which shows the same data on top of the code you are trying to read.
//
// Unrelated to `unity-context`'s asset usages: that is a GUID reverse index
// over scenes and prefabs, this is `textDocument/references` over code.
export { ReferencesPanel } from './components/ReferencesPanel';
export { findUsagesAtCursor, canFindUsages } from './services/find-usages';

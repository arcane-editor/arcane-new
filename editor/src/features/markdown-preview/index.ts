// Markdown preview — rendered .md with select-to-suggest, and the plan
// document view that turns a plan file into a working surface (steps carrying
// live state, suggestions, execute/stop) rather than a read-only render.
export { default as MarkdownPreview } from './components/MarkdownPreview';
export { default as PlanDocumentView } from './components/PlanDocumentView';
export { createNote, reanchorNotes, planStepsOf } from './services/note-anchor';
export type { PlanNote, PlanStep } from './services/note-anchor';
export { isPlanPath, isMarkdownPath } from './services/plan-paths';

export { default as SourceControlPanel } from './components/SourceControlPanel';
export { default as BranchPicker } from './components/BranchPicker';
export { registerBlameHoverProvider } from './services/blame-provider';
export { runGitignoreDoctor } from './services/unity-git';
export { attachGitGutter, type GutterRanges } from './services/gutter-decorations';
export {
  resolveDiffSources,
  isLiveDiff,
  nextDiffInfo,
  type DiffSide,
  type DiffSources,
} from './services/diff-sources';

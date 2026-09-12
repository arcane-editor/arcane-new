import './styles/inline-blame.css';

export { default as SourceControlPanel } from './components/SourceControlPanel';
export { default as BranchPicker } from './components/BranchPicker';
export { attachInlineBlame } from './services/inline-blame';
export { runGitignoreDoctor } from './services/unity-git';
export { attachGitGutter, type GutterRanges } from './services/gutter-decorations';
export {
  resolveDiffSources,
  isLiveDiff,
  nextDiffInfo,
  type DiffSide,
  type DiffSources,
} from './services/diff-sources';

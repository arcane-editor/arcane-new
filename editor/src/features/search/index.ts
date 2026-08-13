export { default as SearchOutlinePanel } from './components/SearchOutlinePanel';
export { default as SearchResultsTab } from './components/SearchResultsTab';
export {
  parseGlobList,
  applyBatch,
  applyComplete,
  autoSearchAction,
  summaryFor,
  searchSignature,
  MIN_AUTO_SEARCH_CHARS,
  type AutoSearchAction,
  type StreamState,
  type SearchBatchPayload,
  type SearchCompletePayload,
  type SearchSignatureInput,
} from './services/search-model';
export {
  createSession,
  patchSession,
  sessionForSearchId,
  type SearchSession,
  type SearchSessions,
  type SearchOptionsState,
} from './services/search-session';
export {
  buildExcerpts,
  excerptId,
  type Excerpt,
  type ExcerptLine,
  type MatchRange,
} from './services/excerpt-model';
export {
  splitByMatches,
  excerptRowKey,
  type LineSegment,
} from './services/highlight';
export {
  pushQuery,
  historyStep,
  resolveCaseSensitive,
  HISTORY_LIMIT,
  type HistoryPosition,
} from './services/query-history';
export { unityNoiseExcludes, UNITY_NOISE_EXTENSIONS } from './services/unity-scope';
export { SearchModelRegistry } from './services/model-ownership';
export { offsetWithinLine, columnFor } from './services/caret-offset';
export {
  complementRanges,
  canHideAreas,
  applyHiddenAreas,
  type LineRange,
} from './services/hidden-areas';
export { hotSet } from './services/hot-blocks';

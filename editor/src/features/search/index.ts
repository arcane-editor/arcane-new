export { default as SearchOutlinePanel } from './components/SearchOutlinePanel';
export { default as SearchResultsTab } from './components/SearchResultsTab';
export {
  parseGlobList,
  applyBatch,
  applyComplete,
  autoSearchAction,
  MIN_AUTO_SEARCH_CHARS,
  type AutoSearchAction,
  type StreamState,
  type SearchBatchPayload,
  type SearchCompletePayload,
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
  applyExpansion,
  excerptId,
  type Excerpt,
  type ExcerptLine,
  type MatchRange,
  type Expansion,
} from './services/excerpt-model';
export {
  splitByMatches,
  excerptRowKey,
  type LineSegment,
} from './services/highlight';
export {
  splitLines,
  readFileLines,
  clearFileLineCache,
} from './services/file-lines';
export {
  pushQuery,
  historyStep,
  resolveCaseSensitive,
  HISTORY_LIMIT,
  type HistoryPosition,
} from './services/query-history';

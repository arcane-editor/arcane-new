import { useSearchStore } from '../../../stores/search';
import SearchQueryBar from './SearchQueryBar';
import ExcerptList from './ExcerptList';

interface SearchResultsTabProps {
  sessionId: string;
}

function SearchResultsTab({ sessionId }: SearchResultsTabProps) {
  const session = useSearchStore((s) => s.sessions[sessionId]);
  if (!session) return null;

  return (
    <div className="search-tab">
      <SearchQueryBar sessionId={sessionId} />
      <ExcerptList sessionId={sessionId} />
    </div>
  );
}

export default SearchResultsTab;

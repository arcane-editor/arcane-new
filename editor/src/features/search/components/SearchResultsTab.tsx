import { useSearchStore } from '../../../stores/search';
import SearchQueryBar from './SearchQueryBar';

interface SearchResultsTabProps {
  sessionId: string;
}

function SearchResultsTab({ sessionId }: SearchResultsTabProps) {
  const session = useSearchStore((s) => s.sessions[sessionId]);
  if (!session) return null;

  return (
    <div className="search-tab">
      <SearchQueryBar sessionId={sessionId} />
      <div className="search-tab-body" />
    </div>
  );
}

export default SearchResultsTab;

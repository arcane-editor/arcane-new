import { useSearchStore } from '../../../stores/search';

interface SearchResultsTabProps {
  sessionId: string;
}

function SearchResultsTab({ sessionId }: SearchResultsTabProps) {
  const session = useSearchStore((s) => s.sessions[sessionId]);
  if (!session) return null;
  return <div className="search-tab" data-session={sessionId} />;
}

export default SearchResultsTab;

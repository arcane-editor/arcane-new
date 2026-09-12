// A local two-tab strip. There is no shared Tabs component in this codebase and
// one strip does not justify inventing an abstraction; this follows the
// `.bottom-panel-tab` underline pattern, restyled for the sidebar.

interface TabSpec {
  id: string;
  label: string;
  /** Optional count rendered beside the label. */
  count?: number;
}

interface InspectorTabsProps {
  tabs: TabSpec[];
  activeId: string;
  onSelect: (id: string) => void;
}

function InspectorTabs({ tabs, activeId, onSelect }: InspectorTabsProps) {
  return (
    <div className="so-inspector-tabs" role="tablist" aria-label="Inspector">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          role="tab"
          aria-selected={tab.id === activeId}
          className={`so-inspector-tab${tab.id === activeId ? ' active' : ''}`}
          onClick={() => onSelect(tab.id)}
        >
          {tab.label}
          {tab.count !== undefined && <span className="so-inspector-tab-count">{tab.count}</span>}
        </button>
      ))}
    </div>
  );
}

export default InspectorTabs;

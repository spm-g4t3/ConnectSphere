import { useId, useRef, useState } from "react";
import "./ui.css";

/**
 * WAI-ARIA tabs with automatic activation: an arrow key, Home or End moves
 * focus and selects the tab it lands on.
 *
 * Controlled when `selected` is given (with `onSelect`), otherwise it keeps
 * its own choice, starting at `defaultSelected` or the first tab. A selection
 * that is not among `tabs` shows the first tab.
 *
 * @param {object} props
 * @param {string} props.label  the tab list's accessible name
 * @param {{ id: string, label: string, content: import("react").ReactNode }[]} props.tabs
 * @param {string} [props.selected]
 * @param {string} [props.defaultSelected]
 * @param {(id: string) => void} [props.onSelect]
 */
export default function Tabs({ label, tabs, selected, defaultSelected, onSelect }) {
  const baseId = useId();
  const [ownSelected, setOwnSelected] = useState(defaultSelected);
  const tabRefs = useRef(new Map());
  const requested = selected !== undefined ? selected : ownSelected;
  const active = tabs.some((tab) => tab.id === requested) ? requested : tabs[0]?.id;

  function choose(id) {
    if (selected === undefined) setOwnSelected(id);
    onSelect?.(id);
  }

  function handleKeyDown(event) {
    const index = tabs.findIndex((tab) => tab.id === active);
    const last = tabs.length - 1;
    const next = {
      ArrowRight: index === last ? 0 : index + 1,
      ArrowLeft: index === 0 ? last : index - 1,
      Home: 0,
      End: last,
    }[event.key];
    if (next === undefined) return;
    event.preventDefault();
    choose(tabs[next].id);
    tabRefs.current.get(tabs[next].id)?.focus();
  }

  return (
    <div className="ui-tabs">
      <div className="ui-tabs__list" role="tablist" aria-label={label}>
        {tabs.map((tab) => {
          const isActive = tab.id === active;
          return (
            <button
              key={tab.id}
              ref={(node) => {
                if (node) tabRefs.current.set(tab.id, node);
                else tabRefs.current.delete(tab.id);
              }}
              type="button"
              role="tab"
              id={`${baseId}-tab-${tab.id}`}
              className="ui-tabs__tab"
              aria-selected={isActive}
              aria-controls={`${baseId}-panel-${tab.id}`}
              tabIndex={isActive ? 0 : -1}
              onClick={() => choose(tab.id)}
              onKeyDown={handleKeyDown}
            >
              {tab.label}
            </button>
          );
        })}
      </div>
      {/* Every panel stays mounted and only the chosen one is shown, so the others
          keep their reads and state (a venue search in progress) while hidden. */}
      {tabs.map((tab) => (
        <div
          key={tab.id}
          role="tabpanel"
          id={`${baseId}-panel-${tab.id}`}
          className="ui-tabs__panel"
          aria-labelledby={`${baseId}-tab-${tab.id}`}
          tabIndex={0}
          hidden={tab.id !== active}
        >
          {tab.content}
        </div>
      ))}
    </div>
  );
}

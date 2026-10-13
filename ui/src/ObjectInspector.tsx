import { Copy, X } from "lucide-react";
import { useState } from "react";

import type { InspectionDetails } from "./inspection";

/** A read-only card for the building element last clicked in the 3D view. */
export function ObjectInspector(props: { readonly details: InspectionDetails; readonly onClose: () => void }) {
  const { details } = props;
  const [copied, setCopied] = useState(false);
  const [showProperties, setShowProperties] = useState(false);

  function copyId() {
    void navigator.clipboard?.writeText(details.globalId).then(
      () => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      },
      () => setCopied(false),
    );
  }

  const groups = [...new Set(details.properties.map((row) => row.group))];
  return (
    <section className="viewer-card viewer-card--inspect" aria-label={`Details of ${details.title}`}>
      <div className="viewer-card-heading">
        <p className="eyebrow">{details.tag ?? "Element"}</p>
        <button type="button" className="viewer-card-close" aria-label="Close the element details" onClick={props.onClose}>
          <X size={14} />
        </button>
      </div>
      <h2 className="viewer-inspect-title">{details.title}</h2>
      <p className="viewer-card-note">{details.subtitle}</p>
      <button type="button" className="viewer-inspect-id" onClick={copyId} title="Copy the GlobalId">
        <span>{details.globalId}</span>
        <Copy size={12} /> {copied ? "Copied" : ""}
      </button>
      <dl className="viewer-inspect-facts">
        {details.facts.map((fact) => (
          <div key={fact.label}>
            <dt>{fact.label}</dt>
            <dd>{fact.value}</dd>
          </div>
        ))}
      </dl>
      {details.properties.length > 0 ? (
        <>
          <button
            type="button"
            className="tool-button tool-button--tight"
            aria-expanded={showProperties}
            onClick={() => setShowProperties((value) => !value)}
          >
            {showProperties ? "Hide" : "Show"} {details.properties.length} IFC properties
          </button>
          {showProperties ? (
            <div className="viewer-inspect-properties">
              {groups.map((group) => (
                <dl key={group}>
                  <p className="eyebrow">{group}</p>
                  {details.properties
                    .filter((row) => row.group === group)
                    .map((row) => (
                      <div key={row.name}>
                        <dt>{row.name}</dt>
                        <dd>{row.value}</dd>
                      </div>
                    ))}
                </dl>
              ))}
            </div>
          ) : null}
        </>
      ) : null}
      <p className="viewer-card-note">Sizes are IFC bounds. The drawn detail is illustrative.</p>
    </section>
  );
}

import { Check } from "lucide-react";

import { roomDisplayName } from "./roomOrder";
import type { Room, ViewMode } from "./types";

/**
 * Designing a room is a sequence, not a wall of switches.
 *
 * Each stage answers one question and shows only the controls that answer it:
 * what the ceiling is, where the light goes, what the sun does, where it is
 * still dark, and whether it is fit to publish.
 */
export type DesignStage = "ceiling" | "light" | "daylight" | "check" | "publish";

/** The canvas layer a stage is about. It turns on when the stage opens and off when it closes. */
type StageLayer = "sun" | "darkZones";

export const DESIGN_STAGES: ReadonlyArray<{
  readonly id: DesignStage;
  readonly label: string;
  readonly view?: ViewMode;
  readonly layer?: StageLayer;
}> = [
  { id: "ceiling", label: "Ceiling", view: "model" },
  { id: "light", label: "Light" },
  { id: "daylight", label: "Daylight", layer: "sun" },
  { id: "check", label: "Dark spots", layer: "darkZones" },
  { id: "publish", label: "Publish" },
];

export function StageBar({
  room,
  ceilingElevationMm,
  stage,
  onChooseStage,
}: {
  readonly room: Room;
  readonly ceilingElevationMm: number;
  readonly stage: DesignStage;
  readonly onChooseStage: (stage: DesignStage) => void;
}) {
  const stageIndex = DESIGN_STAGES.findIndex((item) => item.id === stage);
  return (
    <header className="stage-bar">
      <div className="room-context">
        <h1>{roomDisplayName(room)}</h1>
        <span title="Finished ceiling elevation">Z {Math.round(ceilingElevationMm)} mm</span>
      </div>
      <nav aria-label="Design stages">
        <ol className="stage-steps">
          {DESIGN_STAGES.map((item, index) => (
            <li key={item.id}>
              <button
                type="button"
                className={[
                  "stage-step",
                  index === stageIndex ? "stage-step--active" : "",
                  index < stageIndex ? "stage-step--done" : "",
                ].filter(Boolean).join(" ")}
                aria-current={index === stageIndex ? "step" : undefined}
                title={`Step ${index + 1} of ${DESIGN_STAGES.length}: ${item.label}`}
                onClick={() => onChooseStage(item.id)}
              >
                <span className="stage-step-number" aria-hidden="true">{index < stageIndex ? <Check size={11} strokeWidth={3} /> : index + 1}</span>
                <span className="stage-step-label">{item.label}</span>
              </button>
            </li>
          ))}
        </ol>
      </nav>
    </header>
  );
}

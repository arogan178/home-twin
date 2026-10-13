import { DEMO_INSTALL_URL } from "./demo";
import "./styles/demo.css";

export function DemoBanner() {
  return (
    <p className="demo-banner" role="note">
      Read-only demo of a synthetic home. Every result is precomputed by the real server.{" "}
      <a href={DEMO_INSTALL_URL}>Install Home Twin</a> to edit, check, and save.
    </p>
  );
}

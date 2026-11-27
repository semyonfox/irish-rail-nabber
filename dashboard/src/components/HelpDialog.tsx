import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { setTelemetryOptOut, telemetryConfigured, telemetryOptedOut } from "../utils/telemetry";
import { Icon } from "./ui";

export default function HelpDialog({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [disabled, setDisabled] = useState(telemetryOptedOut);
  useEffect(() => {
    const dialog = ref.current;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog?.showModal();
    return () => {
      dialog?.close();
      if (opener?.isConnected) opener.focus();
      else document.getElementById("main-content")?.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className="help-dialog"
      aria-labelledby="help-title"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onKeyDown={(event) => {
        if (event.key !== "Tab") return;
        const controls = ref.current?.querySelectorAll<HTMLElement>("button, a[href], input");
        const first = controls?.[0];
        const last = controls?.[controls.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }}
    >
      <div className="sheet-head">
        <h2 id="help-title" className="card-title">
          Using traein
        </h2>
        <button type="button" className="icon-btn" aria-label="Close help" onClick={onClose}>
          <Icon name="x" />
        </button>
      </div>
      <div className="sheet-body">
        <p>Live maps and departures are free. You can use them without an account.</p>
        <p>
          Choose Rail or Bus, then use the service list or Stops to open departures. Rail Stations
          also shows delay statistics.
        </p>
        <p>Rail Network, History and Assistant need a Coffee or Pro plan. Bus Network is public.</p>
        <Link to="/pricing" className="btn btn-quiet" onClick={onClose}>
          Compare plans
        </Link>
        <h3 className="card-title">Anonymous usage and errors</h3>
        <p>
          Anonymous screen counts and fixed error categories are self-hosted. No visitor tracking,
          search text or account details are sent.
        </p>
        <p>
          {telemetryConfigured
            ? "Collection is configured for this build. Your browser's privacy signals and the switch below take priority."
            : "Collection is off. It needs an owner-configured endpoint and an explicit enable flag."}
        </p>
        <label className="flex items-start gap-3">
          <input
            type="checkbox"
            checked={disabled}
            onChange={(event) => {
              setDisabled(event.target.checked);
              setTelemetryOptOut(event.target.checked);
            }}
          />
          <span>Disable anonymous usage and error reporting</span>
        </label>
      </div>
    </dialog>
  );
}

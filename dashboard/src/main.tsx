import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App.tsx";
import { telemetry } from "./utils/telemetry";

telemetry.count("app_open");
createRoot(document.getElementById("root")!).render(<App />);

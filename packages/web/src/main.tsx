import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { applyTheme, loadTheme } from "./theme.js";
import "./styles.css";

// Before first paint, so a chosen theme does not flash the other one.
applyTheme(loadTheme());

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import QwenAudition from "./QwenAudition";
import RealtimeAudition from "./RealtimeAudition";
import "./style.css";
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {new URLSearchParams(window.location.search).has("realtime") ? (
      <RealtimeAudition />
    ) : new URLSearchParams(window.location.search).has("legacy") ? (
      <App />
    ) : (
      <QwenAudition />
    )}
  </React.StrictMode>,
);
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () =>
    navigator.serviceWorker
      .register("/sw.js")
      .catch((error) => console.warn("离线页面缓存未启用", error)),
  );
}

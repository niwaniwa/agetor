import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/geist";
import "./index.css";
import App from "./App";
import { ConfirmProvider } from "@/components/ui/confirm";
import { BrowserApp } from "@/components/BrowserApp";
import { browserMode } from "@/lib/transport";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ConfirmProvider>
      {browserMode ? <BrowserApp /> : <App />}
    </ConfirmProvider>
  </StrictMode>,
);

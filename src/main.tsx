import { StrictMode } from "react"
import { createRoot } from "react-dom/client"

import App from "./App"
import { LocaleProvider } from "./i18n"
import "./app.css"

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <LocaleProvider>
      <App />
    </LocaleProvider>
  </StrictMode>,
)

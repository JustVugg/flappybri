import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

/* The dev server and the preview server can also forward /v1 to a colibri
 * server. The page and the API then share one origin, and the browser has no
 * cross-origin request to allow: set the server URL in the page to /v1 to use
 * it. COLIBRI_URL picks the server, by default the address `coli serve` listens
 * on. A trailing /v1 in it is dropped, since the forwarded path keeps its own.
 *
 * The ports are strict on purpose: `coli serve` allows the origins
 * http://localhost:5173 and http://127.0.0.1:5173 out of the box, so a dev
 * server that quietly moved to 5174 would be refused by the browser. */
const colibri = (process.env.COLIBRI_URL || "http://127.0.0.1:8000").replace(/\/v1\/?$/, "").replace(/\/+$/, "")
const proxy = { "/v1": { target: colibri, changeOrigin: true } }

export default defineConfig({
  base: "./",
  plugins: [react()],
  server: { port: 5173, strictPort: true, proxy },
  preview: { port: 4173, strictPort: true, proxy },
})

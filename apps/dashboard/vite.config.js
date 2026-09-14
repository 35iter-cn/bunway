import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";

export default defineConfig({
  base: "/console/",
  plugins: [svelte()],
  server: {
    proxy: { "/admin": "http://localhost:3001" },
  },
});
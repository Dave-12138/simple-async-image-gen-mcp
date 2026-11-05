import { builtinModules } from "node:module";
import { defineConfig } from "vite";

export default defineConfig({
    build: {
        target: "node20",
        outDir: "dist",
        sourcemap: true,
        lib: {
            entry: "./src/index.ts",
            formats: ["es"],
            fileName: "index"
        },
        minify: false,
        rollupOptions: {
            external: [
                /^@modelcontextprotocol\//,
                /^zod(\/|$)/,
                /^node:/,
                ...builtinModules
            ]
        }
    }
});

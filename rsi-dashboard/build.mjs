import { build } from "esbuild";
import { fileURLToPath } from "node:url";
await build({
  absWorkingDir: fileURLToPath(new URL(".",import.meta.url)),
  entryPoints: ["src/main.tsx"],
  outfile: "dashboard.js",
  bundle: true, minify: true, jsx: "automatic", target: "es2022",
  define: { "process.env.NODE_ENV": '"production"' },
  legalComments: "eof",
});

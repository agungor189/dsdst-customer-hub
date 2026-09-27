import { defineConfig } from "vite";
import path from "node:path";

export default defineConfig({
  build:{
    outDir:path.resolve("dist/widget"),
    emptyOutDir:false,
    sourcemap:false,
    minify:"esbuild",
    lib:{entry:path.resolve("widget/dsdst-chat.ts"),formats:["iife"],name:"DSDSTChat",fileName:()=>"dsdst-chat.js"},
  },
});

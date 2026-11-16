#!/usr/bin/env node
import { main } from "./commands/main.js";
import { useHttp1ForFetch } from "./http1.js";

useHttp1ForFetch();

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  },
);

import { runIssuerOnce } from "./lib/runtime.js";

type ProcessLike = {
  env?: Record<string, string | undefined>;
  exitCode?: number;
};

const processLike = (globalThis as typeof globalThis & { process?: ProcessLike }).process;

try {
  const result = await runIssuerOnce({ env: processLike?.env ?? {} });
  console.log(JSON.stringify({
    ok: true,
    ...result,
  }));
} catch (error) {
  processLike && (processLike.exitCode = 1);
  console.error(JSON.stringify({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  }));
}

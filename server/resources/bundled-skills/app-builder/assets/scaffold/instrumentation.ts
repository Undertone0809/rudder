export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { startJobRunner } = await import("@/lib/jobs/runner");
  startJobRunner();
}

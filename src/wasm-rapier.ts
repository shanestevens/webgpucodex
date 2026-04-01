type RapierModule = typeof import("@dimforge/rapier3d-compat");

let cachedRapierPromise: Promise<RapierModule> | null = null;

export async function loadRapier(): Promise<RapierModule> {
  cachedRapierPromise ??= (async () => {
    const module = await import("@dimforge/rapier3d-compat");
    await module.init();
    return module;
  })();

  return cachedRapierPromise;
}

type ZxcvbnRuntime = typeof import('./zxcvbn-runtime');

let zxcvbnModulePromise: Promise<ZxcvbnRuntime> | undefined;

async function loadZxcvbn(): Promise<ZxcvbnRuntime> {
  if (!zxcvbnModulePromise) {
    zxcvbnModulePromise = import('./zxcvbn-runtime');
  }
  return zxcvbnModulePromise;
}

export async function estimatePasswordStrength(input: {
  password: string;
  email?: string;
  displayName?: string;
}): Promise<{ score: number }> {
  const runtime = await loadZxcvbn();
  const userInputs = [
    input.email,
    input.displayName,
  ].filter((value): value is string => Boolean(value?.trim()));
  return {
    score: runtime.estimateZxcvbnScore(input.password, userInputs),
  };
}

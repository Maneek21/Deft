const SAFE_PNPM_ARG = /^[A-Za-z0-9@._:/-]+$/;

export function buildWindowsPnpmCommandArgs(
  args: readonly string[],
): string[] {
  if (!args.every((arg) => SAFE_PNPM_ARG.test(arg))) {
    throw new Error(
      'Refusing to pass an unsafe argument to the pnpm Windows wrapper',
    );
  }

  return ['/d', '/c', 'pnpm.cmd', ...args];
}

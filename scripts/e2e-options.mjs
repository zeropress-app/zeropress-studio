export function resolveE2EOptions(args, environment = {}) {
  const informational = args.some((arg) => ['--list', '--help', '-h', '--version', '-V'].includes(arg));
  const headed = args.some((arg, index) => ['--headed', '--debug=inspector'].includes(arg)
    || (arg === '--debug' && args[index + 1] !== 'cli'))
    || Boolean(environment.PWDEBUG && !['0', 'false', 'console'].includes(environment.PWDEBUG));
  const uiInBrowser = args.some((arg) => /^--ui-(?:host|port)(?:=|$)/.test(arg));
  const uiMode = args.includes('--ui') || uiInBrowser;
  return {
    checkHeadedBrowser: !informational && (headed || (uiMode && !uiInBrowser)),
    checkHeadlessBrowser: !informational && !headed,
    createUiSession: !informational && uiMode,
  };
}

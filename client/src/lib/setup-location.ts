export function consumeSetupTokenFromLocation(): string {
  const token = new URLSearchParams(window.location.hash.slice(1))
    .get('token') ?? '';
  if (window.location.hash) {
    window.history.replaceState(
      window.history.state,
      '',
      `${window.location.pathname}${window.location.search}`,
    );
  }
  return token;
}

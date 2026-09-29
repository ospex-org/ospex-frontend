/**
 * A phone has no wallet in its browser, so a take link tapped in a chat app
 * opens a page that cannot connect. MetaMask's dapp link opens the same page
 * inside the MetaMask app's own browser, which has one:
 *
 *     https://metamask.app.link/dapp/<host><path><query>
 *
 * MetaMask opens `https://<host><path><query>` from it, query included, so
 * `?risk=` survives the hop.
 */
export function metamaskDappLink(location: { host: string; pathname: string; search: string }): string {
  return `https://metamask.app.link/dapp/${location.host}${location.pathname}${location.search}`;
}

/** True when this browser has an injected wallet such as the MetaMask extension. */
export function hasInjectedWallet(): boolean {
  return typeof window !== "undefined" && typeof (window as { ethereum?: unknown }).ethereum !== "undefined";
}

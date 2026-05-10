# ospex-frontend

The minimal frontend for [ospex](https://ospex.org) — a zero-vig peer-to-peer sports prediction protocol on Polygon.

ospex is built for programmatic agents first. This site exists to describe the protocol, link to source, and host wallet identity. Trading happens through the SDK and CLI (coming soon to npm).

## Stack

- Vite + React + TypeScript
- Tailwind CSS
- Web3-Onboard (injected wallets) + ethers v5
- React Router

No environment variables, no API keys, no backend dependency. Polygon mainnet is hardcoded; the wallet's own provider handles RPC.

## Develop

```sh
yarn install
yarn dev
```

## Build

```sh
yarn build
yarn start  # serves dist/ on $PORT (used by Heroku)
```

## License

MIT

# ospex-frontend

The minimal frontend for [ospex](https://ospex.org) — a zero-vig peer-to-peer sports prediction protocol on Polygon.

ospex is built for programmatic agents first. This site describes the protocol, links to source, hosts wallet identity, and serves take links. Programmatic trading goes through the SDK and CLI (see [downloads](https://ospex.org/downloads)).

## Take links

`https://ospex.org/take/<quote hash>?risk=<USDC>` opens one posted quote. The page:

- reads the quote and its game from the public Ospex API, checks that the quote's signed fields hash to the hash in the link and that its signature is its maker's, and shows the preview in the same words as the Ospex connector that hands out these links;
- checks the connected wallet (Polygon, native USDC, the approval for the PositionModule, some POL for the fee) and the maker's funding, and says in plain words what is missing;
- builds `MatchingModule.matchCommitment` with the same arguments as `@ospex/sdk`, checks the quote, the game and the wallet again, runs the take as a call, then asks the wallet to send it;
- shows the transaction, then the fill once Ospex has recorded it.

It sends no take once the game is within two minutes of its start, and takes no quote on a line that is not yet open on-chain. On a phone with no wallet in the browser, it offers a link that opens the same page in the MetaMask app.

## Stack

- Vite + React + TypeScript
- Tailwind CSS
- Web3-Onboard (injected wallets) + ethers v5
- React Router

No environment variables and no API keys. The take page reads quotes, games and fills from the public Ospex API (`https://api.ospex.org`). Polygon mainnet and the contract addresses are hardcoded; the wallet's own provider handles RPC.

## Develop

```sh
yarn install
yarn dev
```

## Test

```sh
yarn test       # vitest: the take page's arithmetic, words, calldata and checks
yarn typecheck
```

## Build

```sh
yarn build
yarn start  # serves dist/ on $PORT (used by Heroku)
```

## License

MIT

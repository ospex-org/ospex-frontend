/**
 * The fixed facts the take page builds a transaction from. Polygon mainnet only.
 *
 * The addresses are the round-5 deployment: the values `@ospex/sdk` carries for
 * chain 137, and the ones listed in `public/llms.txt`. They are written here
 * rather than read from the API, so no response the page reads can change
 * where a transaction goes or which token an approval is for.
 */

export const POLYGON_CHAIN_ID = 137;

export const MATCHING_MODULE = "0x46Af20B6307Aa0Ec13de10EF58a02c5F1b5C9559";
export const POSITION_MODULE = "0x3C71fdB8ABF41487a512440e5ce6490158C26e56";
/** Native USDC on Polygon. Bridged USDC.e is a different token, and the protocol does not take it. */
export const USDC = "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359";

/** Which scorer a quote names decides its market, on-chain and here. */
export const SCORERS = {
  moneyline: "0x59555106D4B5f1A797f3552f60ac418Eb6B6f6BD",
  spread: "0x8f293da716164d5A32dc087A85e5164D929ae9D4",
  total: "0xB4B1E2A2a75C34e9E4C5D3BB8A432aff973DaDa0",
} as const;

export type Market = keyof typeof SCORERS;

export const OSPEX_API_URL = "https://api.ospex.org";
export const POLYGONSCAN_TX_URL = "https://polygonscan.com/tx/";

/**
 * No take is sent within two minutes of the game's start or of the quote's
 * expiry. The connector that writes the links uses the same margin. The
 * contract checks the quote's expiry and not the game's start, so a quote that
 * outlives the start could otherwise be taken on a game under way.
 */
export const TAKE_MARGIN_MS = 120_000;

/** `MatchingModule.MAX_LINE_TICKS`. A line past it can lock both sides' funds at settlement. */
export const MAX_LINE_TICKS = 1_000_000;

/** The EIP-712 domain every quote is signed under. `verifyingContract` is MatchingModule, not OspexCore. */
export const EIP712_DOMAIN = {
  name: "Ospex",
  version: "1",
  chainId: POLYGON_CHAIN_ID,
  verifyingContract: MATCHING_MODULE,
} as const;

/** The nine signed fields, in the order the contract's type hash lists them. */
export const COMMITMENT_TYPES = {
  OspexCommitment: [
    { name: "maker", type: "address" },
    { name: "contestId", type: "uint256" },
    { name: "scorer", type: "address" },
    { name: "lineTicks", type: "int32" },
    { name: "positionType", type: "uint8" },
    { name: "oddsTick", type: "uint16" },
    { name: "riskAmount", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "expiry", type: "uint256" },
  ],
};

/**
 * `matchCommitment` exactly as the MatchingModule artifact in `@ospex/sdk`
 * declares it, plus the event a take emits and the errors a take can revert
 * with, from the same artifacts (MatchingModule and PositionModule), with
 * OpenZeppelin's ECDSA and SafeERC20 errors that those contracts can raise.
 */
export const MATCHING_MODULE_ABI = [
  {
    type: "function",
    name: "matchCommitment",
    inputs: [
      {
        name: "commitment",
        type: "tuple",
        internalType: "struct MatchingModule.OspexCommitment",
        components: [
          { name: "maker", type: "address", internalType: "address" },
          { name: "contestId", type: "uint256", internalType: "uint256" },
          { name: "scorer", type: "address", internalType: "address" },
          { name: "lineTicks", type: "int32", internalType: "int32" },
          { name: "positionType", type: "uint8", internalType: "enum PositionType" },
          { name: "oddsTick", type: "uint16", internalType: "uint16" },
          { name: "riskAmount", type: "uint256", internalType: "uint256" },
          { name: "nonce", type: "uint256", internalType: "uint256" },
          { name: "expiry", type: "uint256", internalType: "uint256" },
        ],
      },
      { name: "signature", type: "bytes", internalType: "bytes" },
      { name: "takerDesiredRisk", type: "uint256", internalType: "uint256" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "event",
    name: "CommitmentMatched",
    anonymous: false,
    inputs: [
      { name: "commitmentHash", type: "bytes32", indexed: true },
      { name: "maker", type: "address", indexed: true },
      { name: "taker", type: "address", indexed: true },
      { name: "contestId", type: "uint256", indexed: false },
      { name: "speculationId", type: "uint256", indexed: false },
      { name: "scorer", type: "address", indexed: false },
      { name: "lineTicks", type: "int32", indexed: false },
      { name: "makerPositionType", type: "uint8", indexed: false },
      { name: "oddsTick", type: "uint16", indexed: false },
      { name: "makerRisk", type: "uint256", indexed: false },
      { name: "takerRisk", type: "uint256", indexed: false },
      { name: "commitmentRiskAmount", type: "uint256", indexed: false },
      { name: "nonce", type: "uint256", indexed: false },
      { name: "expiry", type: "uint256", indexed: false },
    ],
  },
  "error MatchingModule__CommitmentCancelled()",
  "error MatchingModule__CommitmentExpired()",
  "error MatchingModule__CommitmentFullyFilled()",
  "error MatchingModule__ContestAlreadyScored()",
  "error MatchingModule__ContestPastCooldown()",
  "error MatchingModule__InvalidFillMakerRisk()",
  "error MatchingModule__InvalidLotSize()",
  "error MatchingModule__InvalidMakerAddress()",
  "error MatchingModule__InvalidSignature()",
  "error MatchingModule__InvalidTakerDesiredRisk()",
  "error MatchingModule__LineTicksOutOfRange(int32)",
  "error MatchingModule__NonceTooLow()",
  "error MatchingModule__OddsOutOfRange(uint16)",
  "error PositionModule__ContestAlreadyScored()",
  "error PositionModule__InvalidAmount()",
  "error PositionModule__SpeculationNotOpen()",
  "error ECDSAInvalidSignature()",
  "error ECDSAInvalidSignatureLength(uint256)",
  "error ECDSAInvalidSignatureS(bytes32)",
  "error SafeERC20FailedOperation(address)",
];

export const ERC20_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 value) returns (bool)",
];

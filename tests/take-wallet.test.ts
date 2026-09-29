/**
 * The wallet checks in plain words, reading a take back out of its receipt,
 * saying why a transaction would fail, and the link that opens the page in
 * MetaMask on a phone.
 */
import { ethers } from "ethers";
import { describe, expect, it } from "vitest";
import { readWallet, walletProblems, type ChainReads, type WalletState } from "../src/lib/take/checks";
import { MATCHING_MODULE, POSITION_MODULE } from "../src/lib/take/constants";
import { metamaskDappLink } from "../src/lib/take/deeplink";
import { describeRevert, findRevertData, isUserRejection, matchedEvent } from "../src/lib/take/tx";

const TAKER = "0x00000000000000000000000000000000000c0ffe";
const MAKER = "0x5316fa54c170d1927f30d1a497ac9e85e3826a9b";
/** The live Under 47 at 5 USDC: 4.999914 from the taker, 4.716900 from the maker. */
const NEED = { takerRisk: 4_999_914n, fillMakerRisk: 4_716_900n, maker: MAKER };

const funded: WalletState = {
  chainId: 137,
  taker: TAKER,
  polWei: 10n ** 17n,
  usdc: 20_000_000n,
  allowance: 4_999_914n,
  makerUsdc: 100_000_000n,
  makerAllowance: 49_000_000n,
};

describe("the wallet checks, in plain words", () => {
  it("find nothing wrong with a funded, approved wallet on Polygon", () => {
    expect(walletProblems(funded, NEED)).toEqual([]);
  });

  it("explain an approval that is short, which is the failure to try on purpose", () => {
    expect(walletProblems({ ...funded, allowance: 0n }, NEED)).toEqual([
      {
        code: "allowance_short",
        text: "Ospex is approved to move 0.000000 of your USDC, and this bet needs 4.999914. Approve it, then take the bet.",
      },
    ]);
    // One base unit short is short.
    expect(walletProblems({ ...funded, allowance: 4_999_913n }, NEED).map((p) => p.code)).toEqual(["allowance_short"]);
  });

  it("explain too little USDC, and which USDC counts", () => {
    expect(walletProblems({ ...funded, usdc: 3_200_000n }, NEED)).toEqual([
      {
        code: "usdc_short",
        text:
          "Your wallet has 3.200000 USDC on Polygon, and this bet needs 4.999914. " +
          "Only native USDC counts (the token at 0x3c49…3359), not bridged USDC.e.",
      },
    ]);
  });

  it("explain the wrong network, and read nothing else there", async () => {
    expect(walletProblems({ ...funded, chainId: 1 }, NEED)).toEqual([
      {
        code: "wrong_chain",
        text: "Your wallet is on another network (chain 1). This bet is on Polygon: switch your wallet to Polygon.",
      },
    ]);
    const asked: string[] = [];
    const reads: ChainReads = {
      chainId: async () => 1,
      polBalance: async () => {
        asked.push("pol");
        return 0n;
      },
      usdcBalance: async () => {
        asked.push("usdc");
        return 0n;
      },
      usdcAllowance: async () => {
        asked.push("allowance");
        return 0n;
      },
    };
    expect((await readWallet(reads, TAKER, MAKER)).chainId).toBe(1);
    expect(asked).toEqual([]);
  });

  it("explain no POL for the fee, a maker without the funds, and taking one's own quote", () => {
    expect(walletProblems({ ...funded, polWei: 0n }, NEED).map((p) => p.text)).toEqual([
      "Your wallet has no POL. Polygon needs a little POL to pay the network fee.",
    ]);
    expect(walletProblems({ ...funded, makerAllowance: 4_716_899n }, NEED).map((p) => p.text)).toEqual([
      "The quote's maker does not have the USDC behind it right now, so the take would fail and only cost gas. " +
        "Try again later, or ask for another quote.",
    ]);
    expect(walletProblems({ ...funded, taker: MAKER }, NEED).map((p) => p.code)).toEqual(["self_match"]);
  });

  it("read the taker's and the maker's funding, each against the PositionModule", async () => {
    const reads: ChainReads = {
      chainId: async () => 137,
      polBalance: async (address) => (address === TAKER ? 7n : 0n),
      usdcBalance: async (address) => (address === TAKER ? 11n : 22n),
      usdcAllowance: async (owner, spender) => {
        expect(spender).toBe(POSITION_MODULE);
        return owner === TAKER ? 33n : 44n;
      },
    };
    expect(await readWallet(reads, TAKER, MAKER)).toEqual({
      chainId: 137,
      taker: TAKER,
      polWei: 7n,
      usdc: 11n,
      allowance: 33n,
      makerUsdc: 22n,
      makerAllowance: 44n,
    });
  });
});

describe("reading a take back from its receipt", () => {
  // Built from the event as MatchingModule.sol declares it, written out by
  // hand, not from the page's ABI.
  const SIGNATURE =
    "CommitmentMatched(bytes32,address,address,uint256,uint256,address,int32,uint8,uint16,uint256,uint256,uint256,uint256,uint256)";
  const hash = "0x44cfbdfe8524667942a3d8f9784d212fea27b852459091d7de5a440ad34a2617";
  const pad = (address: string) => ethers.utils.hexZeroPad(address, 32);
  const log = {
    address: MATCHING_MODULE,
    topics: [ethers.utils.id(SIGNATURE), hash, pad(MAKER), pad(TAKER)],
    data: ethers.utils.defaultAbiCoder.encode(
      ["uint256", "uint256", "address", "int32", "uint8", "uint16", "uint256", "uint256", "uint256", "uint256", "uint256"],
      [478, 994, "0xb4b1e2a2a75c34e9e4c5d3bb8a432aff973dada0", 470, 0, 206, 4_716_900, 4_999_914, 5_000_000, 1790654368, 1791120600],
    ),
  };

  it("finds the amounts the chain moved", () => {
    expect(matchedEvent([log], hash)).toEqual({ taker: TAKER, makerRisk: 4_716_900n, takerRisk: 4_999_914n, oddsTick: 206 });
  });

  it("ignores the same event from another contract, and one for another quote", () => {
    expect(matchedEvent([{ ...log, address: POSITION_MODULE }], hash)).toBeNull();
    expect(matchedEvent([log], `0x${"ab".repeat(32)}`)).toBeNull();
  });
});

describe("why a transaction would fail", () => {
  const selector = (error: string) => ethers.utils.id(error).slice(0, 10);

  it("names the contract's refusals", () => {
    expect(describeRevert(selector("MatchingModule__CommitmentFullyFilled()"))).toBe("This quote has been taken in full.");
    expect(describeRevert(selector("MatchingModule__NonceTooLow()"))).toBe("The maker has cancelled this quote on-chain.");
    expect(describeRevert(selector("MatchingModule__InvalidFillMakerRisk()"))).toBe(
      "This quote no longer has enough left for this amount. Someone may have taken part of it.",
    );
  });

  it("quotes a token's own reason", () => {
    const data = `0x08c379a0${ethers.utils.defaultAbiCoder
      .encode(["string"], ["ERC20: transfer amount exceeds allowance"])
      .slice(2)}`;
    expect(describeRevert(data)).toBe(
      'A transfer would fail: "ERC20: transfer amount exceeds allowance". ' +
        "Your wallet or the quote's maker may be short of USDC or of the approval.",
    );
  });

  it("finds the revert inside a wallet's nested error, and knows a refusal to sign", () => {
    const data = selector("MatchingModule__CommitmentExpired()");
    const nested = {
      code: "UNPREDICTABLE_GAS_LIMIT",
      error: { code: -32603, message: "Internal JSON-RPC error.", data: { code: 3, message: "execution reverted", data } },
    };
    expect(findRevertData(nested)).toBe(data);
    expect(describeRevert(data)).toBe("This quote has expired.");
    expect(findRevertData({ message: "timeout" })).toBeNull();
    expect(isUserRejection({ code: 4001, message: "MetaMask Tx Signature: User denied transaction signature." })).toBe(true);
    expect(isUserRejection({ code: "ACTION_REJECTED" })).toBe(true);
    expect(isUserRejection({ code: -32603, message: "Internal JSON-RPC error." })).toBe(false);
  });
});

describe("the phone link", () => {
  it("opens the same page, with its amount, in MetaMask's browser", () => {
    expect(
      metamaskDappLink({
        host: "ospex.org",
        pathname: "/take/0x44cfbdfe8524667942a3d8f9784d212fea27b852459091d7de5a440ad34a2617",
        search: "?risk=5",
      }),
    ).toBe(
      "https://metamask.app.link/dapp/ospex.org/take/0x44cfbdfe8524667942a3d8f9784d212fea27b852459091d7de5a440ad34a2617?risk=5",
    );
  });
});

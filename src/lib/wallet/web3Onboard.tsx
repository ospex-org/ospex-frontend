import { createContext, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { init, useConnectWallet } from "@web3-onboard/react";
import injectedModule from "@web3-onboard/injected-wallets";
import { ethers } from "ethers";

type Web3ContextType = {
  isConnected: boolean;
  address: string | null;
  provider: ethers.providers.Web3Provider | null;
  signer: ethers.providers.JsonRpcSigner | null;
  connectWallet: () => Promise<void>;
  disconnectWallet: () => Promise<void>;
  chainId: number | null;
};

const defaultValue: Web3ContextType = {
  isConnected: false,
  address: null,
  provider: null,
  signer: null,
  connectWallet: async () => {},
  disconnectWallet: async () => {},
  chainId: null,
};

const Web3Context = createContext<Web3ContextType>(defaultValue);

const isClient = typeof window !== "undefined";

const POLYGON_MAINNET = {
  chainId: 137,
  chainIdHex: "0x89",
  name: "Polygon",
  rpcUrl: "https://polygon-rpc.com",
  blockExplorerUrl: "https://polygonscan.com",
  token: "POL",
};

if (isClient) {
  const injected = injectedModule();
  init({
    wallets: [injected],
    chains: [
      {
        id: POLYGON_MAINNET.chainIdHex,
        token: POLYGON_MAINNET.token,
        label: POLYGON_MAINNET.name,
        rpcUrl: POLYGON_MAINNET.rpcUrl,
      },
    ],
    appMetadata: {
      name: "Ospex",
      icon: "<svg/>",
      description: "Open speculation exchange",
      explore: typeof window !== "undefined" ? window.location.origin : "",
      recommendedInjectedWallets: [
        { name: "MetaMask", url: "https://metamask.io" },
        { name: "Coinbase", url: "https://wallet.coinbase.com/" },
      ],
    },
    connect: {
      showSidebar: false,
      autoConnectLastWallet: true,
    },
    accountCenter: {
      desktop: { enabled: false },
      mobile: { enabled: false },
    },
  });
}

function ServerProvider({ children }: { children: ReactNode }) {
  return <Web3Context.Provider value={defaultValue}>{children}</Web3Context.Provider>;
}

function ClientProvider({ children }: { children: ReactNode }) {
  const [{ wallet }, connect, disconnect] = useConnectWallet();
  const [provider, setProvider] = useState<ethers.providers.Web3Provider | null>(null);
  const [signer, setSigner] = useState<ethers.providers.JsonRpcSigner | null>(null);
  const [chainId, setChainId] = useState<number | null>(null);

  useEffect(() => {
    const setup = async () => {
      if (!wallet?.provider) {
        setProvider(null);
        setSigner(null);
        setChainId(null);
        return;
      }

      try {
        const currentChainId = (await wallet.provider.request({ method: "eth_chainId" })) as string;
        const currentChainIdNum = parseInt(currentChainId, 16);

        if (currentChainIdNum !== POLYGON_MAINNET.chainId) {
          try {
            await wallet.provider.request({
              method: "wallet_switchEthereumChain",
              params: [{ chainId: POLYGON_MAINNET.chainIdHex }],
            });
          } catch (switchError: unknown) {
            const err = switchError as { code?: number };
            if (err.code === 4902) {
              await wallet.provider.request({
                method: "wallet_addEthereumChain",
                params: [
                  {
                    chainId: POLYGON_MAINNET.chainIdHex,
                    chainName: POLYGON_MAINNET.name,
                    nativeCurrency: {
                      name: "POL",
                      symbol: POLYGON_MAINNET.token,
                      decimals: 18,
                    },
                    rpcUrls: [POLYGON_MAINNET.rpcUrl],
                    blockExplorerUrls: [POLYGON_MAINNET.blockExplorerUrl],
                  },
                ],
              });
            }
          }
        }

        const p = new ethers.providers.Web3Provider(wallet.provider, POLYGON_MAINNET);
        p.network.ensAddress = undefined;
        setProvider(p);

        const s = p.getSigner();
        setSigner(s);

        const net = await p.getNetwork();
        if (typeof net?.chainId === "number") {
          setChainId(net.chainId);
        }
      } catch {
        setProvider(null);
        setSigner(null);
        setChainId(null);
      }
    };
    void setup();
  }, [wallet]);

  const address = useMemo(() => {
    const a = wallet?.accounts?.[0]?.address;
    return typeof a === "string" ? a : null;
  }, [wallet]);

  const ctx: Web3ContextType = {
    isConnected: Boolean(wallet),
    address,
    provider,
    signer,
    connectWallet: async () => {
      await connect();
    },
    disconnectWallet: async () => {
      if (wallet) await disconnect(wallet);
    },
    chainId,
  };

  return <Web3Context.Provider value={ctx}>{children}</Web3Context.Provider>;
}

export function Web3OnboardProvider({ children }: { children: ReactNode }) {
  if (!isClient) return <ServerProvider>{children}</ServerProvider>;
  return <ClientProvider>{children}</ClientProvider>;
}

export function useWeb3() {
  return useContext(Web3Context);
}

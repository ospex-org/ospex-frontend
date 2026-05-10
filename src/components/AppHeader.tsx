import { useNavigate } from "react-router-dom";
import { useWeb3 } from "@/lib/wallet/web3Onboard";
import { WalletDropdown } from "@/components/WalletDropdown";

type Props = {
  className?: string;
};

export function AppHeader({ className }: Props) {
  const navigate = useNavigate();
  const { isConnected, connectWallet } = useWeb3();

  return (
    <div className={"flex justify-between items-center mb-6 " + (className || "")}>
      <button
        type="button"
        onClick={() => navigate("/")}
        className="text-left cursor-pointer"
      >
        <h1 className="text-3xl font-bold mb-1">ospex</h1>
        <p className="text-muted-foreground text-sm max-[419px]:hidden">open speculation exchange</p>
      </button>

      <div className="flex items-center gap-4">
        {isConnected ? (
          <WalletDropdown />
        ) : (
          <button
            onClick={() => void connectWallet()}
            className="bg-accent hover:bg-accent/80 text-accent-foreground px-4 py-2 rounded-lg text-sm font-medium transition-colors"
          >
            Connect Wallet
          </button>
        )}
      </div>
    </div>
  );
}

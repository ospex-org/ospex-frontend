import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { LogOut, Wallet, User, Share, ChevronDown } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useWeb3 } from "@/lib/wallet/web3Onboard";

export function WalletDropdown() {
  const { address, isConnected, connectWallet, disconnectWallet } = useWeb3();
  const navigate = useNavigate();

  const short = isConnected && address ? `${address.slice(0, 6)}…${address.slice(-4)}` : "Connect";

  const goToProfile = () => {
    if (address) navigate(`/u/${address}`);
  };

  const shareProfile = () => {
    if (!address) return;
    const profileUrl = `${window.location.origin}/u/${address}`;
    navigator.clipboard.writeText(profileUrl);
    toast.success("Profile URL copied", {
      description: "The profile link has been copied to your clipboard.",
    });
  };

  if (!isConnected) {
    return (
      <Button variant="secondary" size="sm" className="gap-2" onClick={() => void connectWallet()}>
        <Wallet className="h-4 w-4" />
        {short}
      </Button>
    );
  }

  return (
    <DropdownMenu>
      <div className="flex items-center">
        <Button variant="secondary" size="sm" className="gap-2 rounded-r-none" onClick={goToProfile}>
          <Wallet className="h-4 w-4" />
          {short}
        </Button>
        <DropdownMenuTrigger asChild>
          <Button
            variant="secondary"
            size="sm"
            className="px-2 rounded-l-none border-l border-border/60"
            aria-label="Wallet menu"
          >
            <ChevronDown className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
      </div>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel>Wallet</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={goToProfile} className="gap-2">
          <User className="h-4 w-4" /> View Profile
        </DropdownMenuItem>
        <DropdownMenuItem onClick={shareProfile} className="gap-2">
          <Share className="h-4 w-4" /> Share Profile
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onClick={() => {
            void disconnectWallet();
            navigate("/");
          }}
          className="gap-2 text-destructive focus:text-destructive"
        >
          <LogOut className="h-4 w-4" /> Disconnect
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

import { BrowserRouter, Routes, Route } from "react-router-dom";
import { Toaster } from "sonner";
import { Web3OnboardProvider } from "@/lib/wallet/web3Onboard";
import Index from "./pages/Index";
import Profile from "./pages/Profile";
import NotFound from "./pages/NotFound";

export default function App() {
  return (
    <Web3OnboardProvider>
      <Toaster theme="dark" richColors position="bottom-right" />
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<Index />} />
          <Route path="/u/:address" element={<Profile />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </BrowserRouter>
    </Web3OnboardProvider>
  );
}

import { lazy, Suspense } from "react";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { Toaster } from "sonner";
import { Web3OnboardProvider } from "@/lib/wallet/web3Onboard";
import Index from "./pages/Index";
import Downloads from "./pages/Downloads";
import Profile from "./pages/Profile";
import NotFound from "./pages/NotFound";

// Only a take link needs the take page's code, so the other pages do not load it.
const Take = lazy(() => import("./pages/Take"));

export default function App() {
  return (
    <Web3OnboardProvider>
      <Toaster theme="dark" richColors position="bottom-right" />
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<Index />} />
          <Route path="/downloads" element={<Downloads />} />
          <Route path="/u/:address" element={<Profile />} />
          <Route
            path="/take/:commitmentHash"
            element={
              <Suspense fallback={null}>
                <Take />
              </Suspense>
            }
          />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </BrowserRouter>
    </Web3OnboardProvider>
  );
}

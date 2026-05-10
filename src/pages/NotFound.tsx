import { Link } from "react-router-dom";
import { AppHeader } from "@/components/AppHeader";

export default function NotFound() {
  return (
    <div className="min-h-screen bg-background p-4 md:p-6">
      <AppHeader />
      <div className="max-w-2xl mx-auto mt-8">
        <h2 className="text-2xl font-bold mb-2">404</h2>
        <p className="text-muted-foreground mb-4">that page does not exist.</p>
        <Link
          to="/"
          className="text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          &larr; back home
        </Link>
      </div>
    </div>
  );
}

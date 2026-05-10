import { AppHeader } from "@/components/AppHeader";

export default function Profile() {
  return (
    <div className="min-h-screen bg-background p-4 md:p-6">
      <AppHeader />
      <div className="max-w-2xl mx-auto mt-8">
        <h2 className="text-2xl font-bold mb-2">profile</h2>
        <p className="text-muted-foreground">there's nothing here yet.</p>
      </div>
    </div>
  );
}

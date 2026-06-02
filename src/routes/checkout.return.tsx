import { createFileRoute, Link } from "@tanstack/react-router";

export const Route = createFileRoute("/checkout/return")({
  validateSearch: (search: Record<string, unknown>): { session_id?: string } => ({
    session_id: typeof search.session_id === "string" ? search.session_id : undefined,
  }),
  head: () => ({ meta: [{ title: "Thanks — BryanTrade" }] }),
  component: ReturnPage,
});

function ReturnPage() {
  const { session_id } = Route.useSearch();
  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-4">
      <div className="max-w-md text-center space-y-4">
        <h1 className="text-3xl font-bold text-foreground">
          {session_id ? "You're in 🎉" : "Checkout"}
        </h1>
        <p className="text-muted-foreground">
          {session_id
            ? "Your subscription is active. Pro features will unlock in the terminal momentarily."
            : "No session found."}
        </p>
        <Link to="/" className="inline-block rounded bg-primary px-4 py-2 font-medium text-primary-foreground hover:bg-primary/90">
          Open the terminal
        </Link>
      </div>
    </div>
  );
}
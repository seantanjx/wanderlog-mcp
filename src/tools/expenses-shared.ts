import type { Contributor, Expense, TripPlan } from "../types.js";

/** A located expense: the live array index plus the expense object itself. */
export type ExpenseMatch = {
  index: number;
  expense: Expense;
};

/** Filters used to narrow expense matches. All are optional except via the caller. */
export type ExpenseFilters = {
  description?: string;
  date?: string;
  amount?: number;
  currency?: string;
};

/**
 * Reads `trip.itinerary.budget.expenses`, pairing each expense with its array
 * index so callers can build JSON0 list paths. Returns an empty array when the
 * trip has no budget yet.
 */
export function getExpenses(trip: TripPlan): ExpenseMatch[] {
  const expenses = trip.itinerary.budget?.expenses ?? [];
  return expenses.map((expense, index) => ({ index, expense }));
}

/**
 * Finds expenses matching a case-insensitive description substring, optionally
 * narrowed by exact date, amount, and (case-insensitive) currency filters used
 * to disambiguate duplicates. An empty/omitted description matches every
 * expense, so `list_expenses` can call with filters alone.
 */
export function findExpenseMatches(trip: TripPlan, filters: ExpenseFilters): ExpenseMatch[] {
  const description = filters.description?.toLowerCase();
  const currency = filters.currency?.toUpperCase();

  return getExpenses(trip).filter(({ expense }) => {
    if (description) {
      const desc = (expense.description ?? "").toLowerCase();
      if (!desc.includes(description)) return false;
    }
    if (filters.date && expense.date !== filters.date) return false;
    if (filters.amount !== undefined && expense.amount?.amount !== filters.amount) {
      return false;
    }
    if (currency && (expense.amount?.currencyCode ?? "").toUpperCase() !== currency) {
      return false;
    }
    return true;
  });
}

/**
 * Renders matched expenses as a numbered list for an ambiguity prompt, capped
 * at `limit` with a "(N more…)" suffix so a huge budget doesn't flood the LLM.
 */
export function formatCandidateList(matches: ExpenseMatch[], limit = 10): string {
  const lines = matches
    .slice(0, limit)
    .map((m, i) => `  ${i + 1}. ${formatExpense(m.expense)}`)
    .join("\n");
  const suffix = matches.length > limit ? `\n  (${matches.length - limit} more…)` : "";
  return `${lines}${suffix}`;
}

/** One-line human label, e.g. `USD 12.50 — Lunch at Ichiran Ramen (food, 2026-05-04)`. */
export function formatExpense(expense: Expense): string {
  const currency = expense.amount?.currencyCode ?? "?";
  const amount = expense.amount?.amount ?? "?";
  const description = expense.description?.trim() || "(no description)";
  const meta = [expense.category, expense.date].filter(Boolean).join(", ");
  const suffix = meta ? ` (${meta})` : "";
  return `${currency} ${amount} — ${description}${suffix}`;
}

type UserRef = { type?: string; id?: number; name?: string; [k: string]: unknown };

function nameLookup(trip: TripPlan): (id: number | undefined) => string {
  const people: Contributor[] = [...(trip.contributors ?? []), ...(trip.editors ?? [])];
  const byId = new Map<number, string>();
  for (const p of people) byId.set(p.id, p.name?.trim() || p.username);
  return (id) => (id !== undefined && byId.get(id)) || "an unnamed traveler";
}

function payerName(expense: Expense, nameOf: (id: number | undefined) => string): string {
  const ref = expense.paidByUser as UserRef | undefined;
  const id = typeof ref?.id === "number" ? ref.id : (expense.paidByUserId as number | undefined);
  if (ref?.type && ref.type !== "registered" && ref.name) return ref.name;
  return nameOf(id);
}

export type ExpenseSplit =
  | { type: "everyone" }
  | { type: "individuals"; count: number; people: string[] }
  | { type: "none_recorded" };

function describeSplit(expense: Expense, nameOf: (id: number | undefined) => string): ExpenseSplit {
  const split = expense.splitWith as { type?: string; users?: UserRef[] } | undefined;
  if (split?.type === "everyone") return { type: "everyone" };
  const users = split?.users ?? [];
  if (users.length === 0) return { type: "none_recorded" };
  const people = users.map((u) =>
    u.type && u.type !== "registered" && u.name ? u.name : nameOf(u.id),
  );
  return { type: "individuals", count: users.length, people };
}

export type ExpenseSummary = {
  amount: number | null;
  currency: string | null;
  description: string | null;
  category: string | null;
  date: string | null;
  paid_by: string;
  split: ExpenseSplit;
};

/** Structured expense with who paid and how it was split; names are resolved from the trip's travelers, never raw IDs. */
export function summarizeExpense(expense: Expense, trip: TripPlan): ExpenseSummary {
  const nameOf = nameLookup(trip);
  return {
    amount: expense.amount?.amount ?? null,
    currency: expense.amount?.currencyCode ?? null,
    description: expense.description?.trim() || null,
    category: expense.category ?? null,
    date: expense.date ?? null,
    paid_by: payerName(expense, nameOf),
    split: describeSplit(expense, nameOf),
  };
}

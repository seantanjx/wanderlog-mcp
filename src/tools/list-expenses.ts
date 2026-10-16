import { z } from "zod";
import type { AppContext } from "../context.js";
import { WanderlogError } from "../errors.js";
import { findExpenseMatches, summarizeExpense } from "./expenses-shared.js";

export const listExpensesInputSchema = {
  trip_key: z.string().min(1).describe("The trip whose expenses to list."),
  description: z
    .string()
    .min(1)
    .optional()
    .describe("Optional case-insensitive substring to filter by expense description."),
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD")
    .optional()
    .describe("Optional exact date filter, YYYY-MM-DD."),
  amount: z
    .number()
    .positive()
    .optional()
    .describe("Optional exact amount filter (e.g. 50, 12.50)."),
  currency: z
    .string()
    .min(3)
    .max(3)
    .optional()
    .describe("Optional ISO 4217 currency filter (e.g. 'USD'). Case-insensitive."),
};

export const listExpensesDescription = `
Lists budget expenses on a Wanderlog trip, newest entries last.

Returns a JSON object {trip, count, expenses[]}. Each expense has amount, currency, description,
category, date, paid_by (a name), and split: {type: "everyone"}, {type: "individuals", count,
people[]} (who it was split with, and among how many), or {type: "none_recorded"}. Use the optional
description / date / amount / currency filters to narrow the list — handy for finding the exact
expense to pass to wanderlog_remove_expense or wanderlog_edit_expense when several are similar.

Returns a friendly message when the trip has no matching expenses.
`.trim();

type Args = {
  trip_key: string;
  description?: string;
  date?: string;
  amount?: number;
  currency?: string;
};

export async function listExpenses(
  ctx: AppContext,
  args: Args,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    const trip = await ctx.tripCache.get(args.trip_key);
    const matches = findExpenseMatches(trip, {
      description: args.description,
      date: args.date,
      amount: args.amount,
      currency: args.currency,
    });

    if (matches.length === 0) {
      const filtered = args.description || args.date || args.amount !== undefined || args.currency;
      const text = filtered
        ? `No expenses match those filters in "${trip.title}".`
        : `No expenses logged in "${trip.title}" yet. Add one with wanderlog_add_expense.`;
      return { content: [{ type: "text", text }] };
    }

    const body = {
      trip: trip.title,
      count: matches.length,
      expenses: matches.map((m) => summarizeExpense(m.expense, trip)),
    };
    return { content: [{ type: "text", text: JSON.stringify(body, null, 2) }] };
  } catch (err) {
    const msg =
      err instanceof WanderlogError
        ? err.toUserMessage()
        : `Unexpected error: ${(err as Error).message}`;
    return { content: [{ type: "text", text: msg }], isError: true };
  }
}

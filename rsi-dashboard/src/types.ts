export const statuses = ["Not started", "In progress", "Draft", "Final"] as const;
export type Status = typeof statuses[number];
export const categories = ["essay", "letter", "form", "material", "response", "milestone"] as const;
export type Category = typeof categories[number];
export type Scope = "Required" | "Applies to you" | "Conditional" | "Optional" | "Planning";
export type Check = { id: string; label: string; optional?: boolean };
export type Entry = {
  id: string;
  category: Category;
  title: string;
  code: string;
  description: string;
  status: Status;
  scope: Scope;
  group: string;
  target: string;
  priority: number;
  action: string;
  checks: Check[];
  done: string[];
  prompt: string;
  promptSource: string;
  limit: number | null;
  draft: string;
  notes: string;
  link: string;
  parent: string;
  revision: number;
};
export type Editable = Pick<Entry, "title" | "status" | "target" | "done" | "prompt" | "limit" | "draft" | "notes" | "link">;
export type StoredEntry = { id: string; changes: Partial<Editable> & { category?: Category; scope?: Scope; group?: string }; revision: number };
export const PORTAL = "https://cee.slideroom.com/#/permalink/program/90747/";
export const DEADLINE = "2026-12-11";
export const DEADLINE_INSTANT = "2026-12-12T04:59:00Z";
export const referenceChecks: Check[] = [
  { id: "asked", label: "Ask for the recommendation" },
  { id: "agreed", label: "Confirm willingness to write" },
  { id: "invited", label: "Send or verify the SlideRoom invitation" },
  { id: "packet", label: "Share your résumé, research details and deadline" },
  { id: "followed", label: "Follow up if the letter is still outstanding", optional: true },
  { id: "received", label: "Verify receipt in SlideRoom" },
];

export function entry(category: Category, id: string, title: string, fields: Partial<Entry> = {}): Entry {
  return {
    category, id, title, code: "", description: "", status: "Not started", scope: "Required",
    group: "", target: "", action: "", priority: 4, checks: category === "letter" ? referenceChecks : [], done: [], prompt: "", promptSource: "",
    limit: null, draft: "", notes: "", link: "", parent: "", revision: 0, ...fields,
  };
}
export function applyChanges(base: Entry[], stored: StoredEntry[]): Entry[] {
  const items = new Map(base.map(item => [item.id, item]));
  for (const row of stored) {
    const original = items.get(row.id) ?? (row.changes.category && entry(row.changes.category, row.id, "", { code: "CUSTOM" }));
    if (original) items.set(row.id, { ...original, ...row.changes, revision: row.revision });
  }
  return [...items.values()];
}
export function dayInKaty(date: Date) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}
export function daysBetween(a: string, b: string) {
  return Math.round((Date.parse(b + "T12:00:00Z") - Date.parse(a + "T12:00:00Z")) / 86400000);
}
export function dateLabel(iso: string, opts?: Intl.DateTimeFormatOptions) {
  if (!iso) return "No target";
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", ...opts, timeZone: "UTC" }).format(new Date(iso + "T12:00:00Z"));
}
export function progressOf(items: Entry[]) {
  return { final: items.filter(item => item.status === "Final").length, total: items.length };
}

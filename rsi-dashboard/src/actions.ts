import { DEADLINE, daysBetween, type Entry } from "./types";

export type Action = { item: Entry; title: string; detail: string; target: string; rank: number; level: "High" | "Medium" | "Normal" };
const label: Record<Entry["category"], string> = { essay: "Essay", letter: "Recommendation", form: "Form section", material: "Material", response: "Written response", milestone: "Milestone" };
export function nextActions(items: Entry[], today: string): Action[] {
  return items.filter(item => item.status !== "Final" && !["Optional", "Conditional"].includes(item.scope)).map(item => {
    let title = item.action || "Review " + item.title;
    let detail = label[item.category] + " · " + (item.code || item.group);
    let target = item.target;
    if (item.category === "letter") {
      const has = (step: string) => item.done.includes(step);
      if (!has("asked")) title = "Contact " + item.title;
      else if (!has("agreed")) title = "Confirm " + item.title + "’s recommendation";
      else if (!has("invited")) title = "Verify " + item.title + "’s invitation";
      else if (!has("packet")) title = "Share the packet with " + item.title;
      else {
        title = (has("followed") ? "Verify receipt from " : "Check in with ") + item.title;
        target = item.target === "2026-11-04" ? (has("followed") ? "2026-12-04" : "2026-11-27") : item.target;
      }
      detail = item.group;
    }
    if (item.id === "transcript") {
      const first = item.checks.find(c => !item.done.includes(c.id));
      if (item.done.length && first) title = first.label;
      detail = "School official · Transcript";
    }
    if (item.category === "essay") {
      title = (item.status === "Draft" ? "Review " : item.status === "In progress" ? "Continue " : "Draft ") + "“" + item.title + "”";
      detail = "Personal statement · " + item.code;
    }
    const remaining = daysBetween(today, target || DEADLINE);
    const level = remaining <= 3 || (item.priority === 1 && remaining <= 7) ? "High" : remaining <= 12 || item.priority === 2 ? "Medium" : "Normal";
    const tie = item.category === "letter" && !item.done.includes("agreed") ? 0 : item.id === "transcript" ? 0.1 : item.id === "essay-fields" ? 0.2 : 0.3;
    const rank = remaining + (item.priority - 1) * 0.6 + tie;
    return { item, title, detail, target, level: level as Action["level"], rank };
  }).sort((a, b) => a.rank - b.rank || a.item.title.localeCompare(b.item.title));
}
export function overviewActions(all: Action[]) {
  const chosen: Action[] = [];
  const seen = new Set<string>();
  for (const a of all) {
    if (!seen.has(a.item.category)) { chosen.push(a); seen.add(a.item.category); }
    if (chosen.length === 3) break;
  }
  for (const a of all) {
    if (chosen.length === 3) break;
    if (!chosen.includes(a)) chosen.push(a);
  }
  return chosen;
}

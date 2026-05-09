/**
 * Built-in run-mode presets (kobramaz-a17.7).
 *
 * Each mode is a named bundle of run options that the chat composer can
 * apply as a one-click change. The active mode merges into the SubmitRun
 * fields when the user sends a message. Modes are intentionally small and
 * conservative — they're meant to nudge the agent's default disposition,
 * not replace skills/agents which live one level higher (Claude Code).
 *
 * Persisted per-workspace in localStorage keyed by workspace id so the
 * choice survives reloads. Empty values mean "don't override the API
 * default" — they don't get sent on the wire.
 */

import type { PermissionMode } from "@claudeos/runtime-client/contracts";

export interface Mode {
  /** Stable id used in localStorage and on the wire. */
  id: string;
  /** UI-visible label. Short — fits in the composer's mode pill. */
  label: string;
  /** Tooltip / description. */
  description: string;
  /** Optional system-prompt suffix prepended to every send. */
  appendSystemPrompt?: string;
  /** Optional permission mode override. */
  permissionMode?: PermissionMode;
  /** Optional model override (e.g. force Opus for plan-heavy work). */
  model?: string;
}

export const MODES: Mode[] = [
  {
    id: "default",
    label: "Default",
    description:
      "No system-prompt overrides. Use this for everyday work where you've already given enough context in the message.",
  },
  {
    id: "architect",
    label: "Architect",
    description:
      "Plan-first. The agent designs and confirms before touching files. Pairs with permission_mode=plan.",
    permissionMode: "plan",
    appendSystemPrompt: [
      "## ClaudeOS mode: Architect",
      "",
      "Before writing any code or running mutating tools, lay out a plan as a",
      "numbered list of concrete steps. State your assumptions explicitly. Wait",
      "for confirmation before executing the plan. Prefer reading + reasoning",
      "over editing in this turn.",
    ].join("\n"),
  },
  {
    id: "implement",
    label: "Implement",
    description:
      "Skip the plan-and-confirm dance. The agent writes the change directly, runs tests, fixes, repeats.",
    permissionMode: "acceptEdits",
    appendSystemPrompt: [
      "## ClaudeOS mode: Implement",
      "",
      "You're past the design phase. Make the change directly — no preamble,",
      "no plan, no confirmation requests. Edit files, run tests, iterate until",
      "the task is done. Surface decisions only when there's a real choice the",
      "user must make (not bikeshed-grade ones).",
    ].join("\n"),
  },
  {
    id: "debug",
    label: "Debug",
    description:
      "Investigate before acting. State the hypothesis, gather evidence, then propose a fix.",
    appendSystemPrompt: [
      "## ClaudeOS mode: Debug",
      "",
      "Reproduce the symptom first. Form an explicit hypothesis about the root",
      "cause, then gather evidence (read code, run probes, inspect state) to",
      "confirm or reject it. Don't apply a fix until the hypothesis is",
      "supported. If the first hypothesis fails, restate the next one — don't",
      "spray-and-pray.",
    ].join("\n"),
  },
  {
    id: "review",
    label: "Review",
    description:
      "Read-only review mode. The agent looks but doesn't edit; permission_mode=plan blocks tool side effects.",
    permissionMode: "plan",
    appendSystemPrompt: [
      "## ClaudeOS mode: Review",
      "",
      "Read-only review. Do not edit files, do not run mutating tools. Read",
      "code + history + diff, then report findings as a critique with",
      "severity-tagged bullets. The user will apply changes themselves.",
    ].join("\n"),
  },
];

export const DEFAULT_MODE_ID = "default";

export function findMode(id: string): Mode {
  return MODES.find((m) => m.id === id) ?? MODES[0];
}

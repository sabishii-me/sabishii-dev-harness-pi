/**
 * Plan mode — a pi/jouzu extension that gives a harness a plan mode it lacks
 * natively, in the shape the hub asks for: enter, leave, and read the state back.
 *
 * It is a plain pi/jouzu extension, NOT a the hub component: it knows nothing
 * about the hub. The manager drives it over the same channel a user would — the
 * `/plan` command — and reads the state back from the session log it writes.
 *
 *   - `/plan`       enter plan mode (or leave, when already in it)
 *   - `/plan off`   leave plan mode
 *   - `/plan status` report the current state
 *   - `--plan`      start in plan mode
 *
 * While plan mode is active the agent explores and proposes; it does not
 * change the tree. That restriction is this extension's own: write tools are
 * withdrawn from the active set and bash is limited to read-only commands.
 * The model is also told, through a prompt section, so it plans instead of
 * attempting edits that would be refused.
 *
 * State lives in the session log (`appendEntry`), so a resumed session comes
 * back in the same mode, exactly as a user left it.
 */
import { isSafeCommand } from "./utils.ts";

// TypeBox schemas for the one tool this extension registers. The import is
// type-only at build time and the runtime resolves it from the harness, which
// is how every shipped extension declares its parameters.
import { Type } from "typebox";

// Read-only tools keep their place; the mutating ones step aside. A tool the
// harness does not have is simply absent from the active set, so this list is
// safe across pi distributions.
const WRITE_TOOLS = ["edit", "write", "multiedit", "notebookedit", "applypatch"];
const PLAN_SECTION = [
  "You are in plan mode.",
  "",
  "Explore and design instead of changing anything. Read files, search, and run",
  "read-only commands to ground your plan in the real tree. Do not edit or write",
  "files, and do not run commands that change the working tree. Imperative",
  "language to implement changes means plan the implementation, not execute it.",
  "",
  "When the plan is ready, call exit_plan_mode with the complete plan as markdown",
  "starting with a # heading that names it. Make exit_plan_mode the only and final",
  "tool call in that response: it presents the plan for approval, and the work",
  "begins only in a later step after approval. Do not paste the final plan as a",
  "plain reply and do not ask whether to proceed in prose. If the plan is not",
  "approved, incorporate the feedback and present it again.",
].join("\n");

const STATE_ENTRY = "plan/mode";

export default function hubPlan(pi) {
  const enabled = { value: false };
  let toolsBeforePlanMode = undefined;

  pi.registerFlag("plan", {
    description: "Start in plan mode (read-only exploration)",
    type: "boolean",
    default: false,
  });

  const activeTools = () => {
    try { return pi.getActiveTools(); } catch { return undefined; }
  };
  const setActiveTools = (names) => {
    if (!Array.isArray(names)) return;
    try { pi.setActiveTools(names); } catch {}
  };

  function enterPlanTools() {
    const current = activeTools();
    if (Array.isArray(current)) {
      if (toolsBeforePlanMode === undefined) toolsBeforePlanMode = current;
      setActiveTools(current.filter((n) => !WRITE_TOOLS.includes(String(n).toLowerCase())));
    }
  }
  function leavePlanTools() {
    if (Array.isArray(toolsBeforePlanMode)) {
      setActiveTools(toolsBeforePlanMode);
      toolsBeforePlanMode = undefined;
      return;
    }
    const current = activeTools();
    if (Array.isArray(current)) {
      const restored = [...current];
      for (const t of WRITE_TOOLS) if (!restored.includes(t)) restored.push(t);
      setActiveTools(restored);
    }
  }

  function persist() {
    try { pi.appendEntry(STATE_ENTRY, { active: enabled.value }); } catch {}
  }

  function apply(next) {
    // An explicit command always records the resulting state, even when it did
    // not change: a reader asking "which mode is this session in?" must find an
    // answer in the log after it has asked, not the absence of one.
    enabled.value = next;
    if (next) enterPlanTools(); else leavePlanTools();
    persist();
    return enabled.value;
  }

  pi.registerCommand("plan", {
    description: "Enter plan mode, leave it with '/plan off'",
    handler: async (rawArgs, ctx) => {
      const arg = String(rawArgs ?? "").trim().toLowerCase();
      if (arg === "status") {
        ctx.ui?.notify?.(`plan mode is ${enabled.value ? "on" : "off"}`);
        return;
      }
      apply(arg === "off" ? false : true);
      ctx.ui?.notify?.(enabled.value ? "Plan mode on. Use /plan off to leave." : "Plan mode off.");
    },
  });

  // A plan turn must not change the tree: refuse a write command outright
  // rather than letting it run and be regretted.
  pi.on("tool_call", async (event) => {
    if (!enabled.value) return undefined;
    const name = String(event && event.toolName ? event.toolName : "").toLowerCase();
    if (WRITE_TOOLS.includes(name)) {
      return { block: true, reason: `plan mode: '${name}' is unavailable; leave plan mode to edit files` };
    }
    if (name === "bash") {
      const command = event && event.input ? event.input.command : undefined;
      if (typeof command === "string" && !isSafeCommand(command)) {
        return { block: true, reason: `plan mode: command is not read-only. Leave plan mode to run it.\nCommand: ${command}` };
      }
    }
    return undefined;
  });

  // Tell the model what mode it is in, so it plans rather than attempting the
  // edits the guard would refuse.
  pi.on("before_agent_start", async () => {
    if (!enabled.value) return undefined;
    return { message: { customType: "hub-plan", content: PLAN_SECTION } };
  });

  // The way out of plan mode: the model presents the finished plan for review.
  // An approval leaves plan mode and the plan is carried out from the next
  // step; anything else is feedback, and the model stays in plan mode to
  // revise. Registered in both modes so the tool catalog is stable across the
  // transition — calling it outside plan mode is the error, not its absence.
  pi.registerTool({
    name: "exit_plan_mode",
    description: "Present the completed plan for approval. Call this only in plan mode, with the complete plan as markdown starting with a # heading. On approval plan mode ends and the plan is carried out from your next step; otherwise you stay in plan mode and revise.",
    parameters: Type.Object({
      plan: Type.String({ description: "The complete plan, as markdown, starting with a # heading that names it." }),
    }),
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
      if (!enabled.value) {
        throw new Error("exit_plan_mode is only available in plan mode");
      }
      const plan = typeof params?.plan === "string" ? params.plan.trim() : "";
      if (!/^#\s+\S/.test(plan)) {
        throw new Error("exit_plan_mode requires a non-empty markdown plan starting with a # heading");
      }
      // Ask for the decision through the same channel every other question
      // uses. A UI that understands the intent presents it as a plan review;
      // the answer is the chosen label either way.
      const APPROVE = "Approve";
      const KEEP = "Keep planning";
      const choice = await ctx.ui.select(`Approve this plan and leave plan mode?\n\n${plan}`, [APPROVE, KEEP]);
      if (choice !== APPROVE) {
        // Staying in plan mode is the whole point of a rejection: the model
        // revises and presents again.
        throw new Error("The user chose to keep planning; revise the plan and present it again.");
      }
      apply(false);
      return { content: [{ type: "text", text: "Plan approved — plan mode exited; carry out the plan starting with your next step." }] };
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    if (pi.getFlag("plan") === true) enabled.value = true;
    // The log is the truth: a resumed session returns to the mode it left in.
    try {
      const last = ctx.sessionManager
        .getEntries()
        .filter((e) => e && e.type === "custom" && e.customType === STATE_ENTRY)
        .pop();
      if (last && last.data && typeof last.data.active === "boolean") enabled.value = last.data.active;
    } catch {}
    if (enabled.value) enterPlanTools();
    // Record the baseline so a reader can always answer "which mode is this
    // session in?" from the log, on the first ask as well as the hundredth.
    persist();
  });
}

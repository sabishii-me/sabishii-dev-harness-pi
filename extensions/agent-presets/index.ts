// agent-presets — a harness-side extension that gives a harness a preset
// mechanism it lacks natively (pi/jouzu).
//
// It is a plain pi/jouzu extension, not part of the hub: it knows nothing about
// the hub. The manager writes a preset definition file and points
// AGENT_PRESETS_CONFIG at it; this extension applies that preset:
//   - systemPrompt  → appended as a system-prompt section
//   - tools         → allow-list; a tool_call outside it is blocked
//   - approve       → ask before every tool call (the user answers in the hub)
//
// "approve" IS the approval capability: a preset that sets it makes the
// harness ask before each tool. There is no separate approval plugin and no
// approval switch — approval is a property of the preset a session selected.
//
// The definition file is JSON:
//   { "active": "<preset-id>",
//     "presets": { "<id>": { systemPrompt?, tools?[], approve? } } }
//
// When the file is absent, the extension is inert (no preset → no effect),
// so installing it without a definition changes nothing.
import fs from "node:fs";

const CONFIG_ENV = "AGENT_PRESETS_CONFIG";

function readConfig() {
  const p = process.env[CONFIG_ENV];
  if (!p) return null;
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; }
}

function activePreset() {
  const cfg = readConfig();
  if (!cfg || !cfg.active) return null;
  return (cfg.presets && cfg.presets[cfg.active]) || null;
}

export default function agentPresets(pi) {
  const preset = activePreset();
  if (!preset) {
    // No definition (or no active preset): stay inert. Nothing is claimed.
    return;
  }

  const allowed = Array.isArray(preset.tools) && preset.tools.length ? new Set(preset.tools) : null;
  const presetId = readConfig().active;

  if (typeof preset.systemPrompt === "string" && preset.systemPrompt.trim()) {
    pi.on("before_agent_start", async () => ({ systemPrompt: preset.systemPrompt }));
  }

  // The preset asks before every tool: one handler that both enforces the
  // allow-list and obtains consent, so a blocked-by-preset tool never even
  // reaches a prompt and an allowed tool is confirmed before it runs.
  //
  // `approve` is the preset's starting point, not a nail: a session that has
  // started cannot change preset, so the asking has to be switchable within the
  // session. `/review off` lets the confirm step through unanswered (the
  // allow-list still applies — that is the preset, not the review), and
  // `/review on` asks again. The switch is per session and lives in the log.
  const review = { on: preset.approve === true };
  const FIELD = "hub-review/state";

  if (allowed || preset.approve) {
    pi.on("tool_call", async (event, ctx) => {
      const name = event && event.toolName;
      if (typeof name === "string" && name && allowed && !allowed.has(name)) {
        return { block: true, reason: `tool '${name}' is not enabled in preset '${presetId}'` };
      }
      if (preset.approve && review.on) {
        const title = "Permission Required";
        const message = `Allow ${name}?`;
        const ok = await ctx.ui.confirm(title, message);
        if (!ok) return { block: true, reason: `tool '${name}' was not approved` };
      }
    });
  }

  // The runtime switch. Registered only for a preset that asks at all, so a
  // preset without review neither asks nor advertises a switch for it.
  if (preset.approve) {
    pi.registerCommand("review", {
      description: "Ask before every tool call, or stop asking with '/review off'",
      handler: async (rawArgs, ctx) => {
        const arg = String(rawArgs ?? "").trim().toLowerCase();
        if (arg === "" || arg === "status") {
          ctx.ui?.notify?.(`review is ${review.on ? "on" : "off"}`);
          return;
        }
        if (arg !== "on" && arg !== "off") {
          ctx.ui?.notify?.(`unknown argument "${arg}" (use on, off, or status)`);
          return;
        }
        review.on = arg === "on";
        pi.appendEntry(FIELD, { asking: review.on });
        ctx.ui?.notify?.(`review ${review.on ? "on" : "off"}`);
      },
    });
  }

  // A resumed session comes back in the mode it left in: the newest record wins.
  pi.on("session_start", async (_event, ctx) => {
    if (!preset.approve) return;
    try {
      const last = ctx.sessionManager
        .getEntries()
        .filter((e) => e && e.type === "custom" && e.customType === FIELD)
        .pop();
      if (last && last.data && typeof last.data.asking === "boolean") review.on = last.data.asking;
    } catch {}
  });
}

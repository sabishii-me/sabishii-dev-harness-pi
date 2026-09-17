#!/usr/bin/env node
'use strict';
// pi agent adapter — the ONLY place in the shell that knows pi exists.
//
// Speaks the bus protocol (JSON-RPC 2.0 over LF stdio) toward the core and
// pi's own JSONL protocol toward a spawned pi subprocess (`--mode rpc`).
// Contract with the core:
//   - session/start opens (or resumes) a pi session and reports the live
//     session file as result.ref, plus a get_state summary (zero LLM calls).
//   - an unusable resume reference FAILS the request — never a soft new
//     session.
//   - confirm dialogs become approval_need requests; an unanswered deadline
//     is denied by the core (fail closed) and forwarded as confirmed:false.
//   - other dialogs (select/input/editor) are auto-cancelled so pi never
//     hangs on a UI nobody renders.
//   - when pi's stream ends the adapter exits — the core must see EOF, not
//     a dangling process. When the core dies (stdin closes), the adapter
//     kills pi and exits.

const { spawn, spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// This plugin's own directory: the manifest's relative runtime paths are read
// from here, so they mean "inside this plugin" regardless of where the host
// happened to spawn the adapter from.
const PLUGIN_DIR = __dirname;

// The core hands each agent a scratch dir via PRTS_AGENT_DATA_DIR; session
// records go there and nowhere else. No fallback: runtime data must never
// land next to the plugin code (which may live in a watched source tree).
// Without the variable the adapter refuses to open sessions (fail closed).
const SESSIONS_DIR = process.env.PRTS_AGENT_DATA_DIR
  ? path.join(process.env.PRTS_AGENT_DATA_DIR, 'sessions')
  : null;

// --- core-surface transcript (PROTOCOL §2): adapter-owned history truth ---
// Keyed by session ref; ids are ours and stable across restart/resume. The
// harness's own session file is NOT the history source — this file is.
const TRANSCRIPT_DIR = process.env.PRTS_AGENT_DATA_DIR
  ? path.join(process.env.PRTS_AGENT_DATA_DIR, 'transcripts')
  : null;
let currentRef = null;
let liveMessage = null; // { id, text } while an assistant message streams
let configuredModel = null;
// Core-owned provider, received via credentials/grant. {url, token, model?}
// When present the adapter MUST run pi against it; if it cannot, it fails loud
// rather than silently falling back to the user's own ~/.pi providers.
let granted = null;

// --- shipped agent-presets (the hub-supplied) ----------------------------------
// pi has no native preset mechanism. the hub ships a set of presets next to its
// extensions and, when a session names one, the adapter (a) installs the
// agent-presets extension into the workspace and (b) writes the definition the
// extension reads. Ids are opaque to the consumer; content never crosses the
// wire.
const PRESETS_DIR = process.env.PRTS_PRESETS_DIR || null;
// Extra roots the caller asked for (ACP calls these additionalDirectories). The
// core passes them through; pi has no CLI surface for additional roots, so they
// are recorded and reported rather than silently dropped.
const ADDITIONAL_DIRS = JSON.parse(process.env.PRTS_ADDITIONAL_DIRS || '[]');   // extra roots the core passed through
// The hub installed this harness's extensions: it selected them from its
// registry and wrote them into this harness's data dir. The adapter places from
// there into the layout the harness reads — it never decides what to install, so
// adding an extension to a harness is a registry change, not a code change here.
// Which directory name an extension takes in the workspace is the harness's own
// rule, so that mapping lives here.
const INSTALLED_EXT_DIR = process.env.PRTS_INSTALLED_EXTENSIONS_DIR || null;
const EXT_DEST = { 'agent-presets': 'agent-presets', plan: 'prts-plan' };
function copyTree(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const name of fs.readdirSync(src)) {
    const from = path.join(src, name);
    const to = path.join(dst, name);
    if (fs.statSync(from).isDirectory()) copyTree(from, to);
    else fs.copyFileSync(from, to);
  }
}
function placeExtension(id, cwd) {
  const dest = EXT_DEST[id];
  const src = INSTALLED_EXT_DIR ? path.join(INSTALLED_EXT_DIR, id) : null;
  if (!src || !dest || !cwd || !fs.existsSync(src)) return false;
  copyTree(src, path.join(cwd, '.pi', 'extensions', dest));
  return true;
}
let activePresetId = null;
let planActive = null;    // the plan state this adapter last reported (null = not yet known)
let lastTitle = null;     // the session name this adapter last reported to the hub
function listShippedPresets() {
  if (!PRESETS_DIR || !fs.existsSync(PRESETS_DIR)) return [];
  const out = [];
  for (const f of fs.readdirSync(PRESETS_DIR)) {
    if (!f.endsWith('.json')) continue;
    try {
      const j = JSON.parse(fs.readFileSync(path.join(PRESETS_DIR, f), 'utf8'));
      if (j && typeof j.id === 'string') out.push({ id: j.id, name: j.name != null ? j.name : null, description: j.description != null ? j.description : null, trust: 'system', isDefault: false, broken: null });
    } catch { /* skip unparsable */ }
  }
  return out;
}
// The hub installed agent-presets for this harness; put it where pi looks. Not
// installed = not placed, which is how removing it from the registry takes
// effect.
function installAgentPresetsExt(cwd) { return placeExtension('agent-presets', cwd); }
function writeActivePreset(cwd, presetId) {
  // Build {active, presets:{id:{systemPrompt,tools}}} from shipped definitions
  // and drop it where the extension reads it (AGENT_PRESETS_CONFIG).
  const definitionsPath = path.join(cwd, '.pi', 'agent-presets.json');
  const cfg = { active: presetId || null, presets: {} };
  if (presetId && PRESETS_DIR) {
    const src = path.join(PRESETS_DIR, `${presetId}.json`);
    if (fs.existsSync(src)) {
      const j = JSON.parse(fs.readFileSync(src, 'utf8'));
      cfg.presets[presetId] = { systemPrompt: j.systemPrompt, tools: j.tools, ...(j.approve ? { approve: true } : {}) };
    }
  }
  fs.mkdirSync(path.dirname(definitionsPath), { recursive: true });
  fs.writeFileSync(definitionsPath, JSON.stringify(cfg));
  return definitionsPath;
}

// --- plan mode (session-scoped capability) -----------------------------------
// pi has no native plan mode, so the hub ships one as an extension and installs
// it into the workspace for the session. The adapter drives it the same way a
// user would — the `/plan` command — and reads the state back from the session
// log the extension writes, so nothing here needs a private side channel.
function installPlanExt(cwd) { return placeExtension('plan', cwd); }

// Drive the plan command over pi's rpc. An extension command runs through
// `prompt` (it is not queued, and it produces no model turn of its own), which
// is the same path a user typing `/plan` takes. The reply reports the state the
// session log actually holds afterwards, so a command that did not land shows
// up as null instead of echoing the request back as success.
function planCommand(active, cb) {
  if (!pi) { cb(null); return; }
  piRequest({ type: 'prompt', message: active ? '/plan' : '/plan off' })
    .then((r) => {
      if (!r || r.success === false) { cb(null); return; }
      readPlanState(cb);
    })
    .catch(() => cb(null));
}

// Read the plan state back from the session log (the extension appends
// `plan/mode` there). This is the capability's read half: a harness that
// accepted the toggle but never recorded it reports null, not a claim.
function readPlanState(cb) {
  if (!pi) { cb(null); return; }
  piRequest({ type: 'get_entries' })
    .then((r) => {
      const entries = (r && r.data && Array.isArray(r.data.entries)) ? r.data.entries : [];
      const last = entries.filter((e) => e && e.customType === 'plan/mode').pop();
      cb(last && last.data && typeof last.data.active === 'boolean' ? last.data.active : null);
    })
    .catch(() => cb(null));
}

// Drive the review switch over pi's rpc — the extension owns the state, this
// only asks it to change and reads back what the log then says. A just-restarted
// pi takes a moment to accept requests, so a failed send is retried briefly
// before giving up: the switch is a control action, and reporting "no capability"
// because the harness was still booting would be wrong.
function reviewCommand(on, cb) {
  // cb(state): a boolean we OBSERVED, or 'unknown' when we could not observe one
  // (no harness, a refusal, or the retries ran out). 'unknown' must never be
  // reported to the caller as the value that was requested.
  if (!pi) { cb('unknown'); return; }
  let tries = 0;
  const attempt = () => {
    if (!pi) { cb('unknown'); return; }
    piRequest({ type: 'prompt', message: on ? '/review on' : '/review off' })
      .then((r) => {
        if (!r || r.success === false) {
          if (r && r.error) { cb('unknown'); return; }   // a real refusal, not a boot race
          if (tries++ < 20) { setTimeout(attempt, 250); return; }
          cb('unknown'); return;
        }
        readReviewState(cb);
      })
      .catch(() => {
        if (tries++ < 20) { setTimeout(attempt, 250); return; }
        cb('unknown');
      });
  };
  attempt();
}


function readReviewState(cb) {
  if (!pi) { cb(null); return; }
  piRequest({ type: 'get_entries' })
    .then((r) => {
      const entries = (r && r.data && Array.isArray(r.data.entries)) ? r.data.entries : [];
      const last = entries.filter((e) => e && e.customType === 'prts-review/state').pop();
      cb(last && last.data && typeof last.data.asking === 'boolean' ? last.data.asking : null);
    })
    .catch(() => cb(null));
}
function transcriptPath(ref) {
  // A stable, collision-free key for one session's transcript. It used to be
  // Buffer.from(ref).toString('hex').slice(0, 80) - the first 40 BYTES of the
  // ref - which is not a hash: every session of one harness shares the
  // sessions/ directory, so every ref shares that prefix and they all mapped
  // to ONE file. Different sessions then read and appended each other's
  // history. A full digest is the fix; the ref itself is the identity.
  return path.join(TRANSCRIPT_DIR, crypto.createHash('sha256').update(String(ref)).digest('hex') + '.json');
}
// The transcript is this adapter's own record of a conversation IT took part in.
// A forked session's history was written by nobody here: pi copied the source's
// prefix into a new file and this process adopted it. The harness log is then the
// only source, and an empty page would tell the caller the child has no history
// when pi says it has one. So with no transcript for this ref, import pi's own
// messages once (their own ids, stable) and persist them.
async function ensureTranscript(ref) {
  if (!TRANSCRIPT_DIR || !ref) return;
  if (fs.existsSync(transcriptPath(ref))) return;
  const r = await piRequest({ type: 'get_messages' });
  const messages = (r && r.data && Array.isArray(r.data.messages)) ? r.data.messages : [];
  const entries = [];
  for (const m of messages) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant')) continue;
    const blocks = Array.isArray(m.content) ? m.content : [];
    const text = blocks.filter((c) => c && typeof c.text === 'string').map((c) => c.text).join('');
    if (!text) continue;
    const id = (typeof m.id === 'string' && m.id) || (m.role === 'user' ? 'u-' : 'a-') + entries.length;
    entries.push({ id, role: m.role, text, complete: true, inherited: true });
  }
  if (!entries.length) return;
  fs.mkdirSync(TRANSCRIPT_DIR, { recursive: true });
  fs.writeFileSync(transcriptPath(ref), JSON.stringify(entries));
  process.stderr.write(`[adapter] inherited ${entries.length} message(s) from the harness log into the transcript
`);
}

function loadTranscript(ref) {
  try { return JSON.parse(fs.readFileSync(transcriptPath(ref), 'utf8')); } catch { return []; }
}
function saveTranscript() {
  if (!TRANSCRIPT_DIR) return;
  fs.mkdirSync(TRANSCRIPT_DIR, { recursive: true });
  fs.writeFileSync(transcriptPath(currentRef), JSON.stringify(loadTranscript(currentRef)));
}
function appendTranscript(entry) {
  if (!TRANSCRIPT_DIR) return;
  fs.mkdirSync(TRANSCRIPT_DIR, { recursive: true });
  const entries = loadTranscript(currentRef);
  if (!entries.some((e) => e.id === entry.id)) entries.push(entry);
  fs.writeFileSync(transcriptPath(currentRef), JSON.stringify(entries));
}

function die(message) {
  process.stderr.write(`[pi-adapter] fatal: ${message}\n`);
  process.exit(2);
}

// --- the runtime this plugin drives -----------------------------------------
// The manifest declares it; the host hands the declaration over as argv. Nothing
// is looked up here: there is no system install to fall back to and no version
// to discover, so the pin the manifest states is the version that runs. The
// plugin owns its runtime, which is why a relative path means "next to this
// adapter" rather than "anywhere on the machine".
function resolvePi() {
  const raw = process.env.PRTS_RUNTIME_COMMAND;
  if (!raw) die('the host did not declare a runtime for this plugin (PRTS_RUNTIME_COMMAND missing)');
  let argv;
  try { argv = JSON.parse(raw); } catch { die('PRTS_RUNTIME_COMMAND is not valid JSON'); }
  if (!Array.isArray(argv) || !argv.length) die('PRTS_RUNTIME_COMMAND must be a non-empty argv array');
  const [cmd, ...args] = argv;
  // cmd may be a bare executable name (resolved through PATH by spawn), so only
  // a path-looking cmd is checked. Every argument is resolved against the
  // plugin's own directory: the manifest's relative paths therefore mean
  // "inside this plugin", wherever the host ran the adapter from.
  if (path.isAbsolute(cmd) && !fs.existsSync(cmd)) die(`runtime entry not found: ${cmd}`);
  const resolvedArgs = args.map((a) => (path.isAbsolute(a) ? a : path.resolve(PLUGIN_DIR, a)));
  if (resolvedArgs.length && !fs.existsSync(resolvedArgs[0])) die(`runtime script not found: ${resolvedArgs[0]}`);
  return { cmd, args: resolvedArgs };
}

// --- bus framing -------------------------------------------------------------
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (line.trim()) handleBusMessage(JSON.parse(line));
  }
});
process.stdin.on('end', shutdown);
process.on('uncaughtException', (e) => { process.stderr.write(`[pi-adapter] uncaught: ${e.stack}\n`); shutdown(); });

function send(o) { process.stdout.write(JSON.stringify(o) + '\n'); }

// --- pi subprocess ------------------------------------------------------------
let pi = null;            // ChildProcess
let sid = null;           // bus session id
let nextBusId = 1;        // ids the adapter picks when talking to pi
const pendingPi = new Map();     // pi response id → resolver
// pi's own level names, used only to NAME the levels a model declared. The core
// reports where a list came from (thinkingLevelsSource); an adapter's job is to
// say what the harness said, not to decide which levels are usable. A model
// whose declaration carries no level map has declared nothing, so nothing is
// reported for it and the core answers 'default' — the harness still has a
// default, the adapter simply does not know it and must not invent one.
const PI_THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

// A model's DECLARED levels, per its own thinkingLevelMap: a mapped null removes
// a level, `xhigh`/`max` exist only when the map names them, everything else is
// offered unless removed. No map at all = nothing declared = null (absence).
function declaredThinkingLevels(m) {
  if (m.reasoning !== true) return null;
  const map = m.thinkingLevelMap;
  if (!map || typeof map !== 'object') return null;
  return PI_THINKING_LEVELS.filter((level) => {
    const mapped = map[level];
    if (mapped === null) return false;
    if (level === 'xhigh' || level === 'max') return mapped !== undefined;
    return true;
  });
}
const pendingApprovals = new Map(); // pi extension_ui_request id → resolver (confirm)
const pendingQuestions = new Map(); // pi extension_ui_request id → resolver (select)
// pi expresses "Reject with Reason" as TWO dialogs: a select, then an input for
// the text. the hub answers both in ONE round-trip (the UI supplies choice+reason
// together). So when the core returns a reason with a Reject-with-Reason
// choice, park it here and hand it to the input that pi raises next.
let pendingReasonReply = null;   // text to answer pi's follow-up input with

// --- injected the hub provider (J-2) -------------------------------------------
// When the core grants {url, value}, synthesize a pi provider entry pointing at
// the hub url with apiKey as an env reference (${ENV}) — the token stays in the
// pi subprocess env and never touches a file. The entry lives in a private copy
// of the agent dir (PI_CODING_AGENT_DIR) that carries the user's own config
// forward, so nothing the user configured is lost and no user file is mutated.
let injectedDir = null;
let injectedEnvName = null;
let injectedModels = [];
// What the hub knows about each model of the provider it injected: the display
// name (its own, the provider catalog's, or the id), the modalities, the
// thinking levels, the window. A provider's model list carries none of it, so
// the hub — which owns the declaration and the fetched catalog — is the one that
// resolves it; this adapter translates the result into pi's own spelling.
let injectedFacts = [];
function modelDecl(id) { return injectedFacts.find((m) => m && m.id === id) || null; }
// A provider the core injects is named the same in every harness: `prts-<id>`.
// The slash an earlier version used is not usable here — pi splits a model
// reference on the FIRST slash, so a provider id containing one resolves to the
// wrong model — and a name that differs per harness would leave a caller unable
// to tell which provider a catalog entry belongs to. One spelling, no slash.
const INJECT_PREFIX = 'prts-';

function probeModels(url, value) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch { return reject(new Error('invalid provider url: ' + url)); }
    const mod = u.protocol === 'https:' ? require('https') : require('http');
    const base = u.pathname.replace(/\/$/, '');
    const req = mod.request({ method: 'GET', hostname: u.hostname, port: u.port || undefined, path: base + '/models', headers: { authorization: 'Bearer ' + value }, timeout: 15000 }, (res2) => {
      let b = '';
      res2.setEncoding('utf8');
      res2.on('data', (d) => { b += d; });
      res2.on('end', () => {
        if (res2.statusCode < 200 || res2.statusCode >= 300) return reject(new Error(`provider ${url} /models -> ${res2.statusCode}`));
        let j; try { j = JSON.parse(b); } catch { return reject(new Error('provider /models is not JSON')); }
        const list = Array.isArray(j.data) ? j.data : Array.isArray(j.models) ? j.models : null;
        if (!list) return reject(new Error('provider /models has no model array'));
        resolve(list.map((m) => (typeof m === 'string' ? m : m.id)).filter(Boolean));
      });
    });
    req.on('timeout', () => req.destroy(new Error('provider /models timed out')));
    req.on('error', reject);
    req.end();
  });
}

function buildInjectedDir() {
  const base = piAgentDir();
  const dir = path.join(SESSIONS_DIR, 'injected-' + (granted.connectionId || 'provider').replace(/[^A-Za-z0-9_.-]/g, '_'));
  fs.mkdirSync(dir, { recursive: true });
  for (const f of ['models.json', 'auth.json', 'models-store.json', 'settings.json']) {
    const src = path.join(base, f);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(dir, f));
  }
  return dir;
}

// pi's thinkingLevelMap is a mapping, not a list: a level appears only if the
// map names the level pi would send for it. The declared efforts are the levels
// the model accepts, so each one maps to itself and the rest stay absent — a
// model that declares no effort gets no map, which is what makes pi treat it as
// having no levels to offer rather than offering the wrong ones.
function thinkingLevelMapFor(decl) {
  const efforts = decl && decl.reasoning && Array.isArray(decl.reasoning.efforts) ? decl.reasoning.efforts : null;
  if (!efforts || !efforts.length) return null;
  const map = {};
  for (const level of efforts) map[level] = level;
  return map;
}

function applyInjectedProvider(dir, modelIds) {
  const p = path.join(dir, 'models.json');
  const cfg = readJsonFile(p) || {};
  cfg.providers = cfg.providers || {};
  const pid = INJECT_PREFIX + String(granted.connectionId || 'provider');
  cfg.providers[pid] = {
    baseUrl: granted.url,
    api: granted.api || 'openai-completions',
    apiKey: '${' + injectedEnvName + '}',
    models: modelIds.map((id) => {
      const decl = modelDecl(id);
      const map = thinkingLevelMapFor(decl);
      // The modality comes from the declaration. A model that was not declared
      // as taking images is not advertised as taking them — a claim the model
      // cannot honour ends up as an input silently dropped at runtime.
      const input = Array.isArray(decl?.input) && decl.input.length ? decl.input : ['text'];
      return {
        id, name: (decl && decl.name) || id, input,
        ...(decl && decl.cost ? { cost: decl.cost } : {}),
        // The window is what makes `contextUsage` possible at all; a declared
        // limit is passed on, and an undeclared one stays absent so pi reports
        // no percentage rather than one computed against a made-up window.
        ...(decl && decl.contextWindow ? { contextWindow: decl.contextWindow } : {}),
        ...(decl && decl.maxTokens ? { maxTokens: decl.maxTokens } : {}),
        ...(map ? { reasoning: true, thinkingLevelMap: map } : {}),
      };
    }),
  };
  fs.writeFileSync(p, JSON.stringify(cfg, null, 2));
}

function startPi(resumeRef) {
  if (!SESSIONS_DIR) {
    die('PRTS_AGENT_DATA_DIR not set: the core must provide a data dir; refusing to write runtime data next to plugin code');
  }
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  const ref = resumeRef || path.join(SESSIONS_DIR, `session-${Date.now()}-${process.pid}.jsonl`);
  // --approve: trust the user's own project so its project-local resources
  // (.pi/extensions, skills, prompts) load and become active. This is NOT a
  // bypass of approvals: it only lets the project's own extensions load; those
  // extensions then run their normal gating (the approval path we test).
  const args = [...piRuntime.args, '--mode', 'rpc', '--session', ref, '--session-dir', SESSIONS_DIR, '--approve'];
  // Skills: the hub installs them into a directory of its own and hands it over.
  // `--no-skills` turns OFF pi's own discovery, so a managed session sees exactly what
  // the hub installed — not the user's ~/.agents/skills (isolation) — and `--skill`
  // adds the hub's directory back (it is additive even with --no-skills).
  if (process.env.PRTS_INSTALLED_SKILLS_DIR) args.push('--no-skills', '--skill', process.env.PRTS_INSTALLED_SKILLS_DIR);
  const env = { ...process.env };
  // A session preset: ensure the agent-presets extension is installed in the
  // workspace and hand the extension the definition file it reads.
  if (activePresetId !== null) {
    const wcwd = process.env.PRTS_CWD || undefined;
    if (wcwd) {
      installAgentPresetsExt(wcwd);
      env.AGENT_PRESETS_CONFIG = writeActivePreset(wcwd, activePresetId);
    }
  }
  // Plan mode's extension travels with the session's workspace too, so a
  // `/plan` from the core has something to run against.
  if (process.env.PRTS_CWD) installPlanExt(process.env.PRTS_CWD);
  // J-2: inject the hub-managed provider into a private agent dir.
  if (granted && granted.url && granted.value) {
    if (!injectedEnvName) injectedEnvName = 'PRTS_INJECTED_' + String(granted.connectionId || 'PROVIDER').replace(/[^A-Za-z0-9]/g, '_').toUpperCase() + '_API_KEY';
    env[injectedEnvName] = granted.value;
    injectedDir = injectedDir || buildInjectedDir();
    env.PI_CODING_AGENT_DIR = injectedDir;
  }
  // The core hands the user project dir via PRTS_CWD; run pi there so its
  // file/command tools act on the user's project, not the plugin directory.
  const cwd = process.env.PRTS_CWD || undefined;
  harnessUp = null; harnessUpResolve = null;   // a new child is a new readiness question
  pi = spawn(piRuntime.cmd, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'inherit'], env, ...(cwd ? { cwd } : {}) });
  // pi's stderr is inherited from this adapter, so the core logs it; nothing
  // to drain here (child.stderr is null under 'inherit').
  let pbuf = '';
  pi.stdout.setEncoding('utf8');
  pi.stdout.on('data', (d) => {
    pbuf += d;
    let i;
    while ((i = pbuf.indexOf('\n')) >= 0) {
      const line = pbuf.slice(0, i); pbuf = pbuf.slice(i + 1);
      if (!line.trim()) continue;
      let msg; try { msg = JSON.parse(line); } catch { continue; }
      handlePiMessage(msg);
    }
  });
  currentRef = ref;
  const child = pi; // capture: an exit from a LATER (restarted) child must not act
  child.on('exit', (code) => {
    // Ignore an exit from a superseded child (we killed it to restart with a
    // newly granted provider/model). Only the CURRENT pi ending tears us down.
    if (pi !== child) return;
    // pi is gone: fail everything in flight, then leave. The core must see
    // EOF, not a dangling adapter.
    for (const [, resolve] of pendingPi) resolve(null);
    pendingPi.clear();
    if (sid) process.stderr.write(`[pi-adapter] pi exited code=${code}\n`);
    process.exit(code == null ? 1 : 0);
  });
  return ref;
}

function piRequest(body) {
  return new Promise((resolve) => {
    const id = `prts-${nextBusId++}`;
    body.id = id;
    pendingPi.set(id, resolve);
    pi.stdin.write(JSON.stringify(body) + '\n');
  });
}

function handlePiMessage(msg) {
  // First word from the harness: it is up (see harnessUpProof).
  if (harnessUpResolve) { const resolve = harnessUpResolve; harnessUpResolve = null; resolve(); }
  process.stderr.write(`[adapter] <-pi ${msg.type}${msg.command ? ':' + msg.command : ''}${msg.event ? ':' + (msg.event.type || '') : ''}${msg.error ? ' ERR=' + JSON.stringify(msg.error).slice(0, 120) : ''}\n`);
  if (msg.type === 'response') {
    const resolve = pendingPi.get(msg.id);
    if (resolve) { pendingPi.delete(msg.id); resolve(msg); }
    return;
  }
  if (msg.type === 'extension_ui_request') {
    const reqId = msg.id;
    if (msg.method === 'confirm') {
      // Map to the bus approval: the core answers {approved}, deadline-denied.
      pendingApprovals.set(reqId, (ans) => {
        pi.stdin.write(JSON.stringify({ type: 'extension_ui_response', id: reqId, confirmed: ans.approved === true }) + '\n');
      });
      send({
        jsonrpc: '2.0', id: `appr-${reqId}`, method: 'approval_need',
        params: {
          kind: 'confirm',
          // pi's rpc dialog fields sit at the TOP level (rpc-mode emits
          // { method, title, message }), not under `params`. Read both shapes.
          detail: `${msg.title ?? msg.params?.title ?? ''} ${msg.message ?? msg.params?.message ?? ''}`.trim(),
          pi_request_id: reqId,
        },
      });
    } else if (msg.method === 'select') {
      // A select is a QUESTION, not an approval: it offers options and the
      // answer is the chosen one. pi's `confirm` is the yes/no shape an
      // approval carries, and pi's rpc gives no other discriminator — so the
      // method is the boundary. Fields sit at the TOP level of the request
      // (msg.title / msg.options), not under params.
      const opts = Array.isArray(msg.options) ? msg.options : [];
      const detail = String(msg.title ?? '').trim();
      pendingQuestions.set(reqId, (ans) => {
        const first = ans && Array.isArray(ans.answers) ? ans.answers[0] : undefined;
        const chosen = first && Array.isArray(first.selected) ? first.selected[0] : undefined;
        if (typeof chosen === 'string' && opts.includes(chosen)) {
          pi.stdin.write(JSON.stringify({ type: 'extension_ui_response', id: reqId, value: chosen }) + '\n');
        } else {
          // No usable choice: cancel, so pi never hangs on a dialog nobody answered.
          pi.stdin.write(JSON.stringify({ type: 'extension_ui_response', id: reqId, cancelled: true }) + '\n');
        }
      });
      send({
        jsonrpc: '2.0', id: `q-${reqId}`, method: 'question_need',
        params: {
          sid,
          question_id: reqId,
          questions: [{
            id: 'select',
            header: null,
            question: detail || 'Choose one.',
            detail: null,
            options: opts.map((label) => ({ label: String(label), description: null })),
            multiSelect: false,
            intent: null,
          }],
        },
      });
    } else if (msg.method === 'input') {
      // pi's follow-up input. If the core supplied a rejection reason for the
      // preceding Reject-with-Reason select, answer with it; otherwise this is
      // an unrendered dialog and we must not let pi hang → auto-cancel.
      if (pendingReasonReply !== null) {
        pi.stdin.write(JSON.stringify({ type: 'extension_ui_response', id: reqId, value: pendingReasonReply }) + '\n');
        pendingReasonReply = null;
        process.stderr.write('[pi-adapter] answered reason input from core comment\n');
      } else {
        pi.stdin.write(JSON.stringify({ type: 'extension_ui_response', id: reqId, cancelled: true }) + '\n');
        process.stderr.write(`[pi-adapter] auto-cancelled dialog method=${msg.method}\n`);
      }
    } else if (msg.method === 'editor') {
      // Auto-cancel: the agent must never hang on a dialog nobody renders.
      pi.stdin.write(JSON.stringify({ type: 'extension_ui_response', id: reqId, cancelled: true }) + '\n');
      process.stderr.write(`[pi-adapter] auto-cancelled dialog method=${msg.method}\n`);
    }
    return;
  }
  // Everything else is an agent event → translate into the hub event
  // contract (v0). The contract is shell-owned, NOT pi's native dialect:
  // pi upgrades that rename events must surface here, not in the UI.
  // Contract: text_delta / reasoning_delta / message_end / tool_started /
  // tool_end / turn_started / turn_end. Anything else is dropped.
  const ev = msg;
  if (ev.type === 'agent_start') {
    send({ jsonrpc: '2.0', method: 'event', params: { sid, data: { type: 'turn_started' } } });
    return;
  }
  if (ev.type === 'message_update') {
    const ama = ev.assistantMessageEvent || {};
    if (ama.type === 'text_delta' && typeof ama.delta === 'string') {
      if (!liveMessage) liveMessage = { id: 'a-' + crypto.randomUUID(), text: '' };
      liveMessage.text += ama.delta;
      send({ jsonrpc: '2.0', method: 'event', params: { sid, data: { type: 'text_delta', messageId: liveMessage.id, text: ama.delta } } });
    } else if (ama.type === 'thinking_delta' && typeof ama.delta === 'string') {
      if (!liveMessage) liveMessage = { id: 'a-' + crypto.randomUUID(), text: '' };
      send({ jsonrpc: '2.0', method: 'event', params: { sid, data: { type: 'reasoning_delta', messageId: liveMessage.id, text: ama.delta } } });
    }
    return;
  }
  if (ev.type === 'message_end') {
    const m = ev.message || {};
    if (m.role === 'assistant') {
      const text = (m.content || []).filter((c) => c && c.type === 'text').map((c) => c.text || '').join('') || (liveMessage ? liveMessage.text : '');
      const messageId = (liveMessage && liveMessage.id) || 'a-' + crypto.randomUUID();
      liveMessage = null;
      appendTranscript({ id: messageId, role: 'assistant', text, complete: true });
      send({ jsonrpc: '2.0', method: 'event', params: { sid, data: { type: 'message_end', messageId, role: 'assistant', text } } });
    }
    return;
  }
  if (ev.type === 'tool_execution_start') {
    const args = ev.args;
    const detail = typeof args?.command === 'string' ? args.command : JSON.stringify(args ?? {}).slice(0, 120);
    send({ jsonrpc: '2.0', method: 'event', params: { sid, data: { type: 'tool_started', tool: ev.toolName ?? '', toolCallId: ev.toolCallId ?? null, detail } } });
    return;
  }
  if (ev.type === 'tool_execution_end') {
    const ok = ev.isError !== true;
    const result = typeof ev.result === 'string' ? ev.result : (ev.result === undefined ? '' : JSON.stringify(ev.result));
    send({ jsonrpc: '2.0', method: 'event', params: { sid, data: { type: 'tool_end', tool: ev.toolName ?? '', toolCallId: ev.toolCallId ?? null, detail: result.slice(0, 400), ok } } });
    return;
  }
  if (ev.type === 'session_info_changed') {
    // pi renames a session on its own (its UI can, and so can an extension).
    // Reported, so a hub that holds the old name follows the harness instead of
    // showing a title the session no longer has.
    const held = typeof ev.name === 'string' && ev.name ? ev.name : null;
    if (held !== lastTitle) {
      lastTitle = held;
      send({ jsonrpc: '2.0', method: 'event', params: { sid, data: { type: 'title_changed', title: held } } });
    }
    return;
  }
  if (ev.type === 'compaction_start') {
    // The harness compacts when it decides to (threshold, overflow) as well as
    // when asked; both are reported, because a caller watching the stream must
    // not go quiet while the agent rewrites its own context.
    send({ jsonrpc: '2.0', method: 'event', params: { sid, data: { type: 'compaction_started', reason: ev.reason || null } } });
    return;
  }
  if (ev.type === 'compaction_end') {
    const r = ev.result || null;
    const data = {
      type: 'compaction_ended',
      reason: ev.reason || null,
      aborted: ev.aborted === true,
      willRetry: ev.willRetry === true,
    };
    if (r) {
      if (typeof r.tokensBefore === 'number') data.tokensBefore = r.tokensBefore;
      // pi's own name for this number is `estimatedTokensAfter`: a heuristic over
      // the rebuilt context, not a provider count. Kept as tokensAfter with the
      // contract stating whose number it is, so the shape is one shape.
      if (typeof r.estimatedTokensAfter === 'number') data.tokensAfter = r.estimatedTokensAfter;
      if (typeof r.summary === 'string') data.summary = r.summary;
      if (r.usage) data.usage = r.usage;
    }
    // A compaction that came back with no result is a compaction that failed,
    // and pi says why in errorMessage. Dropping it reported the failure as a
    // quiet end with no numbers — the reader could not tell it from a no-op.
    if (typeof ev.errorMessage === 'string') data.detail = ev.errorMessage;
    send({ jsonrpc: '2.0', method: 'event', params: { sid, data } });
    return;
  }
  if (ev.type === 'turn_end') {
    // A turn_end while no turn is active is a leftover from a turn we already
    // terminated. Ignore it, and clear abortRequested so it cannot mis-classify
    // the next turn.
    if (!turnActive) { abortRequested = false; return; }
    // Per pi's protocol a turn is ONE assistant response plus its tool results;
    // stopReason "toolUse" means the agent will continue in another turn. It is
    // therefore NOT the end of the user's turn. Record the stop and keep going;
    // the turn settles at agent_settled below.
    lastStopReason = ev.message?.stopReason ?? lastStopReason;
    return;
  }
  if (ev.type === 'agent_settled') {
    // The agent run is fully settled: no retry, compaction retry, or queued
    // continuation remains. THIS is the end of the user's turn.
    if (!turnActive) { abortRequested = false; return; }
    let status;
    if (abortRequested) { status = 'aborted'; abortRequested = false; }
    else if (lastStopReason === 'aborted') { status = 'aborted'; }
    else if (lastStopReason === 'error') { status = 'failed'; }
    else { status = 'completed'; }
    turnActive = false;
    terminalSent = true;
    lastStopReason = undefined;
    turnsRun += 1;
    send({ jsonrpc: '2.0', method: 'event', params: { sid, data: { type: 'turn_end', status } } });
    // The plan extension can change plan mode on its own — the model leaves
    // plan mode when its plan is approved. Read the state back and report the
    // change, so the core's view follows the harness rather than the last thing
    // the core requested. (dsh pushes this on its own; pi's log has to be read.)
    readPlanState((state) => {
      if (state === null || state === planActive) return;
      planActive = state;
      send({ jsonrpc: '2.0', method: 'event', params: { sid, data: { type: 'plan_changed', plan: state } } });
    });
    const w = promptWaiters.shift();
    if (w) w(status);
    return;
  }
  // agent_end, message_start, tool_execution_update, auto_retry_*,
  // queue_update, session_*, model_select, bash_execution_update,
  // extension_error: outside the contract, dropped.
}

// --- bus message handling ------------------------------------------------------
let piRuntime = null;   // {cmd, args} declared by the manifest; never discovered here
// The harness process being alive is not the same as it being ready: jouzu starts
// pi inside itself, so a cold start can take a while, and pi itself is respawned
// when a provider is injected. Readiness is therefore its own wait, with its own
// bound and its own error — folding it into the confirmation window made a slow
// start look like an unconfirmed model, which is a false alarm about the knob.
let harnessUp = null;
let harnessUpResolve = null;
function harnessUpProof(timeoutMs) {
  if (harnessUp) return harnessUp;
  harnessUp = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { harnessUp = null; harnessUpResolve = null; reject(Object.assign(new Error(`no answer within ${Math.round(timeoutMs / 1000)}s`), { readiness: true })); }, timeoutMs);
    harnessUpResolve = () => { clearTimeout(timer); resolve(); };
    // Ask, rather than wait to be spoken to: a harness answers when it is asked,
    // and silence is not a state we can distinguish from "not up yet".
    piRequest({ type: 'get_state' }).catch(() => {});
  });
  return harnessUp;
}
let promptWaiters = [];
// Set when the core asks us to abort. pi does NOT emit stopReason="aborted"
// when a tool is interrupted (it emits "toolUse" then "error"), so we remember
// the abort ourselves and force the terminal turn_end to map to 'aborted'.
let abortRequested = false;
let terminalSent = false; // guards against pi emitting two turn_end for one turn
// pi emits TWO turn_end for an aborted turn (e.g. stopReason "toolUse" then
// "error"). We report the first as our terminal; the second arrives later and
// must be swallowed, or it leaks into the NEXT turn.
let turnActive = false; // true from prompt start until we report a terminal turn_end
let lastStopReason;     // last turn_end stopReason seen in the active turn
// How many turns this session has produced. A preset is a session composition
// — swapping tools under a conversation leaves logged tool calls the new
// composition cannot make — so it may only be chosen while the session is still
// blank. dsh enforces the same rule (agent-preset-locked); we mirror it rather
// than silently keep the old preset and report the new one.
let turnsRun = 0;
// pi can emit a SECOND turn_end for a turn we already terminated by abort
// (e.g. stopReason "toolUse" then "error"). Any turn_end arriving while no turn
// is active is a leftover and must be ignored so it cannot leak into the next.

function handleBusMessage(msg) {
  const { id, method, params = {} } = msg;
  if (!method) {
    // Response to one of our requests. Confirm resolvers read `.approved`;
    // select (question) resolvers read `.answers`. The two pending tables are
    // keyed by the same pi request id, and the `appr-`/`q-` prefix says which
    // request is being answered.
    if (typeof id === 'string' && id.startsWith('q-')) {
      const reqId = id.slice(2);
      const qcb = pendingQuestions.get(reqId) || pendingQuestions.get(id);
      if (qcb) {
        pendingQuestions.delete(reqId);
        pendingQuestions.delete(id);
        qcb(msg.result || {});
      }
      return;
    }
    const cb = pendingApprovals.get(id) || (typeof id === 'string' && id.startsWith('appr-') ? pendingApprovals.get(id.slice(5)) : undefined);
    if (cb) {
      pendingApprovals.delete(id);
      if (id !== undefined) pendingApprovals.delete(typeof id === 'string' && id.startsWith('appr-') ? id.slice(5) : id);
      cb(msg.result || {});
    }
    return;
  }
  switch (method) {
    case 'session/start': {
      sid = params.sid;
      piRuntime = piRuntime || resolvePi();
      if (params.resume && !fs.existsSync(params.resume)) {
        // Fail loudly: a missing session must never silently become a new one.
        send({ jsonrpc: '2.0', id, error: { code: -32000, message: `session not found: ${params.resume}` } });
        return;
      }
      const ref = startPi(params.resume || null);
      // Zero-LLM liveness proof: pi answers get_state without any model call.
      piRequest({ type: 'get_state' }).then((resp) => {
        if (!resp || resp.success !== true) {
          send({ jsonrpc: '2.0', id, error: { code: -32000, message: `pi did not come up: ${resp ? JSON.stringify(resp.error) : 'stream ended'}` } });
          return;
        }
        // additionalDirectories: pi has no CLI/rpc surface for extra roots.
        // Report the truth rather than dropping them silently.
        const adReport = ADDITIONAL_DIRS.length
          ? { requested: ADDITIONAL_DIRS, applied: [], supported: false, reason: 'harness exposes no additional-roots surface' }
          : undefined;
        send({ jsonrpc: '2.0', id, result: { ref, state: resp.data ?? null, ...(adReport ? { additionalDirectories: adReport } : {}) } });
      });
      return;
    }
    case 'session/fork': {
      // This process IS the new conversation: the hub hands it a fresh session id
      // and says where to branch from, so the fork is performed here and its
      // result becomes this process's session. That is the only shape that keeps
      // the source session alone — pi's fork rebinds whichever process runs it
      // (rpc-mode rebindSession), so doing it in the source's own process would
      // quietly make that process serve a different conversation than the hub
      // thinks it does. Measured: a second process forking a session leaves the
      // source's file (hash) and its live process untouched.
      //
      // The anchor is a COMPLETED TURN, because that is the cut both harnesses
      // make exactly. pi's fork lands *before* the message it is given, so "end
      // with turn N" is the message that STARTS turn N+1 — and when N is the last
      // turn there is no next message, which is what `clone` copies.
      sid = params.sid;
      piRuntime = piRuntime || resolvePi();
      const source = params.from;
      if (!source || !fs.existsSync(source)) {
        send({ jsonrpc: '2.0', id, error: { code: -32000, message: `fork source not found: ${source}` } });
        return;
      }
      startPi(source);
      const settle = (msg, data) => send({ jsonrpc: '2.0', id, result: { ...data, state: msg ? (msg.data ?? null) : null } });
      piRequest({ type: 'get_state' }).then((up) => {
        if (!up || up.success !== true) {
          send({ jsonrpc: '2.0', id, error: { code: -32000, message: `pi did not come up for the fork: ${up ? JSON.stringify(up.error) : 'stream ended'}` } });
          return;
        }
        return piRequest({ type: 'get_fork_messages' }).then((fm) => {
          const points = (fm && fm.data && Array.isArray(fm.data.messages)) ? fm.data.messages : null;
          if (!points) {
            send({ jsonrpc: '2.0', id, error: { code: -32000, message: 'pi did not report its fork points' } });
            return;
          }
          const wants = params.throughTurn;
          let call;
          if (wants === undefined || wants === null) {
            call = { type: 'clone' };
          } else {
            const n = Number(wants);
            if (!Number.isInteger(n) || n < 1) {
              send({ jsonrpc: '2.0', id, error: { code: -32000, message: 'throughTurn must be a positive integer', data: { code: 'validation-failed' } } });
              return;
            }
            if (n < points.length) call = { type: 'fork', entryId: points[n].entryId };
            else if (n === points.length) call = { type: 'clone' };
            else {
              send({ jsonrpc: '2.0', id, error: { code: -32000, message: `session has ${points.length} completed turn(s), not ${n}`, data: { code: 'unknown-turn' } } });
              return;
            }
          }
          return piRequest(call).then((r) => {
            if (!r || r.success !== true) {
              send({ jsonrpc: '2.0', id, error: { code: -32000, message: `fork failed: ${r ? JSON.stringify(r.error) : 'stream ended'}` } });
              return;
            }
            if (r.data && r.data.cancelled === true) {
              // An extension refused it. Never report a fork that did not happen.
              send({ jsonrpc: '2.0', id, error: { code: -32000, message: 'the fork was cancelled by an extension', data: { code: 'fork-cancelled' } } });
              return;
            }
            return piRequest({ type: 'get_state' }).then((st) => {
              const ref = st && st.data && st.data.sessionFile;
              if (!ref) {
                send({ jsonrpc: '2.0', id, error: { code: -32000, message: 'pi reported no session file for the fork' } });
                return;
              }
              currentRef = ref;   // this process now speaks for the child
              settle(st, { ref, ...(r.data && typeof r.data.text === 'string' ? { text: r.data.text } : {}) });
            });
          });
        });
      }).catch((e) => send({ jsonrpc: '2.0', id, error: { code: -32000, message: `fork failed: ${e.message}` } }));
      return;
    }
    case 'session/prompt': {
      if (!params.clientMessageId) {
        send({ jsonrpc: '2.0', id, error: { code: -32000, message: 'session/prompt requires clientMessageId (core surface)' } });
        return;
      }
      if (!currentRef) {
        send({ jsonrpc: '2.0', id, error: { code: -32000, message: 'no session open' } });
        return;
      }
      appendTranscript({ id: params.clientMessageId, role: 'user', text: params.message, complete: true });
      piRequest({ type: 'get_state' }).then((st) => process.stderr.write(`[adapter] get_state at prompt: model=${JSON.stringify(st && st.data && st.data.model && st.data.model.id)} provider=${JSON.stringify(st && st.data && st.data.model && st.data.model.provider)}\n`)).catch(() => {});
      // Do NOT arm the new turn yet: a stale turn_end from a just-aborted turn
      // can still arrive. pi cannot emit the new turn's turn_end before it
      // acknowledges the prompt, so we arm (turnActive=true) only after the ack
      // below. Until then any turn_end is treated as the previous turn's
      // leftover (see the !turnActive guard) and swallowed.
      const attempt = (extra) => piRequest({
        type: 'prompt', message: params.message,
        // pi's rpc prompt carries images as pi-ai ImageContent:
        // {type:'image', mimeType, data}. The core's part field is `mediaType`,
        // so map it — pi ignores an unknown field and would drop the image.
        ...(Array.isArray(params.images) && params.images.length
          ? { images: params.images.filter((im) => im && typeof im.data === 'string' && im.data.length).map((im) => ({ type: 'image', data: im.data, mimeType: im.mediaType || 'image/png' })) }
          : {}),
        ...(configuredModel ? { model: configuredModel } : {}),
        ...extra,
      });
      (async () => {
        // Register the turn-end waiter BEFORE prompting: pi can stream the whole
        // turn (including turn_end) before our waiter would otherwise be pushed.
        let settleTurn;
        const turnEnded = new Promise((resolve) => { settleTurn = resolve; });
        promptWaiters.push(settleTurn);
        let resp = await attempt({});
        // Measured: pi rejects a prompt sent between turn_end and agent settle
        // ("Agent is already processing...") — exactly what a quick UI
        // follow-up hits. Queue it instead of failing the request.
        if (resp && resp.success === false && /already processing/i.test(JSON.stringify(resp.error ?? ''))) {
          resp = await attempt({ streamingBehavior: 'followUp' });
        }
        if (!resp) {
          send({ jsonrpc: '2.0', id, error: { code: -32000, message: 'pi exited before responding' } });
          return;
        }
        if (resp.success !== true) {
          send({ jsonrpc: '2.0', id, error: { code: -32000, message: JSON.stringify(resp.error ?? 'unknown pi error') } });
          return;
        }
        // Prompt accepted by pi; the turn is NOT done. Resolve when turn_end
        // arrives (contract: session/prompt result is the ended turn).
        // Arm the turn now that pi has acknowledged it; only from here can a
        // turn_end belong to THIS turn.
        turnActive = true;
        terminalSent = false;
        lastStopReason = undefined;
        const status = await turnEnded;
        if (status === 'failed') send({ jsonrpc: '2.0', id, error: { code: -32000, message: 'turn failed' } });
        else send({ jsonrpc: '2.0', id, result: {} });
      })();
      return;
    }
    case 'credentials/grant': {
      // protocol §6: {connectionId, value, url?}. The value is held in memory
      // only (re-granted every process start); never written to disk in
      // plaintext. `url` is present only when a hub-managed provider is being
      // injected: we then synthesize a pi provider entry with apiKey as an env
      // reference inside a private agent dir, leaving the user's own config
      // intact and untouched.
      granted = {
        connectionId: params.connectionId || null,
        value: typeof params.value === 'string' ? params.value : null,
        url: typeof params.url === 'string' && params.url ? params.url : null,
        // The provider says which protocol it speaks (its own definition carries
        // it); this adapter does not assume one. A provider registered without
        // one keeps the historical default.
        api: typeof params.api === 'string' && params.api ? params.api : null,
      };
      injectedFacts = Array.isArray(params.models) ? params.models : [];
      injectedDir = null;
      injectedModels = [];
      if (granted.url && granted.value) {
        injectedEnvName = 'PRTS_INJECTED_' + String(granted.connectionId || 'PROVIDER').replace(/[^A-Za-z0-9]/g, '_').toUpperCase() + '_API_KEY';
        injectedDir = buildInjectedDir();
        probeModels(granted.url, granted.value).then((models) => {
          injectedModels = models;
          applyInjectedProvider(injectedDir, models);
          // The injected agent dir + token env only reach pi at SPAWN, and pi
          // spawned at session/start — before this grant. Restart pi carrying
          // the injected provider, re-attaching the same session, so the run
          // actually uses it instead of silently falling back to native config.
          if (pi && currentRef) {
            if (turnActive) { send({ jsonrpc: '2.0', id, result: {} }); return; }
            const child = pi; pi = null;
            try { child.kill(); } catch {}
            startPi(currentRef);
          }
          send({ jsonrpc: '2.0', id, result: {} });
        }).catch((e) => {
          injectedDir = null;
          send({ jsonrpc: '2.0', id, error: { code: -32000, message: `cannot inject provider ${granted.url}: ${e.message}` } });
        });
        return;
      }
      send({ jsonrpc: '2.0', id, result: {} });
      return;
    }
    case 'session/abort': {
      // Remember the abort: pi may report stopReason "toolUse"/"error" instead
      // of "aborted" when a tool is interrupted, so we classify the turn here.
      abortRequested = true;
      // The ack means we ASKED pi to stop; the turn's own turn_end proves it
      // stopped. If there is no live pi, say so - the core must be able to tell
      // "asked and never confirmed" from "could not even ask".
      let wrote = false;
      try {
        if (pi && pi.stdin && !pi.stdin.destroyed) { pi.stdin.write(JSON.stringify({ type: 'abort' }) + '\n'); wrote = true; }
      } catch { wrote = false; }
      if (!wrote) {
        abortRequested = false;
        send({ jsonrpc: '2.0', id, error: { code: -32000, message: 'abort failed: no live harness to interrupt', data: { code: 'abort-failed' } } });
        return;
      }
      send({ jsonrpc: '2.0', id, result: {} });
      return;
    }
    case 'presets/list': {
      // dsh-aligned: opaque ids + metadata only; content stays local.
      const presets = listShippedPresets();
      send({ jsonrpc: '2.0', id, result: { presets } });
      if (!pi) process.exit(0);
      return;
    }
    case 'models/list': {
      // Model picker data source (PROTOCOL v0, capability `models`). Reads
      // pi's own catalog files — the adapter is the only place that knows
      // where pi keeps them. One-shot: when no session was opened the
      // process answers and exits, so a probe never lingers.
      piRuntime = piRuntime || resolvePi();
      let models = [];
      try {
        const own = scanModels();
        // The core's providers are not in pi's config; merge them so this one
        // list answers what pi can run. A declared model pi already knows about
        // keeps pi's own entry (its config wins), and a declared model pi does
        // not know is added from the declaration.
        const seen = new Set(own.map((m) => m.provider + '::' + m.id));
        const extra = managedModels(params.providers);
        models = own.concat(Object.entries(extra).filter(([k]) => !seen.has(k)).map(([, v]) => v));
      } catch (e) {
        send({ jsonrpc: '2.0', id, error: { code: -32000, message: `models/list failed: ${e.message}` } });
        if (!pi) process.exit(0);
        return;
      }
      send({ jsonrpc: '2.0', id, result: { models } });
      if (!pi) process.exit(0);
      return;
    }
    case 'config/set': {
      // One reply, after every knob that has asynchronous work has settled. The
      // knobs are independent but share this one request, so replying from
      // inside any single branch would report the others as unapplied.
      const model = params.config && params.config.model;
      const connectionId = params.config && params.config.connectionId;
      const presetId = params.config && params.config.presetId;
      const plan = params.config && params.config.plan;
      const review = params.config && params.config.review;
      const thinkingLevel = params.config && params.config.thinkingLevel;
      // What the hub installed for this harness travels with this call: the
      // extensions (bytes included) and skills it selected. Taking it here — not
      // from a directory the hub merely points at — is what makes the hub the
      // installer and the registry the source of truth for what a harness has.
      let replied = false;
      const reply = (message) => { if (!replied) { replied = true; send(message); } };
      let pendingCount = 1; // synchronous scheduling owns the first slot
      const applied = {};
      const settle = () => {
        pendingCount -= 1;
        if (pendingCount > 0) return;
        if (applied.preset === undefined && presetId !== undefined && activePresetId !== null) applied.preset = activePresetId;
        reply({ jsonrpc: '2.0', id, result: Object.keys(applied).length ? { applied, requires: 'none' } : {} });
      };

      if (presetId !== undefined) {
        // Make the named preset the session's composition: install the
        // agent-presets extension into the workspace and write the definition
        // it reads. The next pi spawn picks both up.
        const cwd = process.env.PRTS_CWD;
        const known = listShippedPresets().some((p) => p.id === presetId);
        if (presetId && !known) {
          reply({ jsonrpc: '2.0', id, error: { code: -32000, message: 'unknown preset: ' + presetId } });
          return;
        }
        // A preset is a composition, not a knob: it decides which tools the
        // session has. Once the conversation has produced a turn, its logged
        // tool calls belong to the old composition, so the preset is fixed.
        // Refuse explicitly — dsh answers agent-preset-locked here, and a 200
        // that quietly kept the old preset would be a lie (appliedPreset is the
        // proof the caller reads back).
        const changed = (presetId || null) !== activePresetId;
        if (changed && turnsRun > 0) {
          reply({
            jsonrpc: '2.0',
            id,
            error: {
              code: -32000,
              message: `session has already started; its agent preset is fixed (${activePresetId})`,
              data: { code: 'agent-preset-locked', agentPreset: activePresetId },
            },
          });
          return;
        }
        if (!changed) {
          // Same preset: nothing to do, and nothing to report beyond what is.
          applied.preset = activePresetId;
        } else {
          // Blank session, first choice. The preset is an env var only present
          // at SPAWN, so pi is restarted here to carry it — before the review
          // and model knobs below, which must reach the NEW child (the same
          // request may also switch review on, and that is the extension's state
          // in the process we are about to replace).
          if (!(pi && currentRef && !turnActive)) {
            // No live child to restart means the choice cannot take effect now;
            // say so rather than reporting a preset that is not in force.
            reply({ jsonrpc: '2.0', id, error: { code: -32000, message: 'cannot apply preset: no live harness to carry it' } });
            return;
          }
          if (cwd) { installAgentPresetsExt(cwd); writeActivePreset(cwd, presetId || null); }
          // Record the choice BEFORE respawning: startPi reads activePresetId to
          // hand the child its AGENT_PRESETS_CONFIG, so a restart that ran first
          // would spawn a pi with no preset — which is exactly the silent
          // no-op this branch exists to prevent.
          activePresetId = presetId || null;
          applied.preset = activePresetId;
          const child = pi; pi = null;
          try { child.kill(); } catch {}
          startPi(currentRef);
        }
      }

      if (plan !== undefined) {
        // Plan mode is a session-scoped capability, not a composition: toggle it
        // through the extension's own command and read the state back from the
        // log it writes. No restart — the harness owns the state from here.
        const cwd = process.env.PRTS_CWD;
        if (cwd) installPlanExt(cwd);
        pendingCount += 1;
        planCommand(plan === true, (state) => {
          if (state !== null && state !== undefined) { applied.plan = state; planActive = state; }
          settle();
        });
      }

      if (review !== undefined) {
        // The review switch is the preset extension's own state. Drive its
        // command and read the log back; like plan, it must be installed so a
        // mid-session switch has something to run against.
        const cwd = process.env.PRTS_CWD;
        if (cwd) installAgentPresetsExt(cwd);
        pendingCount += 1;
        reviewCommand(review === true, (state) => {
          // Only an OBSERVED state is reported as applied. 'unknown' means we
          // could not see the switch take effect (no harness, a refusal, or the
          // read never landed) — that must not read as success.
          applied.review = (state === 'unknown') ? null : state;
          settle();
        });
      }

      if (thinkingLevel !== undefined) {
        // The level is the harness's own; set it through pi's rpc and report only
        // what pi confirmed. A rejected or unanswered set is never success.
        const reject = (message) => reply({ jsonrpc: '2.0', id, error: { code: -32000, message, data: { code: 'thinking-level-not-applied' } } });
        if (!PI_THINKING_LEVELS.includes(thinkingLevel)) { reject('unsupported thinking level: ' + thinkingLevel); return; }
        if (!(pi && !turnActive)) { reject('cannot set thinking level: no idle harness'); return; }
        pendingCount += 1;
        let done = false;
        let timer = null;
        const giveUp = (message) => { if (done) return; done = true; if (timer) clearTimeout(timer); reject(message); };
        harnessUpProof(120000)
          .then(() => {
            if (done) return;
            timer = setTimeout(() => giveUp('set_thinking_level did not confirm before its deadline'), 30000);
            return piRequest({ type: 'set_thinking_level', thinkingLevel });
          })
          .then((r) => {
            if (done) return;
            if (!r || r.success !== true) { giveUp('set_thinking_level was rejected'); return; }
            done = true; clearTimeout(timer);
            applied.thinkingLevel = thinkingLevel;
            settle();
          })
          .catch((e) => giveUp(e && e.readiness ? `the harness did not come up: ${e.message}` : 'cannot set thinking level: ' + e.message));
      }

      if (model !== undefined) {
        let hit = null;
        try {
          piRuntime = piRuntime || resolvePi();
          const all = scanModels();
          const selectedProvider = connectionId || (granted && granted.connectionId);
          const route = selectedProvider && granted && selectedProvider === granted.connectionId
            ? INJECT_PREFIX + String(selectedProvider) : selectedProvider;
          hit = route
            ? all.find((m) => m.provider === route && (m.id === model || m.provider + '::' + m.id === model)) || null
            : all.find((m) => m.provider + '::' + m.id === model) || all.find((m) => m.id === model) || null;
        } catch { hit = null; }
        if (!hit) {
          reply({ jsonrpc: '2.0', id, error: { code: -32000, message: 'cannot apply model: ' + model } });
          return;
        }
        // pi's rpc `prompt` has no model field — the model is chosen ONLY by a
        // separate `set_model` command. Sending `model` on the prompt is silently
        // ignored, so every turn used to run on pi's own default (wrong provider,
        // and no vision). Set it here, and settle BEFORE answering config/set:
        // the core prompts as soon as config/set returns, so a switch still in
        // flight would let the first turn run on the old model.
        const selectedModel = hit.provider.startsWith(INJECT_PREFIX) ? hit.provider + '::' + hit.id : model;
        if (pi && !turnActive) {
          pendingCount += 1;
          let done = false;
          let t = null;
          const rejectModel = (message) => {
            if (done) return;
            done = true;
            if (t) clearTimeout(t);
            reply({ jsonrpc: '2.0', id, error: { code: -32000, message, data: { code: 'model-not-applied' } } });
          };
          harnessUpProof(120000)
            .then(() => {
              if (done) return;
              t = setTimeout(() => rejectModel('set_model did not confirm before its deadline'), 30000);
              return piRequest({ type: 'set_model', provider: hit.provider, modelId: hit.id });
            })
            .then((r) => {
              if (done) return;
              if (!r || r.success !== true) { rejectModel('set_model was rejected'); return; }
              done = true;
              clearTimeout(t);
              configuredModel = selectedModel;
              applied.connectionId = hit.provider;
              if (connectionId) applied.modelProviderId = connectionId;
              applied.model = hit.id;
              applied.configRevision = null;
              settle();
            })
            .catch((e) => rejectModel(e && e.readiness ? `the harness did not come up: ${e.message}` : 'cannot set model: ' + e.message));
        } else {
          configuredModel = selectedModel; // queued for the next turn, not observed as applied
        }
      }

      settle();
      return;
    }
    case 'skills/list': {
      // Read back from the HARNESS: pi's own command list carries one entry per
      // skill it actually loaded (`skill:<name>`). Nothing about what the hub
      // installed is assumed here — a skill pi refused is absent, which is the
      // fact a caller needs.
      if (!currentRef) {
        send({ jsonrpc: '2.0', id, error: { code: -32000, message: 'no session open' } });
        return;
      }
      piRequest({ type: 'get_commands' }).then((r) => {
        if (!r || r.success !== true) {
          send({ jsonrpc: '2.0', id, error: { code: -32000, message: `skills unavailable: ${r ? JSON.stringify(r.error) : 'stream ended'}` } });
          return;
        }
        const cmds = (r.data && Array.isArray(r.data.commands)) ? r.data.commands : [];
        const skills = cmds
          .filter((c) => String(c.name || '').startsWith('skill:'))
          .map((c) => ({ name: String(c.name).slice('skill:'.length), ...(c.description ? { description: String(c.description) } : {}) }));
        send({ jsonrpc: '2.0', id, result: { skills } });
      }).catch((e) => send({ jsonrpc: '2.0', id, error: { code: -32000, message: `skills failed: ${e.message}` } }));
      return;
    }
    case 'session/rename': {
      // pi's command answers success and nothing else, so the accepted name is
      // READ BACK from its own state: if the harness did not take the name, the
      // caller must see that instead of a rename that lives only in the hub.
      if (!currentRef) {
        send({ jsonrpc: '2.0', id, error: { code: -32000, message: 'no session open' } });
        return;
      }
      const title = params && typeof params.title === 'string' ? params.title.trim() : '';
      if (!title) {
        send({ jsonrpc: '2.0', id, error: { code: -32000, message: 'rename needs a non-empty title', data: { code: 'validation_failed' } } });
        return;
      }
      piRequest({ type: 'set_session_name', name: title })
        .then((r) => {
          if (!r || r.success !== true) {
            throw Object.assign(new Error(String((r && r.error) || 'the harness refused the name')), { data: { code: 'rename_failed' } });
          }
          return piRequest({ type: 'get_state' });
        })
        .then((st) => {
          const held = st && st.data ? st.data.sessionName : null;
          lastTitle = held || null;
          send({ jsonrpc: '2.0', id, result: { title: held || null } });
        })
        .catch((e) => send({ jsonrpc: '2.0', id, error: { code: -32000, message: `rename failed: ${e.message}`, data: { code: 'rename_failed' } } }));
      return;
    }
    case 'session/compact': {
      // Compaction is the harness's own operation: pi summarises the branch, and
      // answers with the result. Nothing here is computed by the adapter — pi's
      // tokensBefore is the span it replaced, its estimatedTokensAfter is its own
      // heuristic, and a field pi does not report stays out.
      if (!currentRef) {
        send({ jsonrpc: '2.0', id, error: { code: -32000, message: 'no session open' } });
        return;
      }
      const call = { type: 'compact' };
      if (params && typeof params.instructions === 'string' && params.instructions) call.customInstructions = params.instructions;
      piRequest(call).then((r) => {
        if (!r || r.success !== true) {
          const msg = String((r && r.error) || 'compaction failed');
          // "Nothing to compact" is not a failure: there was nothing worth
          // summarising, and pi says so in the same channel as real errors.
          // Silently reporting a compaction that never happened would be worse.
          if (/nothing to compact|already compacted/i.test(msg)) {
            send({ jsonrpc: '2.0', id, result: { compacted: false, detail: msg } });
            return;
          }
          send({ jsonrpc: '2.0', id, error: { code: -32000, message: `compact failed: ${msg}`, data: { code: 'compact_failed' } } });
          return;
        }
        const d = r.data || {};
        const out = { compacted: true, reason: 'manual' };
        if (typeof d.tokensBefore === 'number') out.tokensBefore = d.tokensBefore;
        if (typeof d.estimatedTokensAfter === 'number') out.tokensAfter = d.estimatedTokensAfter;
        if (typeof d.summary === 'string') out.summary = d.summary;
        if (d.usage) out.usage = d.usage;
        send({ jsonrpc: '2.0', id, result: out });
      }).catch((e) => send({ jsonrpc: '2.0', id, error: { code: -32000, message: `compact failed: ${e.message}`, data: { code: 'compact_failed' } } }));
      return;
    }
    case 'session/stats': {
      // pi's own numbers, passed through: tokens (with cache), cost, and the
      // context-window estimate it makes for compaction and its footer. A field
      // pi does not report is left OUT rather than filled with zero — a zero
      // token count and an unmeasured one are not the same claim.
      if (!currentRef) {
        send({ jsonrpc: '2.0', id, error: { code: -32000, message: 'no session open' } });
        return;
      }
      piRequest({ type: 'get_session_stats' }).then((r) => {
        if (!r || r.success !== true) {
          send({ jsonrpc: '2.0', id, error: { code: -32000, message: `stats unavailable: ${r ? JSON.stringify(r.error) : 'stream ended'}` } });
          return;
        }
        const d = r.data || {};
        const out = {};
        if (d.tokens) {
          out.tokens = {
            input: d.tokens.input, output: d.tokens.output,
            cacheRead: d.tokens.cacheRead, cacheWrite: d.tokens.cacheWrite,
            total: d.tokens.total,
          };
        }
        if (typeof d.cost === 'number') out.cost = d.cost;
        if (d.contextUsage) {
          out.context = {
            tokens: d.contextUsage.tokens ?? null,
            window: d.contextUsage.contextWindow ?? null,
            percent: d.contextUsage.percent ?? null,
          };
        }
        if (typeof d.totalMessages === 'number') {
          out.messages = { user: d.userMessages, assistant: d.assistantMessages, toolCalls: d.toolCalls };
        }
        send({ jsonrpc: '2.0', id, result: out });
      }).catch((e) => send({ jsonrpc: '2.0', id, error: { code: -32000, message: `stats failed: ${e.message}` } }));
      return;
    }
    case 'history/page': {
      if (!currentRef) {
        send({ jsonrpc: '2.0', id, error: { code: -32000, message: 'no session open' } });
        return;
      }
      // A forked (or externally created) session has history this adapter never
      // wrote down: import it before answering, or the page is a lie of omission.
      ensureTranscript(currentRef).catch((e) => process.stderr.write(`[adapter] transcript import failed: ${e.message}
`)).then(() => {
      const entries = loadTranscript(currentRef);
      const limit = Math.max(1, Number(params.limit) || 20);
      let end = entries.length;
      if (params.beforeId !== undefined && params.beforeId !== null) {
        const idx = entries.findIndex((e) => e.id === params.beforeId);
        if (idx < 0) {
          send({ jsonrpc: '2.0', id, error: { code: -32000, message: 'unknown beforeId: ' + params.beforeId } });
          return;
        }
        end = idx; // anchor EXCLUDED
      }
      const start = Math.max(0, end - limit);
      const page = entries.slice(start, end).map((e) => ({ id: e.id, role: e.role, text: e.text, complete: true }));
      send({ jsonrpc: '2.0', id, result: { messages: page, hasMore: start > 0 } });
      });
      return;
    }
    // runtime/prepare: materialise the harness this plugin drives. The manifest pins it
    // (runtime.package + runtime.version) and this adapter installs exactly that
    // version into <plugin>/runtime, the directory the manifest's command is relative
    // to. The hub asks for this and verifies the result; it never installs a harness
    // itself and knows nothing about packages or release layouts.
    case 'runtime/prepare': {
      const mf = path.join(PLUGIN_DIR, 'manifest.json');
      let manifest = {};
      try { manifest = JSON.parse(fs.readFileSync(mf, 'utf8')); } catch (e) {
        send({ jsonrpc: '2.0', id, result: { ready: false, detail: `cannot read ${mf}: ${e.message}` } });
        return;
      }
      const rt = manifest.runtime;
      if (!rt || !rt.package || !rt.version) {
        send({ jsonrpc: '2.0', id, result: { ready: true, detail: 'no runtime declared: this adapter brings its own' } });
        return;
      }
      const dir = path.join(PLUGIN_DIR, 'runtime');
      const rel = Array.isArray(rt.command) ? rt.command.slice(1).find((p) => !String(p).startsWith('-')) : null;
      const target = rel ? path.resolve(PLUGIN_DIR, rel) : null;
      if (target && fs.existsSync(target)) {
        send({ jsonrpc: '2.0', id, result: { ready: true, package: rt.package, version: rt.version, target, detail: 'already present' } });
        return;
      }
      // npm's own output would corrupt the JSON-RPC stream on stdout, so it is echoed
      // to stderr: the hub keeps the last lines and shows them when something fails.
      const run = (cmd, args, opts) => {
        const r = spawnSync(cmd, args, { cwd: dir, windowsHide: true, shell: process.platform === 'win32', encoding: 'utf8', ...opts });
        if (r.stdout) process.stderr.write(String(r.stdout));
        if (r.stderr) process.stderr.write(String(r.stderr));
        return r;
      };
      const spec = `${rt.package}@${rt.version}`;
      fs.mkdirSync(dir, { recursive: true });
      let done = null;
      try {
        if (rt.mode === 'package') {
          const pkg = path.join(dir, 'package.json');
          if (!fs.existsSync(pkg)) fs.writeFileSync(pkg, JSON.stringify({ name: `agent-hub-runtime-${manifest.id}`, private: true }, null, 2) + String.fromCharCode(10));
          const r = run('npm', ['install', '--omit=dev', '--no-audit', '--no-fund', spec]);
          if (r.status !== 0) done = `npm install ${spec} exited ${r.status}`;
        } else {
          const packed = run('npm', ['pack', spec]);
          if (packed.status !== 0) done = `npm pack ${spec} exited ${packed.status}`;
          else {
            const tgz = String(packed.stdout || '').trim().split(String.fromCharCode(10)).pop();
            const unpack = run('tar', ['xzf', tgz]);
            if (unpack.status !== 0) done = `tar xzf ${tgz} exited ${unpack.status}`;
            else {
              const inner = path.join(dir, 'package');
              if (fs.existsSync(inner)) {
                for (const entry of fs.readdirSync(inner)) fs.renameSync(path.join(inner, entry), path.join(dir, entry));
                fs.rmSync(inner, { recursive: true, force: true });
              }
              fs.rmSync(path.join(dir, tgz), { force: true });
              if (fs.existsSync(path.join(dir, 'package.json'))) {
                const r = run('npm', ['install', '--omit=dev', '--no-audit', '--no-fund']);
                if (r.status !== 0) done = `npm install (dependencies) exited ${r.status}`;
              }
            }
          }
        }
      } catch (e) {
        done = e.message;
      }
      const ready = !done && (!target || fs.existsSync(target));
      if (!done && target && !fs.existsSync(target)) done = `the install did not produce ${rel}, which the manifest's command points at`;
      send({ jsonrpc: '2.0', id, result: {
        ready,
        package: rt.package,
        version: rt.version,
        target,
        detail: done || `installed ${spec}`,
      } });
      return;
    }
    default:
      send({ jsonrpc: '2.0', id, error: { code: -32601, message: `unknown plugin method ${method}` } });
  }
}

// --- pi model catalog (models/list) -----------------------------------------
function readJsonFile(path) {
  try { return JSON.parse(fs.readFileSync(path, 'utf8')); } catch { return null; }
}

function piAgentDir() {
  const fromEnv = process.env.PI_CODING_AGENT_DIR;
  if (fromEnv) return fromEnv;
  return path.join(process.env.USERPROFILE || process.env.HOME || '', '.pi', 'agent');
}

// Mirrors the deleted shell's pi_installation::available(): the catalog
// (models-store.json minus radius + configured models.json) filtered down to
// models the credentials actually allow. Only available models are returned —
// the shell tags them and merges across harnesses; availability truth lives
// here, with pi's own files. (The classic shell also carried a dormant
// copilot availableModelIds special case; dropped — no install here ever
// used it. Reintroduce only if a real credential of that kind shows up.)
function resolveTemplate(value) {
  if (typeof value !== 'string') return null;
  const m = /^\{\{\s*env:([A-Za-z0-9_]+)\s*\}\}$/.exec(value.trim());
  if (m) { const v = process.env[m[1]]; return v && v.length ? v : null; }
  return value.trim().length ? value.trim() : null;
}

function credentialState(provider, configuredEntry, auth) {
  const credential = auth[provider];
  if (credential) {
    const isOauth = credential.type === 'oauth' || credential.access != null || credential.expires != null;
    if (isOauth) {
      const oauthSupported = ['anthropic', 'openai-codex'].includes(provider)
        || (configuredEntry && configuredEntry.oauth === 'radius');
      const expires = typeof credential.expires === 'number' ? credential.expires : 0;
      const valid = oauthSupported && expires > Date.now() + 60_000;
      return { available: valid, expired: oauthSupported && !valid };
    }
    const key = resolveTemplate(credential.key);
    return { available: key != null && provider !== 'openai-codex', expired: false };
  }
  if (configuredEntry && resolveTemplate(configuredEntry.apiKey) != null) {
    return { available: true, expired: false };
  }
  return { available: false, expired: false };
}

function scanModels() {
  const dir = injectedDir || piAgentDir();
  const auth = readJsonFile(path.join(dir, 'auth.json')) || {};
  const configured = (readJsonFile(path.join(dir, 'models.json')) || {}).providers || {};
  const store = readJsonFile(path.join(dir, 'models-store.json')) || {};
  const out = new Map();
  const push = (provider, m) => {
    if (!m || typeof m.id !== 'string' || !m.id) return;
    const key = `${provider}::${m.id}`;
    const previous = out.get(key);
    if (previous && previous.configured) return; // configured catalog wins
    const state = credentialState(provider, configured[provider], auth);
    if (!state.available) return;
    out.set(key, {
      connectionId: 'pi',
      provider,
      providerId: provider,
      id: m.id,
      name: typeof m.name === 'string' && m.name ? m.name : m.id,
      supportsImages: m.supportsImages !== false,
      reasoning: m.reasoning === true,
      // Only what the model declared. A model that reasons without naming its
      // levels reports none, so the core answers 'default' rather than a level
      // set the adapter made up.
      ...(declaredThinkingLevels(m) ? { thinkingLevels: declaredThinkingLevels(m) } : {}),
      authStatus: 'authenticated',
      configured: provider in configured,
    });
  };
  for (const [provider, entry] of Object.entries(store)) {
    if (provider === 'radius' || !entry || typeof entry !== 'object') continue;
    for (const m of entry.models || []) push(provider, m);
  }
  for (const [provider, entry] of Object.entries(configured)) {
    if (!entry || typeof entry !== 'object') continue;
    for (const m of entry.models || []) push(provider, m);
  }
  return [...out.values()].map(({ configured: _drop, ...model }) => model);
}

// A core-managed provider is not in pi's own config — the core holds it. So the
// core hands over what it owns when it asks for this catalog, and those models
// are reported as part of the answer: what this harness can run right now, in
// one list, with no second catalog for a caller to merge. The provider is named
// `prts-<id>` here exactly as it is in every other harness, so a catalog entry
// means the same thing whichever harness answered.
function managedModels(providers) {
  const out = {};
  for (const row of Array.isArray(providers) ? providers : []) {
    if (!row || typeof row.id !== 'string' || !row.id) continue;
    const provider = INJECT_PREFIX + row.id;
    for (const m of Array.isArray(row.models) ? row.models : []) {
      if (!m || typeof m.id !== 'string' || !m.id) continue;
      const efforts = m.reasoning && Array.isArray(m.reasoning.efforts) ? m.reasoning.efforts : null;
      out[provider + '::' + m.id] = {
        connectionId: provider,
        provider,
        providerId: provider,
        id: m.id,
        name: m.name || m.id,
        // The hub owns the token, so the hub answers whether the model can run:
        // a managed provider with no stored credential is NOT available, and one
        // with a credential is — no probing of pi's own config for either.
        available: row.hasCredential === true,
        ...(row.hasCredential === true ? {} : { unavailableReason: 'needs-auth' }),
        reasoning: Boolean(efforts && efforts.length),
        ...(efforts && efforts.length ? { thinkingLevels: efforts } : {}),
        ...(Array.isArray(m.input) && m.input.length ? { input: m.input } : {}),
        ...(m.contextWindow ? { contextWindow: m.contextWindow } : {}),
        ...(m.maxTokens ? { maxTokens: m.maxTokens } : {}),
      };
    }
  }
  return out;
}

function shutdown() {
  if (pi) { try { pi.kill(); } catch { } }
  process.exit(0);
}

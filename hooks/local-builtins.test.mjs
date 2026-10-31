// Run with `node --test hooks/local-builtins.test.mjs`: it reads the installed engine, which `claude plugin test` cannot.
// It checks only each command's top-level type (local, local-jsx or prompt). A local command that can also query the model, like `/plan <text>`, is handled in register.mjs (isLocalBuiltin).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { LOCAL_BUILTINS } from './register.mjs'

const dir = join(homedir(), '.local', 'share', 'claude', 'versions')
let src = ''
let skipWhy = ''
try {
  const versions = readdirSync(dir)
    .filter((n) => /^\d+\.\d+\.\d+$/.test(n) && statSync(join(dir, n)).isFile())
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
  if (!versions.length) skipWhy = 'no engine version file in ' + dir
  else src = readFileSync(join(dir, versions[versions.length - 1]), 'latin1')
} catch (err) {
  skipWhy = 'the engine could not be read: ' + (err && err.message)
}

// The source text of each object literal holding `name:"<name>"`
function objectsOf(name) {
  const out = []
  const re = new RegExp('name:"' + name + '"', 'g')
  let m
  while ((m = re.exec(src))) {
    let d = 0
    let s = m.index
    for (; s >= 0; s--) {
      if (src[s] === '}') d++
      else if (src[s] === '{') {
        if (d === 0) break
        d--
      }
    }
    d = 0
    let e = s
    for (; e < src.length; e++) {
      if (src[e] === '{') d++
      else if (src[e] === '}' && --d === 0) break
    }
    if (e - s > 6000) continue
    out.push(src.slice(s, e + 1))
  }
  return out
}

// Every command object in the engine, as { names, type }: one pass over the source (a scan per name would take 100 passes).
// An object's `name:` is a string literal (any shape, `__remote-workflow` too), or something the minifier left that a literal gives: an identifier (`name:pPe` with `var pPe="low-priority"` somewhere, or `name:e` inside a factory `function ren(e,n,r){return{type:"local-jsx",name:e,...}}` whose calls `ren("vim",...)` give it), or a member of a factory's object parameter (`name:e.name` in `function A2(e){return{type:"local",name:e.name,...}}`, whose calls `A2({name:"schedule",...})` give it). Any other `name:` in a local / local-jsx object is listed in `unresolved`, and a test fails on it: the one exception is PLUGIN_FACTORY below.
// Limit: the engine is minified, so a factory's calls are found by its name alone, and the minifier reuses a name for unrelated functions in other modules. A call counts as the factory's when it is not a declaration and passes at most as many arguments as the factory has parameters and at least two when it has two or more (for a factory taking one object, an object literal): a differently shaped call of a same-named function (`ren()`, `ren({turnGoesOn:!0})`) is not read, so a call of the factory with a single argument is not either. Of the calls that count, one whose name argument is a string literal shaped like a command name gives that name; any other (a variable or expression as the name, a literal of another shape, an object with no literal `name:`) is listed in `unresolved`, written as the call (`ren(someVar,...)`), and the test fails naming it.
const NAME_SHAPE = /^[a-z][a-z0-9-]*$/
const escId = (id) => id.replace(/\$/g, '\\$')
// The one local-command factory whose names are not in the engine: it turns a mod's `$.command.register` (this mod's own /cache, /board, ...) into a command at run time, `({plugin:e,spec:n})=>({type:"local",name:n.name,...loadedFrom:"plugin"...})`. Those are not built-ins; this mod's own are handled by name in register.mjs. Only an object holding `loadedFrom:"plugin"` and `name:<param>.name` is let by.
const PLUGIN_FACTORY = /loadedFrom:"plugin"/

function topLevelType(s) {
  let d = 0
  for (let k = s; k < src.length && k - s <= 6000; k++) {
    if (src[k] === '{') d++
    else if (src[k] === '}') {
      if (--d === 0) return ''
    } else if (d === 1 && src.startsWith('type:"', k) && /[,{]/.test(src[k - 1])) return src.slice(k + 6, src.indexOf('"', k + 6))
  }
  return ''
}

// The source text of each argument of the call whose `(` is at `open` (trimmed), null when the call does not end within reach
function callArgs(open) {
  const args = []
  let d = 0
  let start = open + 1
  for (let k = open + 1; k < src.length && k - open < 600; k++) {
    const c = src[k]
    if (c === '"' || c === "'" || c === '`') {
      k = src.indexOf(c, k + 1)
      if (k < 0) return null
    } else if (c === '(' || c === '[' || c === '{') d++
    else if (c === ')' || c === ']' || c === '}') {
      if (d === 0) {
        const last = src.slice(start, k).trim()
        if (last || args.length) args.push(last)
        return args
      }
      d--
    } else if (c === ',' && d === 0) {
      args.push(src.slice(start, k).trim())
      start = k + 1
    }
  }
  return null
}

// The i-th argument of the call when it is a plain string literal, else null
function stringArg(args, i) {
  const m = /^"([^"]*)"$/.exec(args[i] ?? '')
  return m ? m[1] : null
}

// A call of the factory `fn(...)` is found by its name alone, and the minifier reuses a name for unrelated functions in other modules (`ren()`, `ren({turnGoesOn:!0})`, a second `function A2(e)`). So a match is a call of the factory only when it is not a declaration (`function fn(`) and passes at most as many arguments as the factory has parameters (`arity`) and at least two when it has two or more (the trailing ones are optional: `ren("vim","Editor mode")` for `function ren(e,n,r)`); `need` 'object' also asks for an object literal first (a factory taking one object)
function factoryCalls(fn, arity, need) {
  const calls = []
  const re = new RegExp('(?<![\\w$.])' + escId(fn) + '\\(', 'g')
  let m
  while ((m = re.exec(src))) {
    if (/function\s+$/.test(src.slice(Math.max(0, m.index - 12), m.index))) continue
    const args = callArgs(m.index + m[0].length - 1)
    if (!args || args.length > arity || args.length < Math.min(2, arity)) continue
    if (need === 'object' && !args[0].startsWith('{')) continue
    calls.push({ at: m.index + m[0].length, args })
  }
  return calls
}

// The object literal opening at `s`, as text
function objectAt(s) {
  let d = 0
  let e = s
  for (; e < src.length && e - s <= 6000; e++) {
    if (src[e] === '{') d++
    else if (src[e] === '}' && --d === 0) break
  }
  return src.slice(s, e + 1)
}

// `function F(a,b){return{` (or an arrow) just before the object literal at `objectStart`: the factory's name and parameters
function factoryBefore(objectStart) {
  const before = src.slice(Math.max(0, objectStart - 300), objectStart)
  const f = /(?:function\s+([\w$]+)\s*\(([^)]*)\)\s*\{\s*return\s*|(?:const|let|var)\s+([\w$]+)\s*=\s*\(([^)]*)\)\s*=>\s*\(?\s*)$/.exec(before)
  return f ? { fn: f[1] || f[3], params: (f[2] ?? f[4]).split(',').map((x) => x.trim()) } : null
}

// The `name:"..."` literal at the top level of an object literal's text
function nameLiteralOf(obj) {
  let d = 0
  for (let k = 0; k < obj.length; k++) {
    const c = obj[k]
    if (c === '"' || c === "'" || c === '`') {
      k = obj.indexOf(c, k + 1)
      if (k < 0) return null
    } else if (c === '{' || c === '[' || c === '(') d++
    else if (c === '}' || c === ']' || c === ')') d--
    else if (d === 1 && obj.startsWith('name:"', k) && /[,{]/.test(obj[k - 1])) {
      const end = obj.indexOf('"', k + 6)
      return end > 0 ? obj.slice(k + 6, end) : null
    }
  }
  return null
}

// `name:<param>.name` in a factory `function F(param){return{...}}`: the `name:"..."` of the object each call `F({...})` passes
// skipped: collects each call whose object has no literal `name:`, written as the call
function resolveMember(expr, objectStart, skipped) {
  const f = factoryBefore(objectStart)
  const m = /^([A-Za-z_$][\w$]*)\.name$/.exec(expr)
  if (!f || !m || f.params[0] !== m[1]) return []
  const names = new Set()
  for (const c of factoryCalls(f.fn, f.params.length, 'object')) {
    const v = nameLiteralOf(objectAt(c.at))
    if (v) names.add(v)
    else skipped.add(f.fn + '(' + c.args[0].slice(0, 60) + (c.args.length > 1 ? ',...' : '') + ') has no literal name:')
  }
  return [...names]
}

function resolveIdent(id, objectStart, skipped) {
  const literals = new Set()
  // a factory's parameter: `function F(a,b){return{...name:a...}}` (or an arrow) and each call `F("literal",...)`
  const f = factoryBefore(objectStart)
  const at = f ? f.params.indexOf(id) : -1
  if (at >= 0) {
    for (const c of factoryCalls(f.fn, f.params.length)) {
      const v = stringArg(c.args, at)
      if (v !== null && NAME_SHAPE.test(v)) literals.add(v)
      else skipped.add(f.fn + '(' + c.args.slice(0, at + 1).map((x) => x.slice(0, 40)).join(',') + ',...) has no command-shaped string literal as argument ' + (at + 1))
    }
    return [...literals]
  }
  // a variable, declared in another module of the bundle (`var pPe="low-priority"`): the minifier reuses names across modules, so it counts only when exactly one command-shaped literal is ever assigned to it
  const def = new RegExp('(?<![\\w$.:"])' + escId(id) + '="([^"]*)"', 'g')
  const all = new Set()
  let m
  while ((m = def.exec(src))) if (NAME_SHAPE.test(m[1])) all.add(m[1])
  return all.size === 1 ? [...all] : []
}

let defsCache = null
function commandDefs() {
  if (defsCache) return defsCache
  const defs = []
  const unresolved = new Set()
  // a literal of any shape, an identifier or member expression, or any other expression up to its `,` or `}`
  const re = /name:(?:"([^"\n]+)"|([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)(?=[,}])|([^,}"\n][^,}\n]{0,80}))/g
  let m
  while ((m = re.exec(src))) {
    let d = 0
    let s = m.index
    for (; s >= 0; s--) {
      if (src[s] === '}') d++
      else if (src[s] === '{') {
        if (d === 0) break
        d--
      }
    }
    const type = topLevelType(s)
    if (!type) continue
    const local = type === 'local' || type === 'local-jsx'
    // userFacingName (a method or a getter) at the top level of the command's object
    const ufn = local && /[,{](?:get\s+)?userFacingName\b/.test(objectAt(s))
    if (m[1]) defs.push({ names: [m[1]], type, ufn })
    else if (local) {
      const expr = m[2] || m[3]
      if (m[2] && /\.name$/.test(m[2]) && PLUGIN_FACTORY.test(objectAt(s))) continue // the plugin-registration factory: names given at run time
      const names = m[2] && !m[2].includes('.') ? resolveIdent(m[2], s, unresolved) : m[2] ? resolveMember(m[2], s, unresolved) : []
      if (names.length) defs.push({ names, type, ufn })
      else unresolved.add(expr.trim())
    }
  }
  return (defsCache = { defs, unresolved: [...unresolved].sort() })
}

// The `type:"..."` of each object literal naming the command
function typesOf(name) {
  return commandDefs().defs.filter((x) => x.names.includes(name)).map((x) => x.type)
}

test('every LOCAL_BUILTINS entry is a local or local-jsx command in the installed engine, never a prompt', { skip: skipWhy || (typesOf('compact').length === 0 ? 'the engine\'s command definitions are not readable here' : false) }, () => {
  const wrong = [...LOCAL_BUILTINS].filter((n) => {
    const t = typesOf(n)
    return !t.some((x) => x === 'local' || x === 'local-jsx') || t.includes('prompt')
  })
  assert.deepEqual(wrong, [])
})

// `/branch` is the typed command that creates a fork. prompt.submit's `command.name` is the command's canonical name, never the alias that was typed: the engine resolves the typed name to the command object (`Zs(typed, commands)`: name, userFacingName or alias) and builds `command:{name: userFacingName?.() ?? name, ...}` from that object (engine 2.1.316, read), so LOCAL_BUILTINS lists canonical names only. The engine defines no alias for `branch` anyway (`/fork` is another command: a background agent); the alias assertions below only make a later change show.
test('/branch is in LOCAL_BUILTINS, and the engine gives it no alias', { skip: skipWhy || (objectsOf('branch').length === 0 ? 'the engine\'s command definitions are not readable here' : false) }, () => {
  assert.ok(LOCAL_BUILTINS.has('branch'))
  const defs = objectsOf('branch').filter((o) => o.includes('type:"local-jsx"'))
  assert.equal(defs.length, 1)
  assert.doesNotMatch(defs[0], /aliases:/)
  assert.doesNotMatch(src, /aliases:\[[^\]]*"branch"/) // no other command takes the name as an alias
  assert.doesNotMatch(src, /aliases:\[[^\]]*"fork"/) // and `fork` is not an alias of anything, so not of /branch
  assert.equal(LOCAL_BUILTINS.has('fork'), false)
})

// What prompt.submit's `command.name` carries is `userFacingName?.() ?? name`: a listed command that defines userFacingName could carry a name LOCAL_BUILTINS does not hold
test('no LOCAL_BUILTINS command defines userFacingName, so prompt.submit carries its listed name', { skip: skipWhy || (typesOf('compact').length === 0 ? 'the engine\'s command definitions are not readable here' : false) }, () => {
  const renamed = [...LOCAL_BUILTINS].filter((n) => commandDefs().defs.some((x) => x.ufn && x.names.includes(n)))
  assert.deepEqual(renamed, [])
  assert.ok(commandDefs().defs.some((x) => x.ufn), 'the scan found no userFacingName at all: it cannot be trusted') // autocompact, pause-memory and autofix-pr have one
})

// Every `local` / `local-jsx` command in the engine, as a name
function localCommandNames() {
  return new Set(commandDefs().defs.filter((x) => x.type === 'local' || x.type === 'local-jsx').flatMap((x) => x.names))
}

// Local commands left OUT of LOCAL_BUILTINS, each with why (reviewed against engine 2.1.316). A typed command in this list counts as a send, except clear and compact, which register.mjs handles by name (see below).
// An entry the engine later drops is harmless. A command new to the engine must be added to LOCAL_BUILTINS (after reading that it never sends to the model) or here, with a reason.
// The criterion for LOCAL_BUILTINS: the command never sends the conversation to the model. A dialog action that only compacts it counts like /compact, which is exempt: `rewind` stays listed although its dialog offers "Summarize from here" and "Summarize up to here", a partial compaction.
// How the model is reached: a local command's result `type:"query"` (only ultrareview, import, goal), a local-jsx `onDone(.., { shouldQuery: true })` (only login, workflows, ultrareview, permissions, plan, goal), or a model request the command makes itself.
const EXCLUDED = {
  // can send to the model
  login: 'after signing in it re-sends when the last message was an authentication_failed error (shouldQuery)',
  permissions: 'picking retry on a denied tool in its dialog re-sends (shouldQuery)',
  goal: 'setting a goal returns type "query" / shouldQuery: Claude starts working on it',
  import: 'the local variant returns type "query" with an import prompt',
  ultrareview: 'launches the review and returns type "query" / shouldQuery',
  workflows: 'resuming a workflow from its list returns shouldQuery',
  recap: 'makes its own model request over the conversation to write the recap',
  fork: 'starts a background agent that gets the directive and the whole conversation',
  subtask: 'sends a subagent off with the full context and the task',
  background: 'with a prompt argument it starts a background session that runs it',
  ultraplan: 'drafts the plan in a cloud session from the prompt',
  'autofix-pr': 'a cloud session works on the PR\'s issues',
  'workflow-launch-exec': 'runs a server-launched workflow handoff',
  '__remote-workflow': 'runs the workflow script a server-launched session was handed (hidden, server-launched sessions only)',
  schedule: 'the engine\'s own /schedule is a hidden Enterprise-upsell text stub (the A2 factory), but `schedule` is also a bundled skill, a prompt command that sends to the model, and which of the two a typed /schedule reaches depends on the account',
  // can continue the model's work or open a page; hidden or gated, and not read to the end
  'low-priority': 'continues the request the 5-hour limit stopped at lower priority, which sends to the model; its chunk is not read to the end',
  'limit-reset': 'uses a limit reset and keeps working, which continues the request; not read to the end',
  'claim-credit': 'opens the page of the offer shown at start-up; hidden and gated; not read to the end',
  // handled in register.mjs code, not by the list
  clear: 'handled by name in prompt.submit and by its SessionStart (source clear)',
  compact: 'handled by name in prompt.submit and by the compaction tracking',
  // not reviewed to the end: hidden, gated, disabled or rare, so left counted as a send until read
  advisor: 'sets the advisor model; not read to the end',
  artifacts: 'gated (artifacts); not read',
  'auto-mode-setup': 'its local variant takes wizard flags that apply rules; not read',
  autocompact: 'sets the auto-compact window; not read to the end',
  brief: 'toggles brief-only mode and adds a system reminder for the model; no query seen, gated by a flag',
  chrome: 'opens Claude in Chrome settings; gated to claude.ai accounts; not read to the end',
  'cloud-plugins': 'cloud-session plugin forwarding choice; gated; not read',
  daemon: 'manages background services and routines; not read',
  'design-consent': 'hidden, gated to Design; not read',
  'design-login': 'gated to Design; not read',
  'design-revoke': 'hidden, gated to Design; not read',
  focus: 'toggles the focus view; not read to the end',
  heapdump: 'hidden, policy gated; not read',
  install: 'installs the native build; not read',
  'install-slack-app': 'gated to claude.ai accounts; not read',
  'list-agents': 'lists subagents and peers; gated; not read to the end',
  loops: 'disabled in this build (isEnabled false)',
  passes: 'hidden unless eligible; not read',
  'pause-memory': 'disabled in this build (isEnabled false)',
  'pro-trial-expired': 'hidden prompt shown by the engine itself',
  'rate-limit-options': 'shown by the engine on a limit; not read',
  'remote-control': 'connects the session to the phone or claude.ai/code; not read',
  'remote-env': 'gated to cloud agents; not read',
  restart: 'restarts Claude Code and resumes the session; not read',
  sandbox: 'sandbox settings; not read to the end',
  'scroll-speed': 'mouse wheel setting; not read to the end',
  'setup-bedrock': 'hidden unless Bedrock is in use; not read',
  'setup-vertex': 'hidden unless Vertex is in use; not read',
  'skill-doctor': 'reports unused skills; not read to the end',
  stop: 'stops a background session; not read to the end',
  teleport: 'sends the session to the cloud or resumes one; gated; not read',
  tui: 'sets the terminal renderer and restarts; not read',
  'usage-credits': 'configures usage credits; its dialog can hand on /upgrade (a local command); not read to the end',
  'web-setup': 'gated to claude.ai accounts; not read',
  wellbeing: 'disabled in this build (isEnabled false)',
}

test('every local or local-jsx command in the installed engine is in LOCAL_BUILTINS or in the reviewed exclusion list', { skip: skipWhy || (typesOf('compact').length === 0 ? 'the engine\'s command definitions are not readable here' : false) }, () => {
  const unreviewed = [...localCommandNames()].filter((n) => !LOCAL_BUILTINS.has(n) && !Object.hasOwn(EXCLUDED, n)).sort()
  assert.deepEqual(unreviewed, [], 'new local command(s): read that each never sends to the model, then add to LOCAL_BUILTINS in register.mjs, or to EXCLUDED here with the reason')
})

test('no command is both in LOCAL_BUILTINS and in the exclusion list, and every exclusion has a reason', () => {
  for (const [name, why] of Object.entries(EXCLUDED)) {
    assert.equal(LOCAL_BUILTINS.has(name), false, name + ' is excluded and listed')
    assert.ok(typeof why === 'string' && why.length > 10, name + ' has no reason')
  }
})

// A command whose `name:` is an identifier, member or other expression that no string literal explains would pass unseen: fail on it, naming the expression
test('every local or local-jsx command whose name is not a literal resolves to a string literal (the plugin-registration factory aside)', { skip: skipWhy || (typesOf('compact').length === 0 ? 'the engine\'s command definitions are not readable here' : false) }, () => {
  assert.deepEqual(commandDefs().unresolved, [], 'a name: in a local command that the test cannot resolve to a literal: read that command and extend resolveIdent / resolveMember, or list it by hand')
})

// The upsell factory `A2({name:"schedule",...})` gives six commands a member-expression name (`name:e.name`): they must be found, or this scan would pass without them
test('commands made by a factory taking an object ({name:"..."}) are found by that name', { skip: skipWhy || (typesOf('compact').length === 0 ? 'the engine\'s command definitions are not readable here' : false) }, () => {
  const names = localCommandNames()
  for (const n of ['ultraplan', 'ultrareview', 'teleport', 'remote-control', 'schedule', 'autofix-pr']) assert.ok(names.has(n), n + ' is not found')
  assert.ok(names.has('__remote-workflow'), 'a literal name that is not a plain command name is skipped')
})

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

// The `type:"..."` of each object literal holding `name:"<name>"`
function typesOf(name) {
  const out = []
  for (const obj of objectsOf(name)) {
    let d = 0
    for (let k = 0; k < obj.length; k++) {
      if (obj[k] === '{') d++
      else if (obj[k] === '}') d--
      else if (d === 1 && obj.startsWith('type:"', k) && /[,{]/.test(obj[k - 1])) {
        out.push(obj.slice(k + 6, obj.indexOf('"', k + 6)))
        break
      }
    }
  }
  return out
}

test('every LOCAL_BUILTINS entry is a local or local-jsx command in the installed engine, never a prompt', { skip: skipWhy || (typesOf('compact').length === 0 ? 'the engine\'s command definitions are not readable here' : false) }, () => {
  const wrong = [...LOCAL_BUILTINS].filter((n) => {
    const t = typesOf(n)
    return !t.some((x) => x === 'local' || x === 'local-jsx') || t.includes('prompt')
  })
  assert.deepEqual(wrong, [])
})

// `/branch` is the typed command that creates a fork; LOCAL_BUILTINS must name every spelling of it. The engine defines no alias for it (`/fork` is another command: a background agent), so `branch` alone is listed.
test('/branch is in LOCAL_BUILTINS, and the engine gives it no alias that would also have to be listed', { skip: skipWhy || (objectsOf('branch').length === 0 ? 'the engine\'s command definitions are not readable here' : false) }, () => {
  assert.ok(LOCAL_BUILTINS.has('branch'))
  const defs = objectsOf('branch').filter((o) => o.includes('type:"local-jsx"'))
  assert.equal(defs.length, 1)
  assert.doesNotMatch(defs[0], /aliases:/)
  assert.doesNotMatch(src, /aliases:\[[^\]]*"branch"/) // no other command takes the name as an alias
  assert.doesNotMatch(src, /aliases:\[[^\]]*"fork"/) // and `fork` is not an alias of anything, so not of /branch
  assert.equal(LOCAL_BUILTINS.has('fork'), false)
})

// Every `local` / `local-jsx` command in the engine, as a name: one pass over the source (a `typesOf` per name would scan it 100 times)
function localCommandNames() {
  const names = new Set()
  const re = /name:"([a-z][a-z0-9-]*)"/g
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
    // the object's top-level `type:"..."`, scanned forward and stopped at the object's end
    d = 0
    for (let k = s; k < src.length && k - s <= 6000; k++) {
      if (src[k] === '{') d++
      else if (src[k] === '}') {
        if (--d === 0) break
      } else if (d === 1 && src.startsWith('type:"', k) && /[,{]/.test(src[k - 1])) {
        const t = src.slice(k + 6, src.indexOf('"', k + 6))
        if (t === 'local' || t === 'local-jsx') names.add(m[1])
        break
      }
    }
  }
  return names
}

// Local commands left OUT of LOCAL_BUILTINS, each with why (reviewed against engine 2.1.316). A typed command in this list counts as a send.
// An entry the engine later drops is harmless. A command new to the engine must be added to LOCAL_BUILTINS (after reading that it never sends to the model) or here, with a reason.
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

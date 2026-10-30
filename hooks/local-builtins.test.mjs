// Run with `node --test hooks/local-builtins.test.mjs`: it reads the installed engine, which `claude plugin test` cannot.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { LOCAL_BUILTINS } from './register.mjs'

const dir = join(homedir(), '.local', 'share', 'claude', 'versions')
let bin = ''
try {
  const found = readdirSync(dir).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).pop()
  if (found) bin = join(dir, found)
} catch {
  // no engine install in the usual place
}
const src = bin ? readFileSync(bin, 'latin1') : ''

// The `type:"..."` of each object literal holding `name:"<name>"`
function typesOf(name) {
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
    const obj = src.slice(s, e + 1)
    d = 0
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

test('every LOCAL_BUILTINS entry is a local or local-jsx command in the installed engine, never a prompt', { skip: !bin || typesOf('compact').length === 0 ? 'the engine\'s command definitions are not readable here' : false }, () => {
  const wrong = [...LOCAL_BUILTINS].filter((n) => {
    const t = typesOf(n)
    return !t.some((x) => x === 'local' || x === 'local-jsx') || t.includes('prompt')
  })
  assert.deepEqual(wrong, [])
})

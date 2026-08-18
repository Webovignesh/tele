'use strict'

/* Source and behaviour invariants for the download folder: the picker (task 7.4)
 * and the Save-to control (task 8.4).
 *
 * Both defects were declared fixed several times on this branch while nothing
 * changed, and in both cases the reason was a competitor that was left in the tree
 * rather than removed: a second picker endpoint that no process could reach, and a
 * 54px CSS rule at two ID selectors that outranked three injected
 * `width: 100% !important` overrides. So the assertions here are mostly about
 * ABSENCE. They assert that the competitors are gone rather than trusting it, which
 * is what makes clauses 2.15, 2.16 and 2.20 provable at the source level.
 *
 * The native dialog itself cannot be unit tested - no headless test can drive it or
 * see its chrome - which is why TEST C (task 12.3) exists. What can be tested is
 * which Windows API the script asks for, which flags it passes, how it reads the
 * result, and what the endpoint does with each of the three answers the child can
 * give. That is what this file covers.
 */

const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const assert = require('node:assert/strict')

const root = path.resolve(__dirname, '..')
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8')

const server = read('server.js')
const html = read('public/index.html')
const app = read('public/app.js')

const publicDir = path.join(root, 'public')
const publicJs = fs.readdirSync(publicDir).filter(name => name.endsWith('.js'))
const publicCss = fs.readdirSync(publicDir).filter(name => name.endsWith('.css'))
const rootJs = fs.readdirSync(root).filter(name => name.endsWith('.js') && fs.statSync(path.join(root, name)).isFile())

/* Comments must not satisfy or break an invariant.
 *
 * Several of the deletions this fix makes leave a comment behind explaining what was
 * removed and why - that is deliberate, because the next person to touch this area
 * needs to know the 54px rule existed. Those comments name `#dl-dir`,
 * `#fg-hardening-style` and `Split-Path -Parent`, so an assertion that grepped raw
 * text would pass on prose or fail on an explanation. Everything below is asserted
 * against code with comments removed.
 *
 * The scanner tracks string and template literals so a `//` inside a URL is not
 * mistaken for a line comment. */
/* Line-based rather than character-based, deliberately.
 *
 * A character scanner has to tell a regex literal from a division operator to know
 * whether `"` inside `/[&<>"']/` opens a string, and getting that wrong silently
 * desynchronises the rest of the file - which is exactly the kind of quiet
 * false-pass these assertions exist to prevent. Every explanatory comment in this
 * codebase is a block comment with ` * ` continuation lines or a `//` line, so
 * dropping comment-only lines removes all of the prose while leaving every line that
 * can actually execute. */
function stripJsComments (source) {
  return source
    .split('\n')
    .filter(line => {
      const trimmed = line.trim()
      return !(trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*/') || trimmed.startsWith('*'))
    })
    .join('\n')
}

function stripCssComments (source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ')
}

const codeOf = new Map()
for (const name of publicJs) codeOf.set(`public/${name}`, stripJsComments(read(`public/${name}`)))
for (const name of rootJs) codeOf.set(name, stripJsComments(read(name)))
const cssOf = new Map()
for (const name of publicCss) cssOf.set(`public/${name}`, stripCssComments(read(`public/${name}`)))

const serverCode = codeOf.get('server.js')
const appCode = codeOf.get('public/app.js')

/* ==================================================================== */
/* Task 7.4 - the folder picker                                          */
/* ==================================================================== */

/* Exactly one endpoint owns folder selection, and it is in the process `npm start`
 * launches rather than in a preload that may or may not be wrapped (clause 2.15). */
const ROUTE = '/api/filegram/pick-download-folder'
const routeOwners = [...codeOf].filter(([, code]) => code.includes(`'${ROUTE}'`) && /app\.post\(/.test(code)).map(([name]) => name)
assert.deepEqual(routeOwners, ['server.js'], `exactly one file may register the picker route, saw ${JSON.stringify(routeOwners)}`)
for (const [name, code] of codeOf) {
  if (name === 'server.js') continue
  assert.doesNotMatch(code, /pick-download-folder-modern/, `${name} must not reference the dormant -modern endpoint`)
}
assert.ok(!fs.existsSync(path.join(root, 'native-folder-picker-preload.js')), 'the duplicate picker preload must be deleted, not left dormant')
assert.doesNotMatch(read('package.json'), /native-folder-picker-preload/, 'no start or check script may name the deleted preload')

/* The dialog is the Windows common item dialog in folder-pick mode. */
assert.match(serverCode, /IFileOpenDialog/, 'the picker must use the common item dialog interface')
assert.match(serverCode, /d57c7288-d4ad-4768-be02-9d969532d960/, 'IFileOpenDialog must be identified by its real IID')
assert.match(serverCode, /43826d1e-e718-42ee-bc55-a1e261c37bfe/, 'IShellItem must be identified by its real IID')
assert.match(serverCode, /DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7/i, 'the FileOpenDialog coclass must be identified by its real CLSID')
assert.match(serverCode, /FOS_PICKFOLDERS = 0x00000020/, 'folder-pick mode must be requested by its real flag value')
assert.match(serverCode, /FOS_FORCEFILESYSTEM = 0x00000040/, 'the result must be constrained to the file system')
assert.match(serverCode, /FOS_PATHMUSTEXIST = 0x00000800/, 'the chosen path must be required to exist')
assert.match(serverCode, /SetOptions\(options \| FOS_PICKFOLDERS \| FOS_FORCEFILESYSTEM \| FOS_PATHMUSTEXIST\)/, 'all three flags must be set together, on top of the dialog defaults')

/* The result is read from the dialog, never derived from a file name. */
assert.match(serverCode, /SIGDN_FILESYSPATH = 0x80058000/, 'the path must be read as a filesystem path')
assert.match(serverCode, /dialog\.GetResult\(out chosen\)/, 'the chosen item must come from GetResult')
assert.match(serverCode, /chosen\.GetDisplayName\(SIGDN_FILESYSPATH, out chosenPath\)/, 'the directory must come from GetDisplayName(SIGDN_FILESYSPATH)')

/* The two mechanisms that produced the reported defect must be absent from the whole
 * tree, not merely from the surviving endpoint. `FolderBrowserDialog` is the small
 * legacy tree window the user reported seeing; `Split-Path -Parent` of a synthetic
 * file name is what fabricated the returned directory (clauses 1.14, 1.17). */
for (const [name, code] of codeOf) {
  assert.doesNotMatch(code, /FolderBrowserDialog/, `${name} must not use the legacy Browse For Folder tree dialog`)
  assert.doesNotMatch(code, /BrowseForFolder/, `${name} must not use the Shell.Application folder browser`)
  assert.doesNotMatch(code, /Split-Path\s+-Parent/, `${name} must not derive a chosen directory from a file name`)
  assert.doesNotMatch(code, /Select this folder/, `${name} must not put a synthetic file name in the dialog`)
}

/* The script is passed as base64 utf16le rather than as a -Command string, so a path
 * or a quote in it cannot be reinterpreted by the shell. */
assert.match(serverCode, /'-NoProfile', '-STA', '-EncodedCommand', Buffer\.from\(script, 'utf16le'\)\.toString\('base64'\)/, 'the script must be passed as an encoded command')

/* The response identifies the dialog that actually ran. At HEAD there was no such
 * field, so a stale process could not be ruled out from the response body. */
assert.match(serverCode, /const PICKER_PRIMARY = 'IFileOpenDialog'/, 'the primary implementation must be named')
assert.match(serverCode, /const PICKER_FALLBACK = 'OpenFileDialog'/, 'the fallback implementation must be named')
assert.match(serverCode, /implementation: PICKER_PRIMARY/, 'a successful pick must report which dialog ran')

/* Declared degradation. The fallback is an Explorer-shell FILE chooser used as a
 * folder chooser; it is allowed, but it must announce itself, and it must still not
 * fabricate the directory. */
assert.match(serverCode, /\$dialog\.ValidateNames = \$false/, 'the documented fallback must disable name validation')
assert.match(serverCode, /\[System\.IO\.Path\]::GetDirectoryName\(\$dialog\.FileName\)/, 'the fallback must resolve a real directory, not a synthetic parent')
assert.match(serverCode, /Test-Path -LiteralPath \$candidate -PathType Container/, 'the fallback must confirm the resolved path is a real directory')
assert.match(serverCode, /implementation: PICKER_FALLBACK, degraded: true/, 'the fallback must be reported, never substituted silently')

/* A real cancel is HRESULT_FROM_WIN32(ERROR_CANCELLED). */
assert.match(serverCode, /CANCELLED = unchecked\(\(int\)0x800704C7\)/, 'a cancel must be recognised by its real HRESULT')
assert.match(serverCode, /if \(hr == CANCELLED\) return null;/, 'a cancel must return no path rather than throwing')

/* Behaviour: the real `readPickerAnswer` from server.js, executed. This is the
 * function that decides cancel from path from unavailable, so its three outcomes are
 * checked against the real implementation rather than against a description of it. */
function extractFunction (source, header) {
  const start = source.indexOf(header)
  assert.notEqual(start, -1, `expected to find ${header}`)
  const open = source.indexOf('{', start)
  let depth = 0
  for (let index = open; index < source.length; index++) {
    if (source[index] === '{') depth++
    else if (source[index] === '}') {
      depth--
      if (!depth) return source.slice(start, index + 1)
    }
  }
  throw new Error(`unbalanced braces after ${header}`)
}

const answerSandbox = { module: {} }
vm.createContext(answerSandbox)
vm.runInContext(`${extractFunction(serverCode, 'function readPickerAnswer')}\nmodule.answer = readPickerAnswer`, answerSandbox)
const readPickerAnswer = answerSandbox.module.answer

// Compared field by field: the answers are constructed inside the vm realm, so their
// prototype is that realm's Object.prototype and a strict deep comparison against a
// host literal fails on identity rather than on value.
const chosen = readPickerAnswer({ code: 0, stdout: 'FILEGRAM_PATH:F:\\New\\Tamil', stderr: '' })
assert.equal(chosen.kind, 'path', 'a chosen directory must be reported as a path')
assert.equal(chosen.path, 'F:\\New\\Tamil', 'the chosen directory must be returned verbatim')

const cancelled = readPickerAnswer({ code: 0, stdout: 'FILEGRAM_CANCELLED', stderr: '' })
assert.equal(cancelled.kind, 'cancelled', 'a real cancel must be reported as cancelled')
assert.equal(cancelled.path, undefined, 'a cancel must carry no path')
/* The reported defect, from the other side: an abnormally terminated dialog exited
 * 4294967295, the route answered HTTP 500 `Folder picker exited with code
 * 4294967295`, and public/app.js toasted that string verbatim at the user. A dialog
 * that produced no selection is a cancel as far as the configured folder is
 * concerned, and no exit code may reach the UI. */
const unavailable = readPickerAnswer({ code: 4294967295, stdout: '', stderr: 'Add-Type : cannot compile' })
assert.equal(unavailable.kind, 'unavailable', 'a child that never reached the dialog must be reported as unavailable so the fallback can run')
assert.equal(unavailable.path, undefined, 'an unavailable shim must carry no path')

/* The discriminator that stops a dismissed dialog from opening a second one. The script
 * writes and flushes FILEGRAM_READY after Add-Type succeeds and before Show(), so a child
 * that showed a dialog and then went away without a result is an abnormal CLOSE, not an
 * unavailable shim. Without it the endpoint fell back and put a second dialog on screen on
 * top of the one just dismissed - observed while verifying this endpoint. */
const closedAbnormally = readPickerAnswer({ code: 4294967295, stdout: 'FILEGRAM_READY', stderr: '' })
assert.equal(closedAbnormally.kind, 'cancelled', 'a dialog that was on screen and closed with no result must be reported as a cancel')
assert.equal(closedAbnormally.reason, 'dialog-closed', 'the reason must distinguish an abnormal close from a real cancel')
assert.equal(closedAbnormally.path, undefined, 'an abnormal close must carry no path')
assert.equal(readPickerAnswer({ code: 0, stdout: 'FILEGRAM_READYFILEGRAM_CANCELLED', stderr: '' }).reason, 'cancelled', 'a real cancel must still be reported as a cancel')
assert.match(serverCode, /const ranDialog = text\.includes\('FILEGRAM_READY'\)/, 'the fallback must be gated on whether the shim reached the dialog')
assert.match(serverCode, /\[Console\]::Out\.Write\('FILEGRAM_READY'\)/, 'the script must announce that it reached the dialog')
assert.equal(readPickerAnswer({ code: 0, stdout: 'FILEGRAM_PATH:   ', stderr: '' }).kind, 'unavailable', 'an empty path must never be reported as a chosen directory')
assert.doesNotMatch(serverCode, /exited with code/, 'a raw exit code must never reach the response body')
assert.match(serverCode, /error: 'The folder picker could not open on this computer\. Nothing was changed\.'/, 'a picker failure must be reported as a sentence')

/* Cancel leaves the configured folder untouched: the handler returns before it can
 * issue `set-download-dir` (clause 3.10). */
const handler = extractFunction(appCode, "$('#set-dir').onclick = async ()")
assert.match(handler, /if \(payload\.cancelled \|\| !payload\.path\) return/, 'a cancelled pick must return before anything is changed')
assert.ok(
  handler.indexOf('if (payload.cancelled || !payload.path) return') < handler.indexOf("request('set-download-dir'"),
  'the cancel check must precede the set-download-dir call'
)

/* ==================================================================== */
/* Task 8.4 - the Save-to control                                        */
/* ==================================================================== */

/* Exactly one binding on the node, and it is app.js's (clause 2.16). */
const clickBinders = [...codeOf].filter(([, code]) => /#set-dir'\)\.onclick|#set-dir"\)\.onclick/.test(code) || /querySelector\('#set-dir'\)[\s\S]{0,40}addEventListener\('click'/.test(code)).map(([name]) => name)
assert.deepEqual(clickBinders, ['public/app.js'], `exactly one file may bind the Save-to control, saw ${JSON.stringify(clickBinders)}`)
for (const [name, code] of codeOf) {
  if (name === 'public/app.js') continue
  assert.doesNotMatch(code, /#set-dir'\)\?\.addEventListener/, `${name} must not add a listener to the Save-to control`)
  assert.doesNotMatch(code, /replaceWith\(clone\)/, `${name} must not clone-replace a node and discard another layer's handler`)
}

/* Nobody paints it but `setDirLabel`. Writing innerHTML or textContent on this node
 * is what let three layers produce three different internal structures, with the
 * last writer deciding what the user saw. */
for (const [name, code] of codeOf) {
  if (name === 'public/app.js') continue
  assert.doesNotMatch(code, /#set-dir'\)[\s\S]{0,200}\.innerHTML\s*=/, `${name} must not rewrite the Save-to control's markup`)
}
assert.match(appCode, /function setDirLabel \(dir\)/, 'app.js must own the single painter')
assert.match(appCode, /\$\('#dl-dir-path'\)/, 'the painter must write the path node inside the control')

/* Both injected stylesheets are gone. Each was one of the three
 * `width: 100% !important` rules that lost the cascade to the 54px rule. */
for (const [name, code] of codeOf) {
  assert.doesNotMatch(code, /fg-hardening-style/, `${name} must not inject the hardening stylesheet`)
  assert.doesNotMatch(code, /fg-download-folder-v2-style/, `${name} must not inject the v2 folder stylesheet`)
}

/* The legacy nodes are absent from the markup, not hidden. With nothing in the tree
 * there is no "which of three controls is visible" question left to answer, and no
 * hidden node that a future stylesheet could put back into layout (clause 2.20). */
assert.doesNotMatch(html, /id="dl-dir"/, '#dl-dir must be removed from the markup')
assert.doesNotMatch(html, /id="dl-dir-current"/, '#dl-dir-current must be removed from the markup')
assert.doesNotMatch(html, /class="dir-current/, 'the legacy path line must be removed from the markup')
assert.match(html, /<button id="set-dir" class="fg-save-to" type="button"/, 'the control must be one button carrying fg-save-to')
assert.match(html, /id="dl-dir-path"/, 'the control must carry one path display')
assert.equal((html.match(/id="set-dir"/g) || []).length, 1, 'exactly one Save-to control may exist in the markup')

/* No code addresses the removed nodes any more. `#dl-dir-path` is a different node
 * and is the one the painter writes, so it is excluded by the negative lookahead. */
const removedNodeSelector = /#dl-dir(?!-path)|#dl-dir-current|\.dir-current|\.fg-folder-path|\.fg-folder-copy|\.fg-folder-label/
for (const [name, code] of codeOf) {
  assert.doesNotMatch(code, removedNodeSelector, `${name} must not reference a removed Save-to node`)
}
for (const [name, css] of cssOf) {
  assert.doesNotMatch(css, /#dl-dir(?!-path)|#dl-dir-current|\.dir-current/, `${name} must not style a removed Save-to node`)
}

/* Exactly one stylesheet declares a width for the control, and it addresses it by
 * class so it cannot be confused with a rule aimed at the old button.
 *
 * This is the assertion that would have caught the reported defect: at HEAD four
 * rules in three stylesheets plus two injected blocks declared a width for
 * `#set-dir`, and the one that won was the one nobody was editing. */
/* Only rules whose SUBJECT is the control count. A rule ending in a descendant, such
 * as `#set-dir.fg-save-to .fg-save-to-path { min-width: 0 }`, sizes a span inside the
 * control and cannot decide the control's own width. */
function targetsControlItself (selectorList) {
  return selectorList.split(',').some(part => {
    const compounds = part.trim().split(/\s+|>/).filter(Boolean)
    const subject = compounds[compounds.length - 1] || ''
    return subject.includes('#set-dir')
  })
}

const widthDeclaring = []
for (const [name, css] of cssOf) {
  for (const block of css.split('}')) {
    const parts = block.split('{')
    if (parts.length !== 2) continue
    const [selector, body] = parts
    if (!/#set-dir/.test(selector)) continue
    if (!targetsControlItself(selector)) continue
    if (!/(^|[;\s])(width|min-width|max-width)\s*:/.test(body)) continue
    widthDeclaring.push({ file: name, selector: selector.trim().replace(/\s+/g, ' ') })
  }
}
assert.equal(widthDeclaring.length, 1, `exactly one stylesheet rule may declare a width for #set-dir, saw ${JSON.stringify(widthDeclaring)}`)
assert.equal(widthDeclaring[0].file, 'public/filegram-ui.css', 'the surviving width rule must live in filegram-ui.css')
assert.match(widthDeclaring[0].selector, /#set-dir\.fg-save-to/, 'the surviving width rule must address the control by its class')
/* Two ID selectors, both parents, one rule: `management.js` moves the panel's
 * children into #mg-downloads-pane at run time, so the rule has to win in either
 * place without needing !important. */
assert.match(widthDeclaring[0].selector, /#mg-downloads-pane #set-dir\.fg-save-to, \.downloads #set-dir\.fg-save-to/, 'the rule must address both runtime parents in one selector list')
const saveToBlock = cssOf.get('public/filegram-ui.css').split('#mg-downloads-pane #set-dir.fg-save-to,')[1].split('}')[0]
assert.doesNotMatch(saveToBlock, /!important/, 'the surviving rule must not need !important once the competitors are gone')
assert.match(cssOf.get('public/filegram-ui.css'), /\.fg-save-to-path,[\s\S]{0,120}\{[\s\S]{0,240}text-overflow: ellipsis/, 'the path must ellipsise rather than clip')
assert.match(cssOf.get('public/filegram-ui.css'), /\.fg-save-to \.fg-save-to-path,[\s\S]*?min-width: 0/, 'the path must be allowed to shrink below its content width')

/* The Parallel-files row must not be selected by sibling index any more. Deleting the
 * Save-to `label.conc` made Parallel the first label, so `:nth-of-type(2)` would have
 * silently stopped matching and changed the slider geometry clause 3.11 pins. */
for (const [name, css] of cssOf) {
  assert.doesNotMatch(css, /\.conc:nth-of-type\(2\)/, `${name} must not select the Parallel row by sibling index`)
  assert.doesNotMatch(css, /\.conc:first-of-type/, `${name} must not select a .conc row by sibling index`)
}
assert.match(cssOf.get('public/daily-driver-p1.css'), /\.dl-controls \.conc:has\(#concurrency\) > \.row/, 'the Parallel row must be addressed by what it contains')
assert.match(cssOf.get('public/daily-driver-p0.css'), /\.dl-controls \.conc:has\(#concurrency\) > \.row/, 'the Parallel row must be addressed by what it contains')

console.log('download folder checks passed')

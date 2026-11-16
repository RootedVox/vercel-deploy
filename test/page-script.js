// Runs a page script whole, the way the browser does, and then swaps in test doubles.
// Tests used to cut functions out of the source by their indentation and neighbours,
// which broke whenever code moved. Here only names matter:
//   replace  - top-level functions or variables of the script to overwrite
//   expose   - top-level functions or variables to hand back to the test
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

export function runPageScript(name, globals = {}, { replace = {}, expose = [] } = {}) {
  const sandbox = { ForumUI: {}, URLSearchParams, location: { search: '' }, document: {}, window: {}, ...globals };
  // Page scripts register their listeners while loading.
  for (const target of [sandbox.document, sandbox.window]) target.addEventListener ??= () => {};
  sandbox.window.location ??= sandbox.location;
  const context = vm.createContext({ ...sandbox, __replace: replace, __exposed: {} });
  const epilogue = [
    ...Object.keys(replace).map(key => `${key} = __replace[${JSON.stringify(key)}];`),
    ...expose.map(key => `__exposed[${JSON.stringify(key)}] = ${key};`)
  ].join('\n');
  vm.runInContext(`${readFileSync(new URL(`../${name}`, import.meta.url), 'utf8')}\n${epilogue}`, context, { filename: name });
  return context.__exposed;
}

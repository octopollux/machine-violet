import { readFile, writeFile, mkdir, rename, access } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
function assert(ok, message) { if (!ok) throw new Error(message); }
function keys(value, allowed, context) {
  assert(object(value), `${context} must be an object`);
  for (const key of Object.keys(value)) assert(allowed.includes(key), `${context}: unknown field ${key}`);
}
function string(value, context) { assert(typeof value === 'string' && value.trim().length > 0, `${context} must be a nonempty string`); }
function ids(value, known, context) {
  assert(Array.isArray(value), `${context} must be an array`);
  const seen = new Set();
  for (const id of value) { assert(known.has(id), `${context}: unknown id ${id}`); assert(!seen.has(id), `${context}: duplicate id ${id}`); seen.add(id); }
}
function links(value, known, context) {
  assert(Array.isArray(value), `${context} must be an array`);
  const seen = new Set();
  for (const link of value) {
    keys(link, ['target', 'reason'], context); string(link.reason, `${context}.reason`);
    assert(known.has(link.target), `${context}: unknown target ${link.target}`);
    assert(!seen.has(link.target), `${context}: duplicate target ${link.target}`); seen.add(link.target);
  }
}
export function validateState(state) {
  keys(state, ['entities'], 'state'); assert(Array.isArray(state.entities), 'entities must be an array');
  const known = new Set();
  for (const entity of state.entities) {
    keys(entity, ['id', 'name', 'kind', 'data', 'depends_on'], 'entity');
    string(entity.id, 'entity.id'); string(entity.name, 'entity.name');
    assert(!known.has(entity.id), `duplicate entity ${entity.id}`); known.add(entity.id);
    if (entity.kind !== undefined) string(entity.kind, 'entity.kind');
    assert(object(entity.data), 'entity.data must be an object');
  }
  for (const entity of state.entities) links(entity.depends_on, known, entity.id);
  return state;
}
export function applyBatch(state, batch, config = {}) {
  validateState(state); keys(batch, ['updates', 'changed', 'handled', 'notes'], 'batch');
  const known = new Set(state.entities.map((e) => e.id));
  assert(Array.isArray(batch.updates), 'updates must be an array');
  ids(batch.changed, known, 'changed'); ids(batch.handled, known, 'handled');
  assert(Array.isArray(batch.notes) && batch.notes.every((n) => typeof n === 'string'), 'notes must be strings');
  const seen = new Set();
  for (const update of batch.updates) {
    keys(update, ['id', 'name', 'data', 'depends_on'], 'update');
    assert(known.has(update.id), `update: unknown id ${update.id}`);
    assert(!(config.readonly ?? []).includes(update.id), `update: readonly id ${update.id}`);
    assert(!seen.has(update.id), `duplicate update ${update.id}`); seen.add(update.id);
    if (update.name !== undefined) string(update.name, 'update.name');
    if (update.data !== undefined) assert(object(update.data), 'update.data must be an object');
    if (update.depends_on !== undefined) links(update.depends_on, known, 'update.depends_on');
  }
  const after = structuredClone(state);
  for (const update of batch.updates) {
    const entity = after.entities.find((e) => e.id === update.id);
    if (update.name !== undefined) entity.name = update.name;
    if (update.data !== undefined) entity.data = { ...entity.data, ...structuredClone(update.data) };
    if (update.depends_on !== undefined) entity.depends_on = structuredClone(update.depends_on);
  }
  const handled = new Set(batch.handled);
  const reverse = new Map();
  for (const dependent of after.entities) {
    const before = state.entities.find((e) => e.id === dependent.id);
    for (const target of new Set([...before.depends_on, ...dependent.depends_on].map((l) => l.target))) {
      const oldLink = before.depends_on.find((l) => l.target === target);
      const newLink = dependent.depends_on.find((l) => l.target === target);
      const edge = { dependent: dependent.id, target, reasons: [...new Set([oldLink?.reason, newLink?.reason].filter(Boolean))], removed: Boolean(oldLink && !newLink) };
      if (!reverse.has(target)) reverse.set(target, []);
      reverse.get(target).push(edge);
    }
  }
  const candidates = new Map();
  for (const target of batch.changed) {
    const queue = [{ current: target, path: [target], edges: [] }];
    for (let index = 0; index < queue.length; index++) {
      const step = queue[index];
      if (step.edges.length === 2) continue;
      for (const edge of reverse.get(step.current) ?? []) {
        if (step.path.includes(edge.dependent)) continue;
        const next = { current: edge.dependent, path: [...step.path, edge.dependent], edges: [...step.edges, edge] };
        queue.push(next);
        if (handled.has(edge.dependent)) continue;
        if (!candidates.has(edge.dependent)) candidates.set(edge.dependent, { dependent: edge.dependent, candidateOnly: true, paths: [] });
        candidates.get(edge.dependent).paths.push({ target, path: next.path, reasons: next.edges.map((e) => e.reasons), removed: next.edges.some((e) => e.removed) });
      }
    }
  }
  const notices = [...candidates.values()];
  const mutated = after.entities.filter((e, i) => !isDeepStrictEqual(e, state.entities[i])).map((e) => e.id);
  return { state: after, notices: notices.slice(0, 5), overflow: Math.max(0, notices.length - 5), diagnostics: {
    declaredChanged: batch.changed, handled: batch.handled, mutated,
    changedWithoutMutation: batch.changed.filter((id) => !mutated.includes(id)),
    mutatedWithoutChanged: mutated.filter((id) => !batch.changed.includes(id)),
    totalNotices: notices.length, notes: batch.notes,
  } };
}
async function readJson(file) { return JSON.parse(await readFile(file, 'utf8')); }
async function save(file, value) { await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' }); }
const fixtureDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
async function configFor(runDir) {
  try { return await readJson(path.join(runDir, 'config.json')); }
  catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
}
export async function main(args) {
  const [command, first, second, third] = args;
  if (command === 'init' && first && second && !third) {
    const state = validateState(await readJson(first));
    await mkdir(second, { recursive: true });
    await save(path.join(second, 'state.json'), state);
    await save(path.join(second, 'initial.json'), state);
    try { await save(path.join(second, 'config.json'), await readJson(path.join(fixtureDir, 'config.json'))); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    console.log(JSON.stringify({ state }, null, 2)); return;
  }
  if (command === 'prepare' && first && second && !third) {
    assert(/^[a-zA-Z0-9_-]+$/.test(second), 'invalid stage name');
    const stages = await readJson(path.join(fixtureDir, 'stages.json'));
    const stage = stages[second]; assert(stage, `unknown stage ${second}`);
    const statePath = path.join(first, 'state.json');
    let state = await readJson(statePath);
    const marker = path.join(first, `${second}.prepared.json`);
    try { await access(marker); throw new Error('stage already prepared'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (stage.externalBefore) state = applyBatch(state, { updates: stage.externalBefore, changed: [], handled: [], notes: [] }).state;
    await save(marker, { state, prompt: stage.prompt });
    const temp = path.join(first, 'state.next.json'); await save(temp, state); await rename(temp, statePath);
    console.log(JSON.stringify({ state, prompt: stage.prompt }, null, 2)); return;
  }
  assert(command === 'apply' && first && second && third && args.length === 4, 'Usage: runner.mjs init <initial.json> <run-dir> | apply <run-dir> <stage-name> <output.json>');
  assert(/^[a-zA-Z0-9_-]+$/.test(second), 'stage-name must contain only letters, digits, underscores, or hyphens');
  const statePath = path.join(first, 'state.json');
  const before = await readJson(statePath);
  const raw = await readFile(third, 'utf8');
  const stageDir = path.join(first, second);
  try { await access(stageDir); throw new Error('stage already exists'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await mkdir(stageDir);
  await writeFile(path.join(stageDir, 'raw.json'), raw, { flag: 'wx' });
  await save(path.join(stageDir, 'before.json'), before);
  let result;
  try { result = applyBatch(before, JSON.parse(raw), await configFor(first)); }
  catch (error) { await save(path.join(stageDir, 'rejected.json'), { error: error.message }); throw error; }
  await save(path.join(stageDir, 'after.json'), result.state);
  await save(path.join(stageDir, 'diagnostics.json'), result);
  const temp = path.join(first, 'state.next.json');
  await save(temp, result.state); await rename(temp, statePath);
  console.log(JSON.stringify(result, null, 2));
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => { console.error(error.message); process.exitCode = 1; });
}

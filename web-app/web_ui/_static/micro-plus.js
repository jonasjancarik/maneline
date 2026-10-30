'use strict';
const $ = id => document.getElementById(id);
const API = '/api/micro-plus';
const EDITOR_API = '/api/micro-plus/editor';

let state = { connected: false, presets: [], models: {} }; // Latest server reply.
let known = null; // Latest connected reply; stays on screen while the amp is away.
let reachable = true;
let requestRunning = false;
let exclusive = false; // A switch, save or model change owns the amp.
let switchingTo = null;
let epoch = 0; // Discards polls that started before a write.
let reconnectNotice = false;

const pendingEdits = new Map(); // "node/parameter" → newest value not yet sent.
let inFlightKey = null;
let sending = false;
let idleWaiters = [];
let dragging = null;

let selectedNode = null; // The pedal open in the close-up.
let builtKey = '';
let renderedNames = '';
let renderedChanges = '';
let formPreset = null;
let advancedOpen = false;
let showEmpty = storedFlag('mmp-show-empty');
const baselines = new Map(); // "generation:preset" → the saved document, for showing what changed.

const grid = $('presets');
const filter = $('filter');
const nameInput = $('preset-name');
const editorFields = $('editor');

function storedFlag(key) {
  try { return localStorage.getItem(key) === '1'; } catch { return false; }
}
function storeFlag(key, value) {
  try { localStorage.setItem(key, value ? '1' : '0'); } catch { /* Only a convenience. */ }
}
function setText(element, text) {
  if (element.textContent !== text) element.textContent = text; // Keeps live regions quiet.
}
function isEmptySlot(preset) { return !preset.name || /^empty$/i.test(preset.name.trim()); }
function displayName(preset) { return isEmptySlot(preset) ? 'Empty' : preset.name; }
function presetByNumber(number) { return known?.presets.find(preset => preset.preset === number); }
function guard() { return { preset: state.preset, revision: state.revision }; }
function documentName() { return known?.document?.info.displayName.trim() ?? ''; }
function nameChanged() { return Boolean(known?.document) && nameInput.value.trim() !== documentName(); }
function editsWaiting() { return sending || pendingEdits.size > 0; }
function hasChanges() { return Boolean(state.dirty) || nameChanged() || editsWaiting(); }

// Messages -----------------------------------------------------------------
function showMessage(text, kind = '') {
  const message = $('message');
  message.hidden = !text;
  message.dataset.kind = kind;
  setText(message, text);
}

// Talking to the server ----------------------------------------------------
function adopt(next) {
  if (next.connected) {
    const reconnected = known && known.revision?.split(':')[0] !== next.revision?.split(':')[0];
    if (reconnected && known.dirty) reconnectNotice = true;
    // A failure message like "reconnecting to check" is out of date once the amp is back.
    if (reconnected && $('message').dataset.kind === 'error') showMessage(`Reconnected. The amp is on preset ${next.preset}.`);
    // The document is briefly missing while the amp changes preset; keep showing the last one.
    known = next.document || !known ? next : { ...next, document: known.document };
    if (next.document && !next.dirty) baselines.set(baselineKey(next), next.document);
  }
  state = next;
}

function baselineKey(snapshot) { return `${snapshot.revision?.split(':')[0]}:${snapshot.preset}`; }

async function readState() {
  if (requestRunning || exclusive || editsWaiting() || document.hidden) return;
  requestRunning = true;
  const started = epoch;
  try {
    const response = await fetch(API, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error('Unexpected reply');
    const next = await response.json();
    if (started === epoch) { reachable = true; adopt(next); }
  } catch {
    if (started === epoch) { reachable = false; state = { ...state, connected: false, error: null }; }
  } finally {
    requestRunning = false;
    render();
  }
}

async function post(url, body) {
  const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(45000) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'The Micro Plus did not confirm the change.');
  return result;
}

function failureText(error) {
  return error instanceof TypeError || error.name === 'TimeoutError'
    ? 'No reply from the Maneline app, so this change may or may not have reached the amp. Checking…'
    : error.message;
}

// Live edits: the newest value per control wins, and controls stay usable while one is being sent.
function queueEdit(node, parameter, value) {
  pendingEdits.set(`${node}/${parameter}`, { node, parameter, value });
  showMessage('');
  reconnectNotice = false;
  pumpEdits();
  renderStatus();
}

async function pumpEdits() {
  if (sending || exclusive) return;
  const [key, edit] = pendingEdits.entries().next().value ?? [];
  if (!key || !state.connected) {
    pendingEdits.clear();
    idleWaiters.splice(0).forEach(resolve => resolve());
    renderStatus();
    return;
  }
  pendingEdits.delete(key);
  sending = true;
  inFlightKey = key;
  epoch++;
  renderStatus();
  try {
    adopt(await post(EDITOR_API, { action: 'parameter', ...guard(), ...edit }));
  } catch (error) {
    pendingEdits.clear();
    showMessage(failureText(error), 'error');
    builtKey = ''; // Rebuild from what the amp actually has.
  } finally {
    sending = false;
    inFlightKey = null;
    render();
    pumpEdits();
    if (!editsWaiting()) readState();
  }
}

function editsIdle() {
  return new Promise(resolve => {
    if (editsWaiting()) idleWaiters.push(resolve); else resolve();
  });
}

// Operations that need the amp to themselves.
async function exclusiveOperation(url, body, progress, onSuccess) {
  await editsIdle();
  if (exclusive || !state.connected) { switchingTo = null; return false; }
  exclusive = true;
  epoch++;
  const focusKey = editorFields.contains(document.activeElement) ? document.activeElement.dataset?.key : null;
  showMessage(progress);
  render();
  let success = false;
  try {
    adopt(await post(url, body));
    success = true;
    reconnectNotice = false;
    showMessage(onSuccess?.() ?? '');
  } catch (error) {
    showMessage(failureText(error), 'error');
    builtKey = '';
    if (error.message === state.error) state = { ...state, connected: false };
  } finally {
    exclusive = false;
    switchingTo = null;
    render();
    if (focusKey) restoreFocus(focusKey);
    readState();
  }
  return success;
}

function restoreFocus(key) {
  if (document.activeElement && document.activeElement !== document.body) return;
  editorFields.querySelector(`[data-key="${CSS.escape(key)}"]:not(.field)`)?.focus({ preventScroll: true });
}

// Dialogs ------------------------------------------------------------------
function confirmAction(title, text, action) {
  const dialog = $('confirm-dialog');
  $('confirm-title').textContent = title;
  $('confirm-text').textContent = text;
  $('confirm-action').textContent = action;
  dialog.returnValue = 'cancel';
  return new Promise(resolve => {
    dialog.addEventListener('close', () => resolve(dialog.returnValue === 'confirm'), { once: true });
    dialog.showModal();
  });
}

function stillSameEditor(expected) {
  if (state.preset === expected.preset && state.revision === expected.revision) return true;
  showMessage('This preset changed since you loaded it. Review its current settings, then try again.', 'error');
  return false;
}

const SAVE_CAUTION = 'Maneline keeps a backup first, and you can undo the save afterwards. '
  + 'Saving is still experimental and has only been tested on a spare slot.';

// Preset switching ---------------------------------------------------------
async function selectPreset(number, { discard = false } = {}) {
  closeDrawer();
  if (exclusive || !state.connected) return;
  if (number === state.preset && !discard) return;
  await editsIdle();
  const expected = guard();
  if (hasChanges() && !discard) {
    const go = await confirmAction('Discard your unsaved changes?',
      `Switching to preset ${number} loses your edits to this preset.`, 'Discard and switch');
    if (!go || !stillSameEditor(expected)) return;
  }
  switchingTo = number;
  await exclusiveOperation(API, { preset: number }, `Switching to preset ${number}…`, () => {
    formPreset = null; // Discarding has to reset an edited name too.
    return '';
  });
}

function stepPreset(direction) {
  if (!known?.presets.length) return;
  const candidates = known.presets.filter(preset => showEmpty || !isEmptySlot(preset) || preset.preset === known.preset);
  const index = candidates.findIndex(preset => preset.preset === known.preset);
  selectPreset(candidates[(index + direction + candidates.length) % candidates.length].preset);
}

// Saving -------------------------------------------------------------------
async function saveHere() {
  const name = nameInput.value.trim();
  if (!name) { nameInput.focus(); return; }
  await editsIdle();
  const expected = guard();
  const target = state.preset;
  const factory = known.document?.info.is_factory_default ? 'This is a factory preset. ' : '';
  const go = await confirmAction(`Replace preset ${target}, “${known.name}”?`,
    `“${name}” will replace what's saved there. ${factory}${SAVE_CAUTION}`, `Replace preset ${target}`);
  if (!go || !stillSameEditor(expected)) return;
  await exclusiveOperation(EDITOR_API, { action: 'save', ...guard(), target, name },
    `Backing up and saving preset ${target}…`, () => {
      formPreset = null;
      return `Saved to preset ${target}.`;
    });
}

function renderCopyChoice() {
  const preset = presetByNumber(Number($('copy-target').value));
  if (!preset) return;
  const occupied = !isEmptySlot(preset);
  setText($('copy-warning'), occupied ? `This replaces “${preset.name}”. ${SAVE_CAUTION}` : '');
  setText($('copy-action'), occupied ? `Replace preset ${preset.preset}` : `Save to preset ${preset.preset}`);
}

async function saveCopy() {
  await editsIdle();
  const expected = guard();
  const select = $('copy-target');
  select.replaceChildren(...known.presets.map(preset => {
    const option = document.createElement('option');
    option.value = preset.preset;
    option.textContent = `${preset.preset} · ${displayName(preset)}`;
    return option;
  }));
  const firstEmpty = known.presets.find(isEmptySlot);
  select.value = String((firstEmpty ?? known.presets.find(preset => preset.preset !== known.preset)).preset);
  $('copy-name').value = nameInput.value.trim() || documentName();
  renderCopyChoice();
  const dialog = $('copy-dialog');
  dialog.returnValue = 'cancel';
  const go = await new Promise(resolve => {
    dialog.addEventListener('close', () => resolve(dialog.returnValue === 'confirm'), { once: true });
    dialog.showModal();
  });
  if (!go || !stillSameEditor(expected)) return;
  const target = Number(select.value);
  const name = $('copy-name').value.trim();
  await exclusiveOperation(EDITOR_API, { action: 'save', ...guard(), target, name },
    `Saving a copy to preset ${target}…`, () => (target === state.preset
      ? `Saved to preset ${target}.` : `Saved a copy to preset ${target}. You're still editing preset ${state.preset}.`));
}

async function undoSave() {
  const save = state.last_save;
  if (!save) return;
  await editsIdle();
  const expected = guard();
  const current = save.preset === state.preset ? ' Any unsaved edits to it will be lost.' : '';
  const go = await confirmAction(`Undo the save to preset ${save.preset}?`,
    `This puts back what preset ${save.preset} held before you saved “${save.name}”.${current}`, 'Undo the save');
  if (!go || !stillSameEditor(expected)) return;
  await exclusiveOperation(EDITOR_API, { action: 'undo-save', ...guard() }, `Putting preset ${save.preset} back…`, () => {
    formPreset = null;
    return `Preset ${save.preset} is back to what it held before that save.`;
  });
}

// Preset list --------------------------------------------------------------
function buildPresetList() {
  grid.replaceChildren();
  for (const preset of known.presets) {
    if ((preset.preset - 1) % 10 === 0) {
      const bank = document.createElement('li');
      bank.className = 'bank';
      bank.textContent = `${preset.preset}–${Math.min(preset.preset + 9, known.presets.length)}`;
      grid.append(bank);
    }
    const item = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = isEmptySlot(preset) ? 'preset empty-slot' : 'preset';
    button.dataset.preset = preset.preset;
    const number = document.createElement('span');
    number.className = 'num';
    number.textContent = preset.preset;
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = displayName(preset);
    const badge = document.createElement('span');
    badge.className = 'badge';
    button.append(number, name, badge);
    item.append(button);
    grid.append(item);
  }
}

function matchesSearch(preset, query) {
  if (!query) return true;
  if (/^\d+$/.test(query)) return preset.preset === Number(query); // Numbers mean slots, not "contains 7".
  return displayName(preset).toLocaleLowerCase().includes(query);
}

function visiblePresetButtons() {
  return [...grid.querySelectorAll('.preset')].filter(button => !button.parentElement.hidden);
}

function renderPresets() {
  if (!known) return;
  const names = JSON.stringify(known.presets);
  if (names !== renderedNames) {
    const hadFocus = grid.contains(document.activeElement) ? document.activeElement.dataset.preset : null;
    buildPresetList();
    renderedNames = names;
    if (hadFocus) grid.querySelector(`[data-preset="${hadFocus}"]`)?.focus();
  }
  const query = filter.value.toLocaleLowerCase().trim();
  const emptyCount = known.presets.filter(isEmptySlot).length;
  let visible = 0;
  let bank = null;
  let bankHasItems = false;
  for (const item of grid.children) {
    if (item.classList.contains('bank')) {
      if (bank) bank.hidden = !bankHasItems;
      bank = item;
      bankHasItems = false;
      continue;
    }
    const button = item.firstElementChild;
    const number = Number(button.dataset.preset);
    const preset = presetByNumber(number);
    const active = number === known.preset;
    const wanted = query ? matchesSearch(preset, query) : showEmpty || !isEmptySlot(preset) || active;
    item.hidden = !wanted;
    if (wanted) { visible++; bankHasItems = true; }
    if (active) button.setAttribute('aria-current', 'true'); else button.removeAttribute('aria-current');
    setText(button.querySelector('.badge'), number === switchingTo ? 'Switching…' : active ? 'Active' : '');
  }
  if (bank) bank.hidden = !bankHasItems;
  grid.classList.toggle('unavailable', !state.connected);
  grid.setAttribute('aria-busy', String(exclusive));
  const focusable = visiblePresetButtons();
  const rover = focusable.find(button => button.getAttribute('aria-current') === 'true') ?? focusable[0];
  for (const button of grid.querySelectorAll('.preset')) button.tabIndex = button === rover ? 0 : -1;
  setText($('count'), query ? `${visible} of ${known.presets.length}` : `${known.presets.length - emptyCount} presets`);
  setText($('show-empty-label'), `Show ${emptyCount} empty`);
  $('show-empty').checked = showEmpty;
  $('empty').hidden = visible > 0;
}

function scrollToActive() {
  grid.querySelector('[aria-current="true"]')?.scrollIntoView({ block: 'nearest' });
}

// Editor: building controls --------------------------------------------------
function currentNodes() { return known?.document?.audioGraph.nodes ?? []; }
function nodeById(id) { return currentNodes().find(node => node.nodeId === id); }
function nodeTitle(node) { return nodeLabels[node.nodeId] || parameterLabel(node.nodeId); }
function modelName(node) {
  return (known.models[node.nodeId] || []).find(model => model.id === node.FenderId)?.name || 'Current model';
}
function specFor(node, parameter, value) {
  return controlSpec(parameter, value, (known.unscaled?.[node.FenderId] || []).includes(parameter),
    known.parameter_choices?.[parameter], node.FenderId);
}

// Controls are only rebuilt when their shape changes, so focus and drags survive edits.
function shapeKey() {
  return JSON.stringify([selectedNode, currentNodes().map(node => [node.nodeId, node.FenderId,
    Object.entries(node.dspUnitParameters).map(([key, value]) => [key, specFor(node, key, value).kind])])]);
}

const nodeColours = { stomp: '#fe6a38', mod: '#2bc4a0', amp: '#5d5a54', delay: '#5a9bea', reverb: '#a184ea' };
const addLabels = { stomp: 'Add a stompbox', mod: 'Add modulation', delay: 'Add a delay', reverb: 'Add a reverb' };

function isEmptyNode(node) { return node.FenderId === 'DUBS_Unknown'; }
function hasBypass(node) { return 'bypass' in node.dspUnitParameters && !isEmptyNode(node); }
function specOfNode(node) { return key => specFor(node, key, node.dspUnitParameters[key]); }

function bindBypass(input, node) {
  input.addEventListener('change', () => {
    for (const twin of controlsFor(`${node.nodeId}/bypass`)) writeControl(twin, !input.checked);
    queueEdit(node.nodeId, 'bypass', !input.checked);
  });
}

function controlsFor(key) {
  return editorFields.querySelectorAll(`[data-key="${CSS.escape(key)}"]:not(.field)`);
}

// The board: one small pedal per position, joined by a cable.
function buildBoard() {
  const board = $('board');
  board.replaceChildren();
  for (const node of currentNodes()) {
    const slot = document.createElement('div');
    slot.className = 'slot';
    slot.dataset.node = node.nodeId;
    if (isEmptyNode(node)) {
      const add = document.createElement('button');
      add.type = 'button';
      add.className = 'empty-position';
      add.textContent = addLabels[node.nodeId] || `Add ${nodeTitle(node).toLowerCase()}`;
      add.addEventListener('click', () => openCloseup(node.nodeId));
      slot.append(add);
      board.append(slot);
      continue;
    }
    const pedal = document.createElement('div');
    pedal.className = node.nodeId === 'amp' ? 'pedal light-ink board-pedal' : 'pedal board-pedal';
    pedal.style.setProperty('--tint', nodeColours[node.nodeId]);
    const face = document.createElement('div');
    face.className = 'face';
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'open-pedal';
    open.setAttribute('aria-label', `Open ${modelName(node)}, ${nodeTitle(node)}`);
    const dials = document.createElement('span');
    dials.className = 'mini-dials';
    const { knobs } = splitParameters(node, specOfNode(node));
    for (const parameter of knobs.slice(0, node.nodeId === 'amp' ? 5 : 3)) {
      const dial = document.createElement('span');
      dial.className = 'mini-dial';
      dial.dataset.mini = `${node.nodeId}/${parameter}`;
      dial.innerHTML = partImage('knob', 'body') + partImage('pointer', 'pointer');
      dials.append(dial);
    }
    const light = document.createElement('span');
    light.className = 'light';
    light.innerHTML = partImage('light-off', 'unlit') + partImage('light-on', 'lit');
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = modelName(node);
    const kind = document.createElement('span');
    kind.className = 'kind';
    kind.textContent = nodeTitle(node);
    open.append(dials, light, name, kind);
    open.addEventListener('click', () => openCloseup(node.nodeId));
    face.append(open);
    if (hasBypass(node)) {
      const foot = buildFootswitch(modelName(node), !node.dspUnitParameters.bypass, `${node.nodeId}/bypass`);
      bindBypass(foot.querySelector('input'), node);
      face.append(foot);
    }
    pedal.append(face);
    slot.append(pedal);
    board.append(slot);
  }
}

function buildKnobSpec(node, parameter) {
  const value = node.dspUnitParameters[parameter];
  const spec = specFor(node, parameter, value);
  const shown = value * spec.scale;
  return { label: knobLabel(parameter), value: shown, min: Math.min(spec.min, shown), max: Math.max(spec.max, shown),
    step: spec.step, format: text => formatKnob(spec, text), key: `${node.nodeId}/${parameter}` };
}

function bindKnobs(root, node) {
  for (const input of root.querySelectorAll('.knob input')) {
    const parameter = input.dataset.key.split('/')[1];
    const spec = specFor(node, parameter, node.dspUnitParameters[parameter]);
    input.addEventListener('input', () => queueEdit(node.nodeId, parameter, Number(input.value) / spec.scale));
    input.closest('.knob').querySelector('.dial').addEventListener('pointerdown', () => { dragging = input; });
  }
}

function buildField(node, parameter, value) {
  const spec = specFor(node, parameter, value);
  const key = `${node.nodeId}/${parameter}`;
  const id = `control-${node.nodeId}-${parameter}`;
  const field = document.createElement('div');
  field.className = 'field';
  field.dataset.key = key;
  const head = document.createElement('div');
  head.className = 'field-head';
  const label = document.createElement('label');
  label.htmlFor = id;
  label.textContent = spec.label || parameterLabel(parameter);
  head.append(label);
  let control;
  if (spec.kind === 'toggle') {
    field.classList.add('toggle-field');
    control = document.createElement('input');
    control.type = 'checkbox';
    control.addEventListener('change', () => queueEdit(node.nodeId, parameter, control.checked));
    label.prepend(control);
  } else if (spec.kind === 'select') {
    control = document.createElement('select');
    for (const choice of new Set([value, ...known.parameter_choices[parameter]])) {
      const option = document.createElement('option');
      option.value = choice;
      option.textContent = choiceLabels[choice] || parameterLabel(choice);
      control.append(option);
    }
    control.addEventListener('change', () => queueEdit(node.nodeId, parameter, control.value));
  } else {
    control = document.createElement('input');
    if (spec.kind === 'knob') {
      control.type = 'range';
      control.min = String(Math.min(spec.min, value * spec.scale));
      control.max = String(Math.max(spec.max, value * spec.scale));
      control.step = String(spec.step);
      const output = document.createElement('output');
      output.htmlFor = id;
      head.append(output);
      control.addEventListener('pointerdown', () => { dragging = control; });
      control.addEventListener('input', () => {
        output.textContent = formatKnob(spec, control.value);
        queueEdit(node.nodeId, parameter, Number(control.value) / spec.scale);
      });
    } else if (spec.kind === 'number') {
      control.type = 'number';
      control.step = String(spec.step);
      control.inputMode = spec.step === 1 ? 'numeric' : 'decimal';
      if (spec.min !== undefined) control.min = String(spec.min);
      control.addEventListener('change', () => {
        const number = Number(control.value);
        if (control.value === '' || !Number.isFinite(number)) { syncControl(control); return; }
        queueEdit(node.nodeId, parameter, number);
      });
    } else {
      control.type = 'text';
      control.addEventListener('change', () => queueEdit(node.nodeId, parameter, control.value));
    }
  }
  control.id = id;
  control.dataset.key = key;
  head.append(resetButton(node, parameter));
  if (spec.kind === 'toggle') field.append(head);
  else field.append(head, control);
  return field;
}

function resetButton(node, parameter) {
  const reset = document.createElement('button');
  reset.type = 'button';
  reset.className = 'reset';
  reset.hidden = true;
  reset.textContent = 'Reset';
  reset.setAttribute('aria-label', `Reset ${parameterLabel(parameter)} to its saved value`);
  reset.addEventListener('click', () => {
    const saved = baselineValue(node.nodeId, parameter);
    if (saved === undefined) return;
    resetToSaved(node.nodeId, parameter, saved);
    controlsFor(`${node.nodeId}/${parameter}`)[0]?.focus({ preventScroll: true });
  });
  return reset;
}

function resetToSaved(nodeId, parameter, saved) {
  queueEdit(nodeId, parameter, saved);
  for (const control of controlsFor(`${nodeId}/${parameter}`)) writeControl(control, saved);
}

function buildModelPicker(node) {
  const label = document.createElement('label');
  label.className = 'model-picker';
  const name = document.createElement('span');
  name.textContent = node.nodeId === 'amp' ? 'Amp model' : 'Effect';
  const select = document.createElement('select');
  select.dataset.key = `${node.nodeId}/#model`;
  const choices = known.models[node.nodeId] || [];
  const options = choices.some(model => model.id === node.FenderId) ? choices
    : [{ id: node.FenderId, name: modelName(node) }, ...choices];
  for (const model of options) {
    const option = document.createElement('option');
    option.value = model.id;
    option.textContent = model.name;
    select.append(option);
  }
  select.value = node.FenderId;
  select.addEventListener('change', () => {
    exclusiveOperation(EDITOR_API, { action: 'model', ...guard(), node: node.nodeId, model: select.value }, 'Changing model…');
  });
  label.append(name, select);
  return label;
}

// The close-up: the chosen pedal at full size, with anything less common tucked away below it.
function buildCloseup() {
  const body = $('closeup-body');
  body.replaceChildren();
  const node = nodeById(selectedNode);
  if (!node) return;
  setText($('closeup-title'), isEmptyNode(node) ? (addLabels[node.nodeId] || nodeTitle(node)) : modelName(node));
  setText($('closeup-kind'), isEmptyNode(node) ? 'Nothing is in this position yet. Choose an effect to add one.' : nodeTitle(node));
  if (!isEmptyNode(node)) {
    const { knobs, main, extras } = splitParameters(node, specOfNode(node));
    const pedal = buildPedal({ name: modelName(node), colour: nodeColours[node.nodeId], lightInk: node.nodeId === 'amp',
      knobs: knobs.map(parameter => buildKnobSpec(node, parameter)), footswitch: hasBypass(node),
      on: !node.dspUnitParameters.bypass, bypassKey: `${node.nodeId}/bypass` });
    bindKnobs(pedal, node);
    const foot = pedal.querySelector('.foot input');
    if (foot) bindBypass(foot, node);
    const stage = document.createElement('div');
    stage.className = 'closeup-stage';
    stage.append(pedal);
    body.append(stage);
    if (main.length) {
      const fields = document.createElement('div');
      fields.className = 'fields';
      for (const parameter of main) fields.append(buildField(node, parameter, node.dspUnitParameters[parameter]));
      body.append(fields);
    }
    if (knobs.length) {
      const tip = document.createElement('p');
      tip.className = 'knob-tip';
      tip.textContent = 'Drag a knob up or down, or select it and use the arrow keys.';
      body.append(tip);
    }
    const undo = document.createElement('button');
    undo.type = 'button';
    undo.id = 'closeup-undo';
    undo.hidden = true;
    undo.textContent = node.nodeId === 'amp' ? 'Undo my changes to the amp' : 'Undo my changes to this pedal';
    undo.addEventListener('click', () => {
      for (const change of changesFromSaved()) {
        if (change.nodeId === node.nodeId && change.parameter) resetToSaved(node.nodeId, change.parameter, change.saved);
      }
    });
    body.append(undo);
    body.append(buildModelPicker(node));
    if (extras.length) {
      const details = document.createElement('details');
      details.id = 'advanced';
      details.open = advancedOpen;
      details.addEventListener('toggle', () => { advancedOpen = details.open; });
      const summary = document.createElement('summary');
      summary.textContent = `More settings (${extras.length})`;
      const more = document.createElement('div');
      more.className = 'fields';
      for (const parameter of extras) more.append(buildField(node, parameter, node.dspUnitParameters[parameter]));
      details.append(summary, more);
      body.append(details);
    }
  } else {
    body.append(buildModelPicker(node));
  }
}

function openCloseup(nodeId) {
  selectedNode = nodeId;
  builtKey = '';
  renderEditor();
  renderStatus();
  const dialog = $('closeup');
  if (!dialog.open) dialog.showModal();
}

// Editor: keeping controls in step with the amp ------------------------------
function writeControl(control, value) {
  if (control.type === 'checkbox') {
    const isBypass = control.dataset.key.endsWith('/bypass');
    control.checked = isBypass ? !value : Boolean(value);
    if (isBypass) {
      const pedal = control.closest('.pedal');
      if (pedal) setPedalOn(pedal, control.checked);
    }
  } else if (control.type === 'range') {
    const [nodeId, parameter] = control.dataset.key.split('/');
    const spec = specFor(nodeById(nodeId), parameter, value);
    const shown = value * spec.scale;
    // An amp value past the usual travel widens the knob instead of being misreported.
    if (shown < Number(control.min)) control.min = String(shown);
    if (shown > Number(control.max)) control.max = String(shown);
    control.value = String(shown);
    control.repaintKnob?.();
    const output = control.closest('.field')?.querySelector('output');
    if (output) setText(output, formatKnob(spec, control.value));
  } else if (control.type === 'number') {
    if (Number(control.value) !== Number(value.toPrecision(6)) || control.value === '') control.value = String(Number(value.toPrecision(6)));
  } else if (control.value !== value) {
    control.value = value;
  }
}

function syncControl(control) {
  const key = control.dataset.key;
  if (!key || key === inFlightKey || pendingEdits.has(key) || control === dragging) return;
  const typing = document.activeElement === control && (control.type === 'number' || control.type === 'text');
  if (typing) return;
  const [nodeId, parameter] = key.split('/');
  const node = nodeById(nodeId);
  if (!node) return;
  if (parameter === '#model') { control.value = node.FenderId; return; }
  if (parameter in node.dspUnitParameters) writeControl(control, node.dspUnitParameters[parameter]);
}

function baseline() { return known ? baselines.get(baselineKey(known)) : null; }
function baselineValue(nodeId, parameter) {
  const node = baseline()?.audioGraph.nodes.find(entry => entry.nodeId === nodeId);
  const current = nodeById(nodeId);
  return node && current && node.FenderId === current.FenderId ? node.dspUnitParameters[parameter] : undefined;
}
function sameValue(a, b) {
  return typeof a === 'number' && typeof b === 'number' ? Math.abs(a - b) < 1e-4 : a === b;
}

function changesFromSaved() {
  const saved = baseline();
  if (!saved) return [];
  const changes = [];
  for (const node of currentNodes()) {
    const before = saved.audioGraph.nodes.find(entry => entry.nodeId === node.nodeId);
    if (!before) continue;
    if (before.FenderId !== node.FenderId) {
      const name = id => (known.models[node.nodeId] || []).find(model => model.id === id)?.name || 'Other';
      changes.push({ nodeId: node.nodeId, text: `${nodeTitle(node)} model: ${name(before.FenderId)} → ${name(node.FenderId)}` });
      continue;
    }
    for (const [parameter, value] of Object.entries(node.dspUnitParameters)) {
      if (parameter === 'bypassType' || !(parameter in before.dspUnitParameters)
        || sameValue(before.dspUnitParameters[parameter], value)) continue;
      changes.push({ nodeId: node.nodeId, parameter, saved: before.dspUnitParameters[parameter],
        text: `${nodeTitle(node)} · ${parameterLabel(parameter)}: ${describeValue(node, parameter, before.dspUnitParameters[parameter])} → ${describeValue(node, parameter, value)}` });
    }
  }
  return changes;
}

function describeValue(node, parameter, value) {
  if (parameter === 'bypass') return value ? 'Off' : 'On';
  if (typeof value === 'boolean') return value ? 'On' : 'Off';
  if (typeof value === 'string') return choiceLabels[value] || parameterLabel(value);
  const spec = specFor(node, parameter, value);
  if (spec.kind === 'knob') return formatKnob(spec, value * spec.scale);
  return Number(value.toPrecision(4)).toLocaleString();
}

function renderChanges(changes) {
  const named = nameChanged();
  const count = changes.length + (named ? 1 : 0);
  $('changes').hidden = count === 0;
  setText($('changes-summary'), count === 1 ? 'See 1 change from the saved preset' : `See ${count} changes from the saved preset`);
  const list = $('changes-list');
  const signature = JSON.stringify([named && nameInput.value.trim(), changes.map(change => change.text)]);
  if (signature === renderedChanges) return; // Rebuilding every poll would steal focus from Reset.
  renderedChanges = signature;
  list.replaceChildren();
  if (named) {
    const item = document.createElement('li');
    item.textContent = `Name: ${documentName()} → ${nameInput.value.trim()}`;
    list.append(item);
  }
  for (const change of changes) {
    const item = document.createElement('li');
    const text = document.createElement('span');
    text.textContent = change.text;
    item.append(text);
    if (change.parameter) {
      const reset = document.createElement('button');
      reset.type = 'button';
      reset.className = 'reset';
      reset.textContent = 'Reset';
      reset.setAttribute('aria-label', `Reset ${change.text}`);
      reset.addEventListener('click', () => {
        queueEdit(change.nodeId, change.parameter, change.saved);
        for (const control of controlsFor(`${change.nodeId}/${change.parameter}`)) writeControl(control, change.saved);
      });
      item.append(reset);
    }
    list.append(item);
  }
}

function renderEditor() {
  const available = Boolean(known?.document);
  $('waiting').hidden = available;
  editorFields.hidden = !available;
  if (!available) return;
  if (selectedNode && !nodeById(selectedNode)) closeCloseup();
  if (formPreset !== known.preset) {
    nameInput.value = documentName();
    formPreset = known.preset;
  }
  const shape = shapeKey();
  if (shape !== builtKey) {
    const focusKey = editorFields.contains(document.activeElement) ? document.activeElement.dataset?.key : null;
    buildBoard();
    buildCloseup();
    builtKey = shape;
    if (focusKey) restoreFocus(focusKey);
  }
  for (const control of editorFields.querySelectorAll('[data-key]:not(.field)')) syncControl(control);
  const changes = changesFromSaved();
  const changedKeys = new Set(changes.filter(change => change.parameter).map(change => `${change.nodeId}/${change.parameter}`));
  for (const field of editorFields.querySelectorAll('.field')) {
    const changed = changedKeys.has(field.dataset.key);
    field.classList.toggle('is-changed', changed);
    field.querySelector('.reset').hidden = !changed;
  }
  for (const knob of editorFields.querySelectorAll('.knob')) {
    knob.classList.toggle('is-changed', changedKeys.has(knob.querySelector('input').dataset.key));
  }
  for (const dial of $('board').querySelectorAll('.mini-dial')) {
    const [nodeId, parameter] = dial.dataset.mini.split('/');
    const node = nodeById(nodeId);
    const value = node?.dspUnitParameters[parameter];
    if (typeof value !== 'number') continue;
    const spec = specFor(node, parameter, value);
    const shown = value * spec.scale;
    dial.querySelector('.pointer').style.transform = `rotate(${knobAngle(shown, Math.min(spec.min, shown), Math.max(spec.max, shown))}deg)`;
  }
  for (const slot of $('board').children) {
    const edited = changes.some(change => change.nodeId === slot.dataset.node);
    slot.classList.toggle('has-changes', edited);
  }
  const undo = $('closeup-undo');
  if (undo) undo.hidden = !changes.some(change => change.nodeId === selectedNode && change.parameter);
  renderChanges(changes);
  setText($('name-count'), `${nameInput.value.length}/16`);
  editorFields.disabled = !state.connected || exclusive;
}

// Status, top bar and banners ------------------------------------------------
function renderStatus() {
  const count = changesFromSaved().length + (nameChanged() ? 1 : 0);
  const unsaved = state.connected && hasChanges();
  setText($('dirty'), !unsaved ? '' : count > 1 ? `${count} unsaved changes` : count === 1 ? '1 unsaved change' : 'Unsaved changes');
  setText($('sync'), editsWaiting() ? 'Sending to the amp…' : '');
  const problem = $('message').dataset.kind === 'error' && !$('message').hidden ? $('message').textContent : '';
  const closeupStatus = $('closeup-status');
  setText(closeupStatus, !state.connected ? "The amp isn't connected, so these controls are paused until it's back."
    : problem || (editsWaiting() ? 'Sending to the amp…' : exclusive ? 'Changing…' : ''));
  closeupStatus.dataset.kind = !state.connected || problem ? 'error' : '';
  const usable = state.connected && !exclusive;
  $('save').disabled = !usable || !hasChanges() || !nameInput.value.trim();
  $('save-copy').disabled = !usable;
  $('discard').disabled = !usable || !hasChanges();
  $('prev').disabled = $('next').disabled = !usable;
}

function renderConnection() {
  const connection = $('connection');
  let label;
  let banner = '';
  if (state.connected) {
    connection.dataset.state = 'connected';
    label = 'Connected';
    if (reconnectNotice) banner = 'Reconnected. Check how the preset sounds before saving, because your unsaved changes may not have survived.';
  } else if (!reachable) {
    connection.dataset.state = 'lost';
    label = 'Not connected';
    banner = "Can't reach the Maneline app on this computer. Make sure it's still running; this page will reconnect by itself.";
  } else if (known) {
    connection.dataset.state = 'lost';
    label = 'Reconnecting…';
    // Don't repeat what the message under the top bar already says.
    const reason = state.error && state.error !== $('message').textContent ? `${state.error} ` : '';
    const edits = known.dirty || nameChanged() ? ' Your unsaved changes may not survive this.' : '';
    banner = `Lost the connection to your Micro Plus. ${reason}This page shows the last settings it read and will reconnect by itself.${edits}`;
  } else {
    connection.dataset.state = 'connecting';
    label = 'Connecting…';
    if (state.error) banner = state.error;
  }
  setText($('connection-text'), label);
  const element = $('connection-banner');
  element.hidden = !banner;
  setText(element, banner);
  if (known?.preset) {
    setText($('current-number'), state.connected ? `Preset ${known.preset}` : `Preset ${known.preset} (last known)`);
    setText($('current-name'), known.name || 'Unnamed preset');
    document.title = `${known.preset} · ${known.name || 'Unnamed preset'} · Maneline`;
  }
}

function renderLastSave() {
  const save = state.connected ? state.last_save : null;
  $('last-save').hidden = !save;
  $('undo-save').disabled = exclusive || editsWaiting();
  if (save) {
    const time = new Date(save.time * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    setText($('last-save-text'), `Saved “${save.name}” to preset ${save.preset} at ${time}. Previous version backed up as ${save.backup}.`);
  }
}

function render() {
  const previousActive = grid.querySelector('[aria-current="true"]')?.dataset.preset;
  renderConnection();
  renderPresets();
  renderEditor();
  renderStatus();
  renderLastSave();
  if (grid.querySelector('[aria-current="true"]')?.dataset.preset !== previousActive) scrollToActive();
}

// Close-up -----------------------------------------------------------------------
function closeCloseup() {
  if ($('closeup').open) $('closeup').close();
  else selectedNode = null;
}

// Narrow-screen preset drawer ------------------------------------------------
function openDrawer() {
  document.body.classList.add('drawer-open');
  $('scrim').hidden = false;
  scrollToActive();
  // Focusing the list instead of the search box keeps the phone keyboard closed.
  (grid.querySelector('.preset[tabindex="0"]') ?? filter).focus({ preventScroll: true });
}
function closeDrawer() {
  if (!document.body.classList.contains('drawer-open')) return;
  document.body.classList.remove('drawer-open');
  $('scrim').hidden = true;
  $('open-presets').focus();
}

// Events -----------------------------------------------------------------------
window.addEventListener('pointerup', () => { dragging = null; });
window.addEventListener('pointercancel', () => { dragging = null; });
document.addEventListener('visibilitychange', () => { if (!document.hidden) readState(); });

$('closeup-close').addEventListener('click', closeCloseup);
$('closeup').addEventListener('close', () => {
  const opened = selectedNode;
  selectedNode = null;
  builtKey = '';
  renderEditor();
  $('board').querySelector(`[data-node="${opened}"] button`)?.focus({ preventScroll: true });
});
// Selecting the dimmed area around the close-up closes it; the backdrop's clicks land on the dialog itself.
$('closeup').addEventListener('click', event => { if (event.target === $('closeup')) closeCloseup(); });
$('open-presets').addEventListener('click', openDrawer);
$('close-presets').addEventListener('click', closeDrawer);
$('scrim').addEventListener('click', closeDrawer);
$('prev').addEventListener('click', () => stepPreset(-1));
$('next').addEventListener('click', () => stepPreset(1));
$('save').addEventListener('click', saveHere);
$('save-copy').addEventListener('click', saveCopy);
$('undo-save').addEventListener('click', undoSave);
$('copy-target').addEventListener('change', renderCopyChoice);
$('show-empty').addEventListener('change', event => {
  showEmpty = event.target.checked;
  storeFlag('mmp-show-empty', showEmpty);
  renderPresets();
});
$('discard').addEventListener('click', async () => {
  await editsIdle();
  const expected = guard();
  if (await confirmAction('Discard your unsaved changes?',
    'This reloads the saved preset from the amp. Your edits and any name change will be lost.', 'Discard changes')
    && stillSameEditor(expected)) {
    reconnectNotice = false;
    await selectPreset(expected.preset, { discard: true });
  }
});
nameInput.addEventListener('input', () => { renderEditor(); renderStatus(); });
nameInput.addEventListener('keydown', event => {
  if (event.key === 'Enter' && !$('save').disabled) { event.preventDefault(); saveHere(); }
});

filter.addEventListener('input', renderPresets);
filter.addEventListener('keydown', event => {
  const first = visiblePresetButtons()[0];
  if (event.key === 'Enter' && first) {
    event.preventDefault();
    selectPreset(Number(first.dataset.preset));
  } else if (event.key === 'ArrowDown' && first) {
    event.preventDefault();
    first.focus();
  }
});
grid.addEventListener('click', event => {
  const button = event.target.closest('.preset');
  if (button) selectPreset(Number(button.dataset.preset));
});
grid.addEventListener('keydown', event => {
  const button = event.target.closest('.preset');
  if (!button) return;
  const buttons = visiblePresetButtons();
  const index = buttons.indexOf(button);
  const targets = { ArrowDown: index + 1, ArrowUp: index - 1, Home: 0, End: buttons.length - 1 };
  if (event.key in targets) {
    event.preventDefault();
    const target = buttons[targets[event.key]];
    if (target) { target.focus(); target.scrollIntoView({ block: 'nearest' }); }
    else if (event.key === 'ArrowUp') filter.focus();
  }
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') { closeDrawer(); return; }
  if (document.querySelector('dialog[open]') || event.metaKey || event.ctrlKey || event.altKey) return;
  if (event.target.closest('input, select, textarea')) return;
  if (event.key === '[') stepPreset(-1);
  if (event.key === ']') stepPreset(1);
});

readState();
setInterval(readState, 1000);

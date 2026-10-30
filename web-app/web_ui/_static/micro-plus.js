'use strict';
let state = { connected: false, presets: [], models: {} };
let busy = false;
let requestRunning = false;
let selectionRevision = 0;
let renderedNames = '';
let editorKey = '';
let formKey = '';
const grid = document.getElementById('presets');
const filter = document.getElementById('filter');
const message = document.getElementById('message');
const editorMessage = document.getElementById('editor-message');
const modules = document.getElementById('modules');
const nameInput = document.getElementById('preset-name');
const targetInput = document.getElementById('save-target');
const saveButton = document.getElementById('save');
const discardButton = document.getElementById('discard');
const ratioParameters = new Set(['gain', 'bass', 'mid', 'treb', 'treble', 'mix', 'depth', 'feedback', 'presence', 'resonance', 'drive', 'tone']);
const labels = { volume: 'Volume (dB)', treb: 'Treble', gatePreset: 'Noise gate', cabsimType: 'Cabinet',
  gateDetectorPosition: 'Noise gate input', bypass: 'Enabled', time: 'Delay time', predelay: 'Pre-delay', damping: 'Damping', feedback: 'Feedback' };
Object.assign(labels, {
  comppreset: 'Compression setting', ratehz: 'Rate (Hz)', lrphase: 'Stereo phase',
  fdbklvl: 'Feedback level', feedbacklvl: 'Feedback level', wetlvl: 'Effect level',
  dlytime: 'Delay time (s)', delaytime: 'Delay time (s)', avgdelay: 'Average delay (s)',
  fblowcut: 'Feedback low cut', fbhighcut: 'Feedback high cut',
  modratehz: 'Modulation rate (Hz)', moddepth: 'Modulation depth', modshape: 'Modulation shape',
  dlymodtype: 'Delay modulation type', panratehz: 'Pan rate (Hz)', pandepth: 'Pan depth',
  panmodtype: 'Pan modulation type', lowcut: 'Low cut', highmid: 'High mids', lowmid: 'Low mids',
  lowtone: 'Bass tone', midtone: 'Middle tone', hightone: 'Treble tone',
  brightsw: 'Bright switch', mastervolume: 'Master volume', outputlevel: 'Output level (dB)',
  gain2: 'Second gain stage', dampingcoef: 'Damping', diffuse: 'Diffusion',
  inputfiltermode: 'Input filter mode', prefilttype: 'Pre-filter type', lfoclip: 'LFO clipping',
  lfoshape: 'LFO shape', dutycycle: 'Pulse width', stereospread: 'Stereo spread',
  octdown: 'Octave down', octup: 'Octave up', wowlevel: 'Wow level',
  attenuate: 'Attenuation', hbe: 'High-gain boost', c45: 'C45 switch', sat: 'Saturation'
});
const choiceLabels = { mid: 'Medium', none: 'Off', off: 'Off', jack: 'Guitar input',
  '57champ': "'57 Champ cabinet", '57dlx': "'57 Deluxe cabinet", '59bman': "'59 Bassman cabinet",
  '65dlx': "'65 Deluxe cabinet", '65prince': "'65 Princeton cabinet", '65twn': "'65 Twin cabinet",
  exlsr: 'Excelsior cabinet', '1x12ss': '1×12 cabinet', '2x12c': '2×12 C cabinet',
  '4x12g': '4×12 G cabinet', '4x12g2': '4×12 G2 cabinet', '4x12m': '4×12 M cabinet',
  '4x12r': '4×12 R cabinet', '4x12sld': '4×12 SLD cabinet', '4x12v': '4×12 V cabinet',
  '4x12v2': '4×12 V2 cabinet' };
const nodeLabels = { amp: 'Amplifier', stomp: 'Stompbox', mod: 'Modulation', delay: 'Delay', reverb: 'Reverb' };

function labelFor(key) {
  return labels[key] || key.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, c => c.toUpperCase());
}
function guard() { return { preset: state.preset, revision: state.revision }; }
function hasChanges() {
  return state.dirty || (state.document && nameInput.value !== state.document.info.displayName.trim());
}
function modelName(node) {
  return (state.models[node.nodeId] || []).find(model => model.id === node.FenderId)?.name || 'Current model';
}

function renderEditor() {
  const available = state.connected && state.document;
  const key = available ? state.revision : 'unavailable';
  const newFormKey = available ? `${state.revision.split(':')[0]}:${state.preset}` : '';
  if (available && newFormKey !== formKey) {
    nameInput.value = state.document.info.displayName.trim();
    formKey = newFormKey;
    targetInput.value = String(state.preset);
  }
  if (key !== editorKey) {
    modules.replaceChildren();
    if (available) {
      const expected = guard();
      for (const node of state.document.audioGraph.nodes) {
        const section = document.createElement('section');
        section.className = 'module';
        const title = document.createElement('h3');
        title.textContent = nodeLabels[node.nodeId] || labelFor(node.nodeId);
        section.append(title);
        const choices = state.models[node.nodeId] || [];
        if (choices.length) {
          const label = document.createElement('label');
          label.textContent = 'Model';
          const select = document.createElement('select');
          select.setAttribute('aria-label', `${title.textContent} model`);
          const options = choices.some(model => model.id === node.FenderId) ? choices
            : [{ id: node.FenderId, name: modelName(node) }, ...choices];
          for (const model of options) {
            const option = document.createElement('option');
            option.value = model.id;
            option.textContent = model.name;
            select.append(option);
          }
          select.value = node.FenderId;
          select.addEventListener('change', () => change({ action: 'model', ...expected, node: node.nodeId, model: select.value }, 'Changing model…'));
          label.append(select);
          section.append(label);
        }
        if (node.FenderId !== 'DUBS_Unknown') {
          for (const [parameter, value] of Object.entries(node.dspUnitParameters)) {
            if (parameter === 'bypassType') continue;
            const label = document.createElement('label');
            label.textContent = labelFor(parameter);
            const input = document.createElement('input');
            input.setAttribute('aria-label', `${title.textContent} ${labelFor(parameter)}`);
            let readValue;
            if (typeof value === 'boolean') {
              input.type = 'checkbox';
              input.checked = parameter === 'bypass' ? !value : value;
              readValue = () => parameter === 'bypass' ? !input.checked : input.checked;
            } else if (typeof value === 'number') {
              const normalized = ratioParameters.has(parameter) && value >= 0 && value <= 1
                && !(state.unscaled?.[node.FenderId] || []).includes(parameter);
              input.type = normalized ? 'range' : 'number';
              input.step = normalized ? '0.1' : 'any';
              if (normalized) { input.min = '0'; input.max = '10'; }
              input.value = String(normalized ? value * 10 : Number(value.toPrecision(6)));
              if (normalized) {
                const output = document.createElement('output');
                output.textContent = Number(input.value).toFixed(1);
                input.addEventListener('input', () => { output.textContent = Number(input.value).toFixed(1); });
                label.append(output);
              }
              readValue = () => Number(input.value) / (normalized ? 10 : 1);
            } else {
              const choices = state.parameter_choices?.[parameter] || [];
              if (choices.length) {
                const select = document.createElement('select');
                select.setAttribute('aria-label', `${title.textContent} ${labelFor(parameter)}`);
                for (const choice of new Set([value, ...choices])) {
                  const option = document.createElement('option');
                  option.value = choice;
                  option.textContent = choiceLabels[choice] || labelFor(choice);
                  select.append(option);
                }
                select.value = value;
                select.addEventListener('change', () => change({ action: 'parameter', ...expected, node: node.nodeId, parameter, value: select.value }, 'Applying change…'));
                label.append(select);
                section.append(label);
                continue;
              }
              input.type = 'text';
              input.value = value;
              readValue = () => input.value;
            }
            input.addEventListener('change', () => change({ action: 'parameter', ...expected, node: node.nodeId, parameter, value: readValue() }, 'Applying change…'));
            label.append(input);
            section.append(label);
          }
        }
        modules.append(section);
      }
    }
    editorKey = key;
  }
  document.getElementById('dirty').textContent = available && hasChanges() ? 'Unsaved changes' : '';
  modules.setAttribute('aria-busy', String(busy || !available));
  for (const input of modules.querySelectorAll('input, select')) input.disabled = busy || !available;
  nameInput.disabled = targetInput.disabled = busy || !available;
  saveButton.disabled = busy || !available;
  discardButton.disabled = busy || !available || !hasChanges();
}

function render() {
  document.getElementById('connection').textContent = state.connected ? 'Connected over Bluetooth'
    : state.error || 'Connecting to your Micro Plus…';
  document.getElementById('current').textContent = state.connected && state.preset
    ? `Preset ${state.preset} · ${state.name || 'Unnamed preset'}` : 'Reading the current preset…';
  const names = JSON.stringify(state.presets);
  if (names !== renderedNames) {
    const selectedTarget = targetInput.value;
    grid.replaceChildren();
    targetInput.replaceChildren();
    for (const preset of state.presets) {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.preset = preset.preset;
      const number = document.createElement('span');
      number.textContent = `Preset ${preset.preset}`;
      const name = document.createElement('strong');
      name.textContent = preset.name || 'Unnamed preset';
      button.append(number, name);
      button.addEventListener('click', () => selectPreset(preset.preset));
      grid.append(button);
      const option = document.createElement('option');
      option.value = preset.preset;
      option.textContent = `${preset.preset} · ${preset.name || 'Unnamed preset'}`;
      targetInput.append(option);
    }
    if (selectedTarget) targetInput.value = selectedTarget;
    renderedNames = names;
  }
  const query = filter.value.toLocaleLowerCase().trim();
  let visible = 0;
  for (const button of grid.children) {
    button.disabled = busy || !state.connected;
    button.setAttribute('aria-pressed', String(Number(button.dataset.preset) === state.preset));
    button.hidden = !button.textContent.toLocaleLowerCase().includes(query);
    if (!button.hidden) visible++;
  }
  grid.setAttribute('aria-busy', String(busy || !state.connected));
  document.getElementById('empty').hidden = !state.connected || visible > 0;
  renderEditor();
}

async function readState() {
  if (requestRunning || busy) return;
  requestRunning = true;
  const revision = selectionRevision;
  try {
    const response = await fetch('/api/micro-plus', { signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error('Could not read the connection. Trying again…');
    const next = await response.json();
    if (revision === selectionRevision) state = next;
  } catch (error) {
    if (revision === selectionRevision) state = { ...state, connected: false, error: 'Cannot reach Maneline. Check that it is still running.' };
  } finally { requestRunning = false; render(); }
}

async function change(body, progress, url = '/api/micro-plus/editor') {
  if (busy || !state.connected) return;
  busy = true;
  selectionRevision++;
  editorMessage.className = '';
  editorMessage.textContent = progress;
  render();
  try {
    const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(45000) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'The Micro Plus did not confirm the change.');
    state = result;
    if (body.action === 'save') {
      nameInput.value = state.document.info.displayName.trim();
      editorMessage.textContent = `Saved to preset ${body.target}. A backup of its previous contents was created.`;
    } else {
      editorMessage.textContent = body.action ? 'Change applied. Save it to keep it on the device.' : '';
      if (!body.action) document.getElementById('editor').scrollIntoView({behavior:'smooth', block:'start'});
    }
  } catch (error) {
    editorMessage.className = 'error';
    editorMessage.textContent = error.message || 'Could not confirm the change. Checking the connection…';
    // Rebuild controls from the amp's actual state after rejection/conflict.
    editorKey = '';
  } finally { busy = false; render(); readState(); }
}

function confirmAction(title, text, action) {
  const dialog = document.getElementById('confirm-dialog');
  document.getElementById('confirm-title').textContent = title;
  document.getElementById('confirm-text').textContent = text;
  document.getElementById('confirm-action').textContent = action;
  dialog.returnValue = 'cancel';
  return new Promise(resolve => {
    dialog.addEventListener('close', () => resolve(dialog.returnValue === 'confirm'), {once:true});
    dialog.showModal();
  });
}

function sameEditor(expected) {
  if (state.preset === expected.preset && state.revision === expected.revision) return true;
  editorMessage.className = 'error';
  editorMessage.textContent = 'This preset changed since you loaded it. Review its current settings, then try again.';
  return false;
}

async function selectPreset(preset, discard = false) {
  if (busy || !state.connected) return;
  const expected = guard();
  if (hasChanges() && !discard) {
    if (!await confirmAction('Discard unsaved changes?',
      'Your unsaved edits and name change will be lost when you switch presets.', 'Discard and switch')) return;
    if (!sameEditor(expected)) return;
  }
  await change({ preset }, 'Reading preset…', '/api/micro-plus');
}

filter.addEventListener('input', render);
nameInput.addEventListener('input', renderEditor);
discardButton.addEventListener('click', async () => {
  const expected = guard();
  if (await confirmAction('Discard unsaved changes?',
    'Reload the saved preset from the device. Your unsaved edits and name change will be lost.', 'Discard changes')) {
    if (sameEditor(expected)) await selectPreset(expected.preset, true);
  }
});
document.getElementById('save-form').addEventListener('submit', async event => {
  event.preventDefault();
  const target = Number(targetInput.value);
  const name = nameInput.value.trim();
  const expected = guard();
  if (!name) return;
  if (!await confirmAction(`Save to preset ${target}?`,
    `Save "${name}" to preset ${target}, replacing its saved contents. A backup will be created first.`,
    `Save to preset ${target}`)) return;
  await change({ action: 'save', ...expected, target, name }, `Backing up and saving preset ${target}…`);
});
readState();
setInterval(readState, 1000);

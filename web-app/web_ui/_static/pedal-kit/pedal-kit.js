'use strict';
// Assembles a pedal from the shared parts. A pedal only needs a name, a colour and its knobs.
const PART = name => `/web_ui/_static/pedal-kit/${name}.png`;
const partImage = (name, className) => `<img class="${className}" src="${PART(name)}" alt="" draggable="false">`;
const KNOB_PAGE_SIZE = 6;
const DRAG_DISTANCE = 150; // Pixels of dragging for a full turn.

function knobAngle(value, min, max) { return -135 + 270 * (value - min) / (max - min); }

function scaleMarks() {
  let marks = '';
  for (let step = 0; step <= 10; step++) {
    const angle = (-135 + 27 * step) * Math.PI / 180;
    const at = radius => `${(50 + Math.sin(angle) * radius).toFixed(1)} ${(50 - Math.cos(angle) * radius).toFixed(1)}`;
    marks += `<path d="M${at(44)} L${at(48.5)}"/>`;
  }
  return `<svg class="marks" viewBox="0 0 100 100" aria-hidden="true">${marks}</svg>`;
}

// The hidden native slider keeps arrow keys and screen readers working; dragging just sets its value.
function buildKnob({ label, value, min = 0, max = 10, step = 0.1, format = shown => Number(shown).toFixed(1), key }) {
  const knob = document.createElement('div');
  knob.className = 'knob';
  knob.innerHTML = `<div class="readout"></div>
    <input type="range" min="${min}" max="${max}" step="${step}" value="${value}">
    <div class="dial">${scaleMarks()}${partImage('knob', 'body')}${partImage('pointer', 'pointer')}</div>
    <div class="knob-label"></div>`;
  knob.querySelector('.knob-label').textContent = label;
  const input = knob.querySelector('input');
  const dial = knob.querySelector('.dial');
  const pointer = knob.querySelector('.pointer');
  const readout = knob.querySelector('.readout');
  input.setAttribute('aria-label', label);
  if (key) input.dataset.key = key;
  let hideTimer;
  let startX = 0;
  let startY = 0;
  let startValue = 0;
  const range = () => Number(input.max) - Number(input.min);
  const paint = () => {
    pointer.style.transform = `rotate(${knobAngle(Number(input.value), Number(input.min), Number(input.max))}deg)`;
    readout.textContent = format(input.value);
    input.setAttribute('aria-valuetext', format(input.value));
  };
  const showBriefly = () => {
    knob.classList.add('active');
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => knob.classList.remove('active'), 900);
  };
  input.repaintKnob = paint;
  input.addEventListener('input', () => {
    paint();
    if (dial.hasPointerCapture?.(knob.dragPointer)) return; // The number stays up until the drag ends.
    showBriefly();
  });
  dial.addEventListener('pointerdown', event => {
    if (input.disabled) return;
    dial.setPointerCapture(event.pointerId);
    knob.dragPointer = event.pointerId;
    startX = event.clientX;
    startY = event.clientY;
    startValue = Number(input.value);
    knob.classList.add('active');
    clearTimeout(hideTimer);
    input.focus({ preventScroll: true });
    event.preventDefault();
  });
  dial.addEventListener('pointermove', event => {
    if (!dial.hasPointerCapture(event.pointerId) || input.disabled) return;
    const moved = (startY - event.clientY) + (event.clientX - startX);
    const before = input.value;
    input.value = String(startValue + moved / DRAG_DISTANCE * range());
    if (input.value !== before) input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  dial.addEventListener('pointerup', showBriefly);
  dial.addEventListener('pointercancel', showBriefly);
  paint();
  return knob;
}

// A real checkbox, so it can carry the on/off state and be used from the keyboard.
function buildFootswitch(name, on = true, key) {
  const foot = document.createElement('label');
  foot.className = 'foot';
  foot.innerHTML = `<input type="checkbox">${partImage('foot-up', 'raised')}${partImage('foot-down', 'pressed')}`;
  const input = foot.querySelector('input');
  input.checked = on;
  input.setAttribute('aria-label', `${name} on`);
  if (key) input.dataset.key = key;
  return foot;
}

function setPedalOn(pedal, on) { pedal.classList.toggle('off', !on); }

function buildKnobArea(knobs) {
  const area = document.createElement('div');
  area.className = 'knob-area';
  const pages = [];
  for (let start = 0; start < knobs.length; start += KNOB_PAGE_SIZE) pages.push(knobs.slice(start, start + KNOB_PAGE_SIZE));
  const shown = pages.map(page => {
    const row = document.createElement('div');
    row.className = 'knobs';
    row.append(...page.map(buildKnob));
    return row;
  });
  area.append(...shown);
  if (shown.length < 2) return area;
  const dots = document.createElement('div');
  dots.className = 'knob-pages';
  const buttons = shown.map((row, index) => {
    const dot = document.createElement('button');
    dot.type = 'button';
    dot.setAttribute('aria-label', `Knobs, page ${index + 1} of ${shown.length}`);
    dot.addEventListener('click', () => show(index));
    return dot;
  });
  function show(index) {
    shown.forEach((row, rowIndex) => { row.hidden = rowIndex !== index; });
    buttons.forEach((dot, dotIndex) => dot.setAttribute('aria-current', String(dotIndex === index)));
  }
  dots.append(...buttons);
  area.append(dots);
  show(0);
  return area;
}

function buildPedal({ name, colour, knobs, footswitch = true, on = true, lightInk = false, bypassKey }) {
  const pedal = document.createElement('div');
  pedal.className = lightInk ? 'pedal light-ink' : 'pedal';
  pedal.style.setProperty('--tint', colour);
  pedal.innerHTML = `
    ${partImage('jack', 'jack left')}${partImage('jack', 'jack right')}
    <div class="face">
      ${['tl', 'tr', 'bl', 'br'].map(spot => partImage('screw', `screw ${spot}`)).join('')}
      <div class="light">${partImage('light-off', 'unlit')}${partImage('light-on', 'lit')}</div>
      <div class="name"></div>
    </div>`;
  pedal.querySelector('.name').textContent = name;
  const face = pedal.querySelector('.face');
  face.prepend(buildKnobArea(knobs));
  if (footswitch) {
    const foot = buildFootswitch(name, on, bypassKey);
    const input = foot.querySelector('input');
    input.addEventListener('change', () => setPedalOn(pedal, input.checked));
    face.append(foot);
  }
  setPedalOn(pedal, on);
  return pedal;
}

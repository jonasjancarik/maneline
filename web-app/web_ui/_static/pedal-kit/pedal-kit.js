'use strict';
// Assembles a pedal from the shared parts. A pedal only needs a name, a colour and its knobs.
const PART = name => `/web_ui/_static/pedal-kit/${name}.png`;

function scaleMarks() {
  let marks = '';
  for (let step = 0; step <= 10; step++) {
    const angle = (-135 + 27 * step) * Math.PI / 180;
    const at = radius => `${(50 + Math.sin(angle) * radius).toFixed(1)} ${(50 - Math.cos(angle) * radius).toFixed(1)}`;
    marks += `<path d="M${at(44)} L${at(48.5)}"/>`;
  }
  return `<svg class="marks" viewBox="0 0 100 100" aria-hidden="true">${marks}</svg>`;
}

function buildKnob({ label, value }) {
  const knob = document.createElement('div');
  knob.className = 'knob';
  knob.innerHTML = `<div class="readout"></div>
    <input type="range" min="0" max="10" step="0.1" value="${value}" aria-label="${label}">
    <div class="dial">${scaleMarks()}<img class="body" src="${PART('knob')}" alt="" draggable="false"><img class="pointer" src="${PART('pointer')}" alt="" draggable="false"></div>
    <div class="knob-label">${label}</div>`;
  const input = knob.querySelector('input');
  const dial = knob.querySelector('.dial');
  const pointer = knob.querySelector('.pointer');
  const readout = knob.querySelector('.readout');
  let hideTimer;
  let startY = 0;
  let startValue = 0;
  const paint = () => {
    pointer.style.transform = `rotate(${-135 + 27 * Number(input.value)}deg)`;
    readout.textContent = Number(input.value).toFixed(1);
  };
  const showBriefly = () => {
    knob.classList.add('active');
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => knob.classList.remove('active'), 900);
  };
  input.addEventListener('input', () => { paint(); showBriefly(); });
  dial.addEventListener('pointerdown', event => {
    dial.setPointerCapture(event.pointerId);
    startY = event.clientY;
    startValue = Number(input.value);
    knob.classList.add('active');
    clearTimeout(hideTimer);
    input.focus({ preventScroll: true });
    event.preventDefault();
  });
  dial.addEventListener('pointermove', event => {
    if (!dial.hasPointerCapture(event.pointerId)) return;
    const next = Math.min(10, Math.max(0, startValue + (startY - event.clientY) / 15));
    input.value = (Math.round(next * 10) / 10).toFixed(1);
    paint();
  });
  dial.addEventListener('pointerup', showBriefly);
  dial.addEventListener('pointercancel', showBriefly);
  paint();
  return knob;
}

function buildPedal({ name, colour, knobs }) {
  const pedal = document.createElement('div');
  pedal.className = 'pedal';
  pedal.style.setProperty('--tint', colour);
  pedal.innerHTML = `
    <img class="jack left" src="${PART('jack')}" alt="" draggable="false">
    <img class="jack right" src="${PART('jack')}" alt="" draggable="false">
    <div class="face">
      ${['tl', 'tr', 'bl', 'br'].map(spot => `<img class="screw ${spot}" src="${PART('screw')}" alt="" draggable="false">`).join('')}
      <div class="knobs"></div>
      <div class="light"><img class="unlit" src="${PART('light-off')}" alt="" draggable="false"><img class="lit" src="${PART('light-on')}" alt="" draggable="false"></div>
      <div class="name">${name}</div>
      <button class="foot" type="button" aria-pressed="true" aria-label="${name} on">
        <img class="raised" src="${PART('foot-up')}" alt="" draggable="false"><img class="pressed" src="${PART('foot-down')}" alt="" draggable="false">
      </button>
    </div>`;
  pedal.querySelector('.knobs').append(...knobs.map(buildKnob));
  const foot = pedal.querySelector('.foot');
  foot.addEventListener('click', () => {
    const on = !pedal.classList.toggle('off');
    foot.setAttribute('aria-pressed', String(on));
    foot.setAttribute('aria-label', `${name} ${on ? 'on' : 'off'}`);
  });
  return pedal;
}

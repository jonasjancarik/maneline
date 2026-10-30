'use strict';
// What the editor knows about amp parameters. Ranges are inferred from preset
// definitions, not firmware documentation; the amp rejects out-of-range values.
const parameterLabels = {
  volume: 'Volume (dB)', treb: 'Treble', mid: 'Middle', gatePreset: 'Noise gate', cabsimType: 'Cabinet',
  gateDetectorPosition: 'Noise gate input', time: 'Delay time', predelay: 'Pre-delay', damping: 'Damping',
  feedback: 'Feedback', comppreset: 'Compression setting', ratehz: 'Rate (Hz)', lrphase: 'Stereo phase',
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
  attenuate: 'Attenuation', hbe: 'High-gain boost', c45: 'C45 switch', sat: 'Saturation',
  tapTimeBPM: 'Tap tempo (BPM)', noteDivision: 'Note division'
};
const choiceLabels = { mid: 'Medium', none: 'Off', off: 'Off', jack: 'Guitar input',
  dottedEighth: 'Dotted eighth', quarter: 'Quarter',
  '57champ': "'57 Champ cabinet", '57dlx': "'57 Deluxe cabinet", '59bman': "'59 Bassman cabinet",
  '65dlx': "'65 Deluxe cabinet", '65prince': "'65 Princeton cabinet", '65twn': "'65 Twin cabinet",
  exlsr: 'Excelsior cabinet', '1x12ss': '1×12 cabinet', '2x12c': '2×12 C cabinet',
  '4x12g': '4×12 G cabinet', '4x12g2': '4×12 G2 cabinet', '4x12m': '4×12 M cabinet',
  '4x12r': '4×12 R cabinet', '4x12sld': '4×12 SLD cabinet', '4x12v': '4×12 V cabinet',
  '4x12v2': '4×12 V2 cabinet' };
const nodeLabels = { amp: 'Amplifier', stomp: 'Stompbox', mod: 'Modulation', delay: 'Delay', reverb: 'Reverb' };

// Shown as a 0–10 slider when the stored value is between 0 and 1.
const ratioParameters = new Set(['gain', 'gain2', 'bass', 'mid', 'treb', 'treble', 'low', 'high', 'highmid', 'lowmid',
  'lowtone', 'midtone', 'hightone', 'presence', 'resonance', 'drive', 'tone', 'mix', 'depth', 'moddepth', 'pandepth',
  'feedback', 'fdbklvl', 'feedbacklvl', 'wetlvl', 'decay', 'dwell', 'diffuse', 'damping', 'dampingcoef', 'bias',
  'lowcut', 'fblowcut', 'fbhighcut', 'lrphase', 'mastervolume', 'stereospread', 'dutycycle', 'wowlevel',
  'attenuate', 'sat']);
// Whole-number choices. The amp does not report their names, so they stay numbered.
const wholeNumberParameters = new Set(['comppreset', 'dlymodtype', 'panmodtype', 'modshape', 'inputfiltermode',
  'lfoclip', 'prefilttype', 'lfoshape', 'shape', 'type', 'sag', 'mode']);
const numberSteps = { ratehz: 0.01, modratehz: 0.01, panratehz: 0.01, dlytime: 0.01, delaytime: 0.01, avgdelay: 0.01,
  time: 0.01, predelay: 0.01, tapTimeBPM: 1, volume: 0.5, outputlevel: 0.5, wetlvl: 0.5 };
const positiveOnly = new Set(['ratehz', 'modratehz', 'panratehz', 'dlytime', 'delaytime', 'avgdelay', 'time',
  'predelay', 'tapTimeBPM']);
// Listed first, in this order; anything in `advancedParameters` moves behind the toggle.
const parameterOrder = ['gain', 'gain2', 'drive', 'volume', 'mastervolume', 'outputlevel', 'bass', 'low', 'lowtone', 'mid',
  'lowmid', 'midtone', 'highmid', 'treb', 'treble', 'high', 'hightone', 'presence', 'tone', 'mix', 'wetlvl', 'decay', 'dwell',
  'depth', 'ratehz', 'dlytime', 'delaytime', 'time', 'feedback', 'fdbklvl', 'feedbacklvl', 'cabsimType', 'gatePreset'];
const advancedParameters = new Set(['bias', 'sag', 'gateDetectorPosition', 'fblowcut', 'fbhighcut', 'modratehz', 'moddepth',
  'modshape', 'dlymodtype', 'panratehz', 'pandepth', 'panmodtype', 'tapTimeBPM', 'noteDivision', 'lrphase', 'lowcut',
  'diffuse', 'inputfiltermode', 'prefilttype', 'lfoclip', 'lfoshape', 'dutycycle', 'stereospread', 'avgdelay',
  'predelay', 'dampingcoef', 'hbe', 'c45', 'mode']);

function parameterLabel(key) {
  return parameterLabels[key] || key.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, c => c.toUpperCase());
}

function parameterRank(key) {
  const rank = parameterOrder.indexOf(key);
  return rank < 0 ? parameterOrder.length : rank;
}

// Decides which control a parameter gets. `unscaled` lists parameters seen outside 0–1 for this model.
function controlSpec(parameter, value, unscaled, choices) {
  if (typeof value === 'boolean') return { kind: 'toggle' };
  if (typeof value === 'string') return choices?.length ? { kind: 'select' } : { kind: 'text' };
  if (wholeNumberParameters.has(parameter)) return { kind: 'number', step: 1, min: 0 };
  if (ratioParameters.has(parameter) && !unscaled && value >= 0 && value <= 1) return { kind: 'slider' };
  const step = numberSteps[parameter] || (Math.abs(value) >= 10 ? 1 : 0.1);
  return { kind: 'number', step, min: positiveOnly.has(parameter) ? 0 : undefined,
    label: unscaled && parameter === 'wetlvl' ? 'Effect level (dB)' : undefined };
}

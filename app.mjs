/* SPDX-License-Identifier: GPL-3.0-only */
import { AfterglowEngine, PARAM_NAMES, SCENES, EXTRA_DEFAULTS } from './afterglow-engine.mjs';

const $ = id => document.getElementById(id);
const $$ = selector => [...document.querySelectorAll(selector)];
const KEY_MAP = new Map(Object.entries({
  a:0,w:1,s:2,e:3,d:4,f:5,t:6,g:7,y:8,h:9,u:10,j:11,
  k:12,o:13,l:14,p:15,';':16,"'":17,
}));
const BLACKS = new Set([1,3,6,8,10]);
const KEY_LABELS = ['A','W','S','E','D','F','T','G','Y','H','U','J','K','O','L','P',';','\''];
const STORAGE_KEY = 'afterglow-v05-user-patch';
const PAGE_IDS = ['soundA','soundB','env','lfo','fx','global','arp','seq'];
const PAGE_TITLES = ['SOUND A','SOUND B','ENVELOPE','MODULATION','EFFECTS','GLOBAL','ARPEGGIATOR','SEQUENCER'];
const PRESETS = SCENES.flatMap((scene,i) => [
  {name: `${scene.name} / ORIGINAL`, scene: i, params:scene.params.slice()},
  {name: `${scene.name} / SOFT`, scene: i, params: scene.params.map((v,j)=>j===5?Math.max(5,v-24):j===6?Math.min(127,v+10):v)},
  {name: `${scene.name} / WIDE`, scene: i, params:scene.params.map((v,j)=>j===3||j===4?Math.min(127,v+30):j===6?Math.min(127,v+14):v)},
]);
let extra = {...EXTRA_DEFAULTS};
let page = 'soundA';
let presetIndex = 0;
let tempo = 100, gate = 90, transpose = 0;
let root = 0, patternIndex = 0, arpDirection = 0, arpOctaves = 0;
let transportMode = 'seq', transportRunning = false, tickTimer, gateTimer, transportNote = null;
let stepIndex = -1;
const arpInputs = new Set();
let currentArpIndex = 0;
const SEQ_PATTERNS = [
  [0,7,12,7,3,10,12,7], [0,12,7,15,5,12,8,3],
  [0,4,7,12,9,7,4,2], [0,3,7,10,12,10,7,3],
];
let scene = 0;
let knobBank = 0;
let params = SCENES[0].params.slice();
let octave = 0;
let hold = false;
let audioContext, worklet, scriptNode, compatibilityEngine;
let audioReady = false;
let audioStarting = null;
let sampleRate = 44100;
let scopeSamples = null, peak = 0;
let activeNotes = new Set();
let keyboardHeld = new Map();
let pointerHeld = new Map();
let midiAccess;
let recording = false, recordChunks = [], recordFrames = 0, recordStart = 0;
let recordClock;
let toastTimer;

function toast(message) {
  $('toast').textContent = message.toUpperCase();
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $('toast').textContent = 'AN ORIGINAL INSTRUMENT IN DEVELOPMENT', 4300);
}

function send(data) {
  if (worklet) worklet.port.postMessage(data);
  else if (compatibilityEngine) {
    if (data.type === 'noteOn') compatibilityEngine.noteOn(data.note, data.velocity);
    if (data.type === 'noteOff') compatibilityEngine.noteOff(data.note);
    if (data.type === 'param') compatibilityEngine.setParam(data.index, data.value);
    if (data.type === 'extra') compatibilityEngine.setExtra(data.name, data.value);
    if (data.type === 'transportOff') compatibilityEngine.noteOff(data.note, true);
    if (data.type === 'scene') compatibilityEngine.setScene(data.scene);
    if (data.type === 'master') compatibilityEngine.master = data.value;
    if (data.type === 'hold') compatibilityEngine.setHold(data.value);
    if (data.type === 'panic') compatibilityEngine.panic();
  }
}

function gotAudioMessage(data) {
  if (data.type === 'scope') {
    scopeSamples = data.samples;
    peak = data.peak;
    const db = Math.max(-90, 20 * Math.log10(Math.max(peak, 0.00003)));
    $('signalReadout').textContent = `${Math.round(db)} dB`;
  } else if (data.type === 'recordChunk') {
    recordChunks.push(data.samples);
    recordFrames += data.samples.length / 2;
  } else if (data.type === 'recordDone') {
    exportRecording();
  }
}

async function enableAudio() {
  if (audioStarting) return audioStarting;
  if (audioReady) {
    if (audioContext.state !== 'running') await audioContext.resume();
    return;
  }
  audioStarting = (async () => {
    try {
      const Context = window.AudioContext || window.webkitAudioContext;
      if (!Context) throw new Error('Web Audio is not available in this browser');
      try { audioContext = new Context({ sampleRate: 44100, latencyHint: 'interactive' }); }
      catch { audioContext = new Context(); }
      await audioContext.resume();
      sampleRate = audioContext.sampleRate;
      if (audioContext.audioWorklet) {
        try {
          await audioContext.audioWorklet.addModule('./afterglow-worklet.mjs');
          worklet = new AudioWorkletNode(audioContext, 'afterglow-v03', {
            numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2],
          });
          worklet.port.onmessage = event => gotAudioMessage(event.data);
          worklet.connect(audioContext.destination);
        } catch (error) {
          console.warn('AudioWorklet unavailable; using compatibility mode', error);
        }
      }
      if (!worklet) {
        // A safe fallback for older browser engines. The same browser DSP is
        // rendered on the main thread, at higher latency than AudioWorklet.
        compatibilityEngine = new AfterglowEngine(sampleRate);
        scriptNode = audioContext.createScriptProcessor(1024, 0, 2);
        scriptNode.onaudioprocess = event => {
          const l = event.outputBuffer.getChannelData(0);
          const r = event.outputBuffer.getChannelData(1);
          compatibilityEngine.render(l, r);
          peak = Math.max(...l.map(Math.abs));
          scopeSamples = Float32Array.from({length:64}, (_,i) => l[Math.floor(i*l.length/64)]);
          if (recording) gotAudioMessage({type:'recordChunk',samples:interleave(l,r)});
        };
        scriptNode.connect(audioContext.destination);
        toast('Compatibility audio mode; AudioWorklet is recommended');
      }
      send({type:'scene',scene});
      params.forEach((value,index) => send({type:'param',index,value}));
      Object.entries(extra).forEach(([name,value]) => send({type:'extra',name,value}));
      send({type:'master',value:Number($('master').value)/100});
      send({type:'hold',value:hold});
      audioReady = true;
      $('renderStatus').textContent = '● AUDIO ENGINE LIVE';
      $('renderStatus').classList.add('live');
      $('audioLabel').textContent = 'Audio is on';
      $('audioButton').setAttribute('aria-pressed','true');
      $('sampleRate').textContent = `${(sampleRate/1000).toFixed(1)} kHz`;
      $('screenMessage').textContent = 'YOUR SOUND, YOUR SPACE';
    } catch (error) {
      console.error(error);
      toast(`Could not start audio: ${error.message}`);
      throw error;
    }
  })();
  try { await audioStarting; } finally { audioStarting = null; }
}

function interleave(l, r) {
  const samples = new Float32Array(l.length*2);
  for (let i=0;i<l.length;i++) { samples[i*2]=l[i]; samples[i*2+1]=r[i]; }
  return samples;
}

function updateLeftDisplay(id,value,max) {
  const el=$(`left-${id}`);
  if (!el) return;
  const angle = max ? (-135 + 270*value/max) : 0;
  el.style.setProperty('--rotation', `${angle}deg`);
  el.setAttribute('aria-valuenow', String(value));
}
function setScene(index) {
  scene = Math.max(0, Math.min(2,Math.round(index)));
  params = SCENES[scene].params.slice();
  presetIndex = scene * 3;
  $$('[data-scene]').forEach(button => {
    const selected = Number(button.dataset.scene) === scene;
    button.classList.toggle('selected',selected);
    button.classList.toggle('active',selected);
    button.setAttribute('aria-pressed',String(selected));
  });
  document.documentElement.style.setProperty('--accent',SCENES[scene].color);
  $('sceneDescription').textContent = SCENES[scene].description;
  $('sceneCode').textContent = `00${scene+1} / ${SCENES[scene].name}`;
  $('engineMode').textContent = ['GRANULAR CLOUD','DUAL ANALOG','HYBRID SHIMMER'][scene];
  $('screenMessage').textContent = SCENES[scene].tagline.toUpperCase();
  $('left-algorithm-value').textContent = ['GRAIN','ANALOG','HYBRID'][scene];
  $('left-presets-value').textContent=String(presetIndex+1).padStart(2,'0');
  updateLeftDisplay('algorithm',scene,2);
  updateLeftDisplay('presets',presetIndex,8);
  renderKnobs();
  send({type:'scene',scene});
  toast(`${SCENES[scene].name} engine loaded`);
}
function selectPreset(index) {
  presetIndex=Math.max(0,Math.min(PRESETS.length-1,Math.round(index)));
  const patch=PRESETS[presetIndex];
  setScene(patch.scene);
  presetIndex=index;
  params=patch.params.slice();
  extra={...EXTRA_DEFAULTS};
  send({type:'scene',scene});
  params.forEach((value,i)=>send({type:'param',index:i,value}));
  Object.entries(extra).forEach(([name,value])=>send({type:'extra',name,value}));
  $('left-presets-value').textContent=String(presetIndex+1).padStart(2,'0');
  updateLeftDisplay('presets',presetIndex,8);
  renderKnobs();
  toast(`Preset ${presetIndex+1}: ${patch.name}`);
}
function changeParam(index,value) {
  if(index===7){ setMaster(Math.round(value)); return; }
  params[index]=Math.max(0,Math.min(127,Math.round(value)));
  send({type:'param',index,value:params[index]});
  refreshKnobs();
}
function setExtra(name,value) {
  if(!(name in EXTRA_DEFAULTS))return;
  extra[name]=Math.max(0,Math.min(127,Math.round(value)));
  send({type:'extra',name,value:extra[name]});
  refreshKnobs();
}
function setMaster(value) {
  const n=Math.max(0,Math.min(127,Math.round(value)));
  const percent=Math.round(n/127*100);
  $('master').value=percent;
  $('masterValue').textContent=`${percent}%`;
  $('left-master-value').textContent=`${percent}%`;
  updateLeftDisplay('master',n,127);
  send({type:'master',value:percent/100});
  if(page==='global')refreshKnobs();
}
function pageInfo(){return PAGE_TITLES[PAGE_IDS.indexOf(page)];}
function setPage(id) {
  if(!PAGE_IDS.includes(id))return;
  page=id;
  const n=PAGE_IDS.indexOf(page);
  $('currentPageLabel').textContent=pageInfo();
  $('currentPageHint').textContent='ROTATE 4 CONTROLS';
  $('left-select-value').textContent=pageInfo();
  updateLeftDisplay('select',n,PAGE_IDS.length-1);
  $$('[data-bank]').forEach((el,i)=>{
    const selected=page===(i===0?'soundA':'soundB');
    el.classList.toggle('selected',selected);
    el.setAttribute('aria-pressed',String(selected));
  });
  const map={soundA:'bankHome',soundB:'bankEdit',env:'bankEnv',lfo:'bankLfo',fx:'resetButton',global:'bankGlobal',arp:'arpButton',seq:'bankSeq'};
  $$('.hardware-button').forEach(button=>button.classList.toggle('selected-mode',button.id===map[page]));
  $('screenMessage').textContent=`${pageInfo()} / 4 ENCODERS`;
  renderKnobs();
}
function setTempo(n){tempo=Math.max(40,Math.min(220,Math.round(n)));updateTransportStatus();if(transportRunning)restartTransport();}
function setGate(n){gate=Math.max(10,Math.min(127,Math.round(n)));}
function setTranspose(n){if(transpose===n)return;releaseControls();transpose=Math.max(-12,Math.min(12,Math.round(n)));updateKeyboardLabels();}
function binding(label, get, set, max=127,min=0) {return {label,get,set,max,min};}
function soundParam(index){return binding(PARAM_NAMES[scene][index],()=>params[index],v=>changeParam(index,v));}
function extraParam(label,name){return binding(label,()=>extra[name],v=>setExtra(name,v));}
function refreshKnobs(){
  if(!$('knobGrid'))return;
  const binds=pageKnobs();
  $$('.knob-cell').forEach((cell,i)=>{
    const bind=binds[i];if(!bind)return;
    const value=bind.get(),percent=(value-bind.min)/(bind.max-bind.min||1);
    const knob=cell.querySelector('.knob');
    knob.setAttribute('aria-valuenow',String(value));
    knob.style.setProperty('--arc',`${percent*270}deg`);
    knob.style.setProperty('--rotation',`${percent*270-135}deg`);
    cell.querySelector('.knob-value').textContent=String(value).padStart(3,'0');
  });
}
function pageKnobs() {
  switch(page){
    case 'soundA': return [0,1,2,3].map(soundParam);
    case 'soundB': return [soundParam(4),soundParam(5),soundParam(6),extraParam('FX MIX','fxMix')];
    case 'env': return [extraParam('ATTACK','attack'),extraParam('RELEASE','release'),extraParam('SUSTAIN','sustain'),extraParam('VELOCITY','velocity')];
    case 'lfo': return [extraParam('RATE','lfoRate'),extraParam('DEPTH','lfoDepth'),binding('TARGET',()=>extra.lfoTarget,v=>setExtra('lfoTarget',v),2),binding('SHAPE',()=>extra.lfoShape>>5,v=>setExtra('lfoShape',v*32),3)];
    case 'fx': return [extraParam('WET','fxMix'),extraParam('CHORUS','chorus'),extraParam('FEEDBACK','feedback'),binding('FX ON',()=>extra.fxEnabled>=64?1:0,v=>setExtra('fxEnabled',v?127:0),1)];
    case 'global': return [binding('MASTER',()=>Math.round(Number($('master').value)/100*127),setMaster),binding('OCTAVE',()=>octave,v=>setOctave(v),2,-2),binding('BPM',()=>tempo,setTempo,220,40),binding('TRANSPOSE',()=>transpose,setTranspose,12,-12)];
    case 'arp': return [binding('BPM',()=>tempo,setTempo,220,40),binding('GATE',()=>gate,setGate),binding('OCTAVES',()=>arpOctaves,v=>{arpOctaves=Math.round(v)},2),binding('ORDER',()=>arpDirection,v=>{arpDirection=Math.round(v)},3)];
    case 'seq': return [binding('BPM',()=>tempo,setTempo,220,40),binding('GATE',()=>gate,setGate),binding('PATTERN',()=>patternIndex,v=>{patternIndex=Math.round(v)},3),binding('ROOT',()=>root,v=>{root=Math.round(v)},11)];
    default: return [0,1,2,3].map(soundParam);
  }
}
function rotaryBinding(element, get, set, min=0,max=127) {
  let drag=null;
  function apply(v){set(Math.max(min,Math.min(max,Math.round(v))));refreshKnobs();}
  const fine = ()=>(max-min<=12?1:2);
  element.addEventListener('pointerdown',event=>{
    if(event.button!==0)return;
    event.preventDefault();
    drag={y:event.clientY,x:event.clientX,value:get(),moved:false};
    element.setPointerCapture(event.pointerId);element.focus();
  });
  element.addEventListener('pointermove',event=>{
    if(!drag)return;
    if(Math.abs(event.clientY-drag.y)+Math.abs(event.clientX-drag.x)>2)drag.moved=true;
    const scale=Math.max((max-min)/170,0.035);
    apply(drag.value+(drag.y-event.clientY)*scale+(event.clientX-drag.x)*scale*.45);
  });
  element.addEventListener('pointerup',()=>{if(drag && !drag.moved && max-min<=12)apply(get()>=max?min:get()+1);drag=null;});
  element.addEventListener('pointercancel',()=>{drag=null;});
  element.addEventListener('lostpointercapture',()=>{drag=null;});
  element.addEventListener('wheel',event=>{
    event.preventDefault();apply(get()+(event.deltaY<0?1:-1)*(event.shiftKey?fine()*4:fine()));
  },{passive:false});
  element.addEventListener('keydown',event=>{
    if(event.key==='Home'){apply(min);event.preventDefault();return;}
    if(event.key==='End'){apply(max);event.preventDefault();return;}
    const delta={ArrowUp:1,ArrowRight:1,ArrowDown:-1,ArrowLeft:-1,PageUp:10,PageDown:-10}[event.key];
    if(delta){event.preventDefault();apply(get()+delta);}
  });
}
function bindLeftKnobs(){
  const knobs=[
    ['master',()=>Math.round(Number($('master').value)*127/100),setMaster,0,127],
    ['select',()=>PAGE_IDS.indexOf(page),v=>setPage(PAGE_IDS[v]),0,PAGE_IDS.length-1],
    ['presets',()=>presetIndex,selectPreset,0,PRESETS.length-1],
    ['algorithm',()=>scene,setScene,0,2],
  ];
  knobs.forEach(([id,get,set,min,max])=>rotaryBinding($(`left-${id}`),get,set,min,max));
  updateLeftDisplay('master',94,127);
}
function renderKnobs() {
  const grid=$('knobGrid');
  if(!grid)return;
  grid.replaceChildren();
  pageKnobs().forEach((bind,i)=>{
    const value=bind.get();
    const cell=document.createElement('div');
    cell.className='knob-cell';
    cell.innerHTML=`<div class="knob" role="slider" tabindex="0" aria-label="${bind.label}" aria-valuemin="${bind.min}" aria-valuemax="${bind.max}" aria-valuenow="${value}"><div class="knob-track"></div><div class="knob-face"></div><div class="knob-indicator"></div></div><span class="knob-label">${bind.label}</span><span class="knob-value">${String(value).padStart(3,'0')}</span>`;
    const knob=cell.querySelector('.knob');
    const pct=(value-bind.min)/(bind.max-bind.min||1);
    knob.style.setProperty('--arc',`${pct*270}deg`);
    knob.style.setProperty('--rotation',`${pct*270-135}deg`);
    grid.append(cell);
    rotaryBinding(knob,bind.get,bind.set,bind.min,bind.max);
  });
}
function setBank(index){setPage(index===1?'soundB':'soundA');}
function midiNote(relative) { return 60 + 12*octave + relative + transpose; }
function lightKey(relative,pressed) {
  $$('.piano-key').filter(key => Number(key.dataset.relative)===relative).forEach(key => key.classList.toggle('pressed',pressed));
}
async function noteOn(relative,origin,velocity=105) {
  const note=midiNote(relative);
  const key=String(origin);
  if(activeNotes.has(key))return;
  activeNotes.add(key);
  lightKey(relative,true);
  try {
    await enableAudio();
    if(!activeNotes.has(key))return;
    if(transportRunning&&transportMode==='arp')arpInputs.add(note);
    else send({type:'noteOn',note,velocity});
  } catch { /* Audio startup error displayed above. */ }
}
function noteOff(relative,origin) {
  const key=String(origin);
  if(!activeNotes.delete(key))return;
  lightKey(relative,false);
  const note=midiNote(relative);
  arpInputs.delete(note);
  if(!(transportRunning&&transportMode==='arp'))send({type:'noteOff',note});
}
function releaseControls() {
  for (const [key,relative] of keyboardHeld) noteOff(relative,`keyboard-${key}`);
  keyboardHeld.clear();
  for (const [pointer,relative] of pointerHeld) noteOff(relative,`pointer-${pointer}`);
  pointerHeld.clear();
}
function setOctave(value) {
  value = Math.max(-2,Math.min(2,value));
  if (octave===value) return;
  releaseControls();
  octave=value;
  $('octaveLabel').textContent=`OCTAVE ${octave>0?'+':''}${octave}`;
  updateKeyboardLabels();
}
function toggleHold() {
  hold=!hold;
  $('holdToggle').classList.toggle('active',hold);
  $('holdToggle').textContent=hold?'HOLD ON':'HOLD OFF';
  $('holdToggle').setAttribute('aria-pressed',String(hold));
  send({type:'hold',value:hold});
}
function createKeyboard() {
  const container = $('keyboard');
  for (let n=0; n<27; n++) {
    const key=document.createElement('button');
    key.type='button'; key.className='piano-key'; key.dataset.relative=n;
    if (n===13) key.style.gridColumn = 'auto';
    key.innerHTML=`<span>${KEY_LABELS[n]||'·'}</span>`;
    container.append(key);
  }
  container.addEventListener('pointerdown',event=>{
    const key=event.target.closest('.piano-key');
    if(!key||event.button!==0)return;
    event.preventDefault();
    const n=Number(key.dataset.relative);
    pointerHeld.set(event.pointerId,n);
    key.setPointerCapture(event.pointerId);
    noteOn(n,`pointer-${event.pointerId}`);
  });
  const endPointer=event=>{
    if(!pointerHeld.has(event.pointerId))return;
    const n=pointerHeld.get(event.pointerId);
    noteOff(n,`pointer-${event.pointerId}`);
    pointerHeld.delete(event.pointerId);
  };
  container.addEventListener('pointerup',endPointer);
  container.addEventListener('pointercancel',endPointer);
  container.addEventListener('lostpointercapture',endPointer);
  updateKeyboardLabels();
}

function updateKeyboardLabels() {
  $$('.piano-key').forEach(key=>{
    const n=midiNote(Number(key.dataset.relative));
    const names=['C','C♯','D','D♯','E','F','F♯','G','G♯','A','A♯','B'];
    key.setAttribute('aria-label',`${names[n%12]}${Math.floor(n/12)-1}`);
  });
}

function handleKeys() {
  document.addEventListener('keydown',event=>{
    if(event.metaKey||event.ctrlKey||event.altKey||event.repeat)return;
    const target=event.target;
    if(target.closest('input,textarea,select,[contenteditable],.knob'))return;
    const code=event.key.toLowerCase();
    if(KEY_MAP.has(code)) {
      event.preventDefault();
      const n=KEY_MAP.get(code);
      keyboardHeld.set(code,n);
      noteOn(n,`keyboard-${code}`);
    } else if(event.key==='[') {event.preventDefault();setOctave(octave-1);}
    else if(event.key===']') {event.preventDefault();setOctave(octave+1);}
    else if(event.code==='Space') {event.preventDefault();toggleHold();}
    else if(event.key==='Escape') {event.preventDefault();panic();}
  });
  document.addEventListener('keyup',event=>{
    const code=event.key.toLowerCase();
    if(!keyboardHeld.has(code))return;
    noteOff(keyboardHeld.get(code),`keyboard-${code}`);
    keyboardHeld.delete(code);
  });
  window.addEventListener('blur',releaseControls);
}

function panic() {
  stopTransport();
  releaseControls();
  hold=false;
  $('holdToggle').classList.remove('active');
  $('holdToggle').textContent='HOLD OFF';
  $('holdToggle').setAttribute('aria-pressed','false');
  send({type:'panic'});
  toast('PANIC — ALL VOICES RELEASED');
}
function updateTransportStatus(){
  $('transportLabel').textContent=`${transportRunning?'PLAY':'STOP'} · ${tempo} BPM`;
  $('transportModeLabel').textContent=transportMode==='arp'?'ARPEGGIATOR':'SEQUENCER';
  $('transportButton').classList.toggle('running',transportRunning);
  $('transportButton').setAttribute('aria-pressed',String(transportRunning));
  $('transportButton').textContent=transportRunning?'■ STOP':'▶ PLAY';
  $('arpButton').classList.toggle('active',transportMode==='arp');
  $('arpButton').setAttribute('aria-pressed',String(transportMode==='arp'));
  $('bankSeq').classList.toggle('active',transportMode==='seq');
  $$('.step-dot').forEach((dot,i)=>dot.classList.toggle('current',transportRunning&&i===stepIndex));
  document.querySelector('.screen-bezel')?.classList.toggle('playing',transportRunning);
}
function releaseTransportNote(){
  clearTimeout(gateTimer);
  if(transportNote!==null){send({type:'transportOff',note:transportNote});transportNote=null;}
}
function sequenceNote(){
  return Math.max(0,Math.min(127,48+root+transpose+SEQ_PATTERNS[patternIndex][stepIndex]));
}
function arpeggioNote(){
  const notes=[...arpInputs].sort((a,b)=>a-b);
  if(!notes.length)return null;
  let ordered=notes;
  if(arpDirection===1)ordered=[...notes].reverse();
  else if(arpDirection===2)ordered=[...notes,...notes.slice(1,-1).reverse()];
  let n=ordered[currentArpIndex%ordered.length];
  if(arpDirection===3)n=notes[Math.floor(Math.random()*notes.length)];
  if(arpOctaves) n+=12*(Math.floor(currentArpIndex/Math.max(1,ordered.length))%(arpOctaves+1));
  currentArpIndex++;
  return Math.min(127,n);
}
function transportTick(){
  if(!transportRunning)return;
  releaseTransportNote();
  stepIndex=(stepIndex+1)%8;
  const note=transportMode==='arp'?arpeggioNote():sequenceNote();
  if(note!==null){
    transportNote=note;
    send({type:'noteOn',note,velocity:108});
    gateTimer=setTimeout(releaseTransportNote,(60000/tempo/2)*(gate/127));
  }
  updateTransportStatus();
  tickTimer=setTimeout(transportTick,60000/tempo/2);
}
function stopTransport(){
  transportRunning=false;
  clearTimeout(tickTimer);releaseTransportNote();
  stepIndex=-1;arpInputs.clear();currentArpIndex=0;
  updateTransportStatus();
}
function startTransport(){
  enableAudio().then(()=>{
    if(transportRunning)return;
    if(hold)toggleHold();
    transportRunning=true;stepIndex=-1;currentArpIndex=0;
    updateTransportStatus();transportTick();
    toast(`${transportMode==='arp'?'Arpeggiator':'Sequencer'} playing`);
  }).catch(()=>{});
}
function toggleTransport(){if(transportRunning)stopTransport();else startTransport();}
function setTransportMode(next){
  const previous=transportRunning;
  stopTransport();transportMode=next;
  setPage(next);updateTransportStatus();
  if(previous)startTransport();
  else toast(`${next==='arp'?'Arpeggiator':'Sequencer'} selected — PLAY to start`);
}
function restartTransport(){if(!transportRunning)return;clearTimeout(tickTimer);tickTimer=setTimeout(transportTick,60000/tempo/2);}
function pushRecording(samples) {
  recordChunks.push(samples);
  recordFrames+=samples.length/2;
}
function setRecordState(value) {
  recording=value;
  $('recordButton').classList.toggle('recording',value);
  $('recordLabel').textContent=value?'STOP':'REC';
  if(value) {
    recordChunks=[];recordFrames=0;recordStart=performance.now();
    $('recordTimer').textContent='00:00';
    clearInterval(recordClock);
    recordClock=setInterval(()=>{
      const seconds=Math.min(60,Math.floor((performance.now()-recordStart)/1000));
      $('recordTimer').textContent=`00:${String(seconds).padStart(2,'0')}`;
      if(seconds>=60)stopRecording();
    },200);
    if(worklet)send({type:'recordStart'});
    toast('Recording your performance');
  } else {
    clearInterval(recordClock);
    if(worklet)send({type:'recordStop'});
    else exportRecording();
  }
}
async function toggleRecording() {
  if(recording) {stopRecording();return;}
  try {await enableAudio();setRecordState(true);}catch {/* reported in enableAudio */}
}
function stopRecording() {if(recording)setRecordState(false);}
function exportRecording() {
  if(recordFrames===0) {toast('Recording was empty');return;}
  const bytes=44+recordFrames*4;
  const buf=new ArrayBuffer(bytes);
  const dv=new DataView(buf);
  const writeText=(pos,str)=>{for(let i=0;i<str.length;i++)dv.setUint8(pos+i,str.charCodeAt(i));};
  writeText(0,'RIFF');dv.setUint32(4,bytes-8,true);writeText(8,'WAVE');writeText(12,'fmt ');
  dv.setUint32(16,16,true);dv.setUint16(20,1,true);dv.setUint16(22,2,true);
  dv.setUint32(24,sampleRate,true);dv.setUint32(28,sampleRate*4,true);
  dv.setUint16(32,4,true);dv.setUint16(34,16,true);writeText(36,'data');dv.setUint32(40,bytes-44,true);
  let pos=44;
  for(const chunk of recordChunks)for(const sample of chunk){
    const value=Math.max(-1,Math.min(1,sample));
    dv.setInt16(pos,value<0?Math.round(value*32768):Math.round(value*32767),true);
    pos+=2;
  }
  const blob=new Blob([buf],{type:'audio/wav'});
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a');
  a.href=url;
  a.download=`afterglow-v0.5-${new Date().toISOString().replace(/[:.]/g,'-')}.wav`;
  document.body.append(a);a.click();a.remove();
  setTimeout(()=>URL.revokeObjectURL(url),60000);
  toast(`Saved ${Math.round(recordFrames/sampleRate)} seconds of stereo WAV`);
  recordChunks=[];recordFrames=0;
}

async function connectMIDI() {
  if(!navigator.requestMIDIAccess){toast('MIDI requires Chrome or Edge over HTTPS');return;}
  try {
    await enableAudio();
    midiAccess=await navigator.requestMIDIAccess({sysex:false});
    const attach=()=>{
      let total=0;
      midiAccess.inputs.forEach(input=>{
        input.onmidimessage=event=>{
          const [status,note,velocity=0]=event.data;
          const type=status&0xf0;
          if(type===0x90&&velocity>0){
            if(transportRunning&&transportMode==='arp')arpInputs.add(note);
            else send({type:'noteOn',note,velocity});
          } else if(type===0x80||(type===0x90&&velocity===0)){
            arpInputs.delete(note);
            if(!(transportRunning&&transportMode==='arp'))send({type:'noteOff',note});
          } else if(type===0xb0) {
            if(note===1)setExtra('lfoDepth',velocity);
            if(note===7)setMaster(velocity);
            if(note===74)changeParam(5,velocity);
            if(note===64&&Boolean(velocity>=64)!==hold)toggleHold();
          }
        };total++;
      });
      $('midiButton').textContent=total?`MIDI ${total} CONNECTED`:'MIDI CONNECT';
      toast(total?`${total} MIDI input${total===1?'':'s'} connected`:'MIDI authorized; no keyboard detected');
    };
    midiAccess.onstatechange=attach;attach();
  }catch(error){console.warn(error);toast('MIDI access unavailable or denied');}
}
function animateScope(t=0) {
  const canvas=$('scope');
  const ctx=canvas.getContext('2d');
  const width=canvas.width,height=canvas.height;
  ctx.clearRect(0,0,width,height);
  const mid=height*0.52;
  ctx.strokeStyle='#304b3b';ctx.lineWidth=1;
  for(let line=1;line<=5;line++) {
    const y=line*height/6;
    ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(width,y);ctx.stroke();
  }
  ctx.strokeStyle='#476652';ctx.setLineDash([5,12]);
  ctx.beginPath();ctx.moveTo(0,mid);ctx.lineTo(width,mid);ctx.stroke();ctx.setLineDash([]);
  const color=['#a9d9aa','#edd4b8','#add1cf'][scene];
  ctx.shadowColor=color;ctx.shadowBlur=22;ctx.strokeStyle=color;ctx.lineWidth=3.1;
  ctx.beginPath();
  for(let x=0;x<width;x+=2) {
    let y;
    if(scopeSamples&&peak>0.00001) {
      const index=Math.floor(x/width*scopeSamples.length);
      const value=scopeSamples[Math.min(scopeSamples.length-1,index)];
      y=mid-value*height*.42;
    } else {
      const phi=x/width*TAU_LOCAL*4+(t/1000)*0.42;
      const envelope=Math.sin(Math.PI*x/width)**2;
      y=mid-(Math.sin(phi)+0.4*Math.sin(phi*2.01))*height*.18*envelope;
    }
    if(x===0)ctx.moveTo(x,y);else ctx.lineTo(x,y);
  }
  ctx.stroke();ctx.shadowBlur=0;
  if (compatibilityEngine && audioReady) {
    const db=Math.max(-90,20*Math.log10(Math.max(peak,0.00003)));
    $('signalReadout').textContent=`${Math.round(db)} dB`;
  } else if (!audioReady) $('signalReadout').textContent='— dB';
  requestAnimationFrame(animateScope);
}
const TAU_LOCAL=Math.PI*2;

function savePatch(){
  try{
    localStorage.setItem(STORAGE_KEY,JSON.stringify({scene,params,extra,tempo,gate,transpose,octave,patternIndex,root}));
    toast('Custom patch and performance settings saved');
  }catch{toast('Browser storage unavailable');}
}
function loadPatch(){
  try{
    const data=JSON.parse(localStorage.getItem(STORAGE_KEY));
    if(!data||!Number.isInteger(data.scene)||data.scene<0||data.scene>2||!Array.isArray(data.params)||data.params.length!==7)throw Error('none');
    stopTransport();setScene(data.scene);
    data.params.forEach((value,i)=>{if(Number.isFinite(value))changeParam(i,value)});
    if(data.extra&&typeof data.extra==='object')Object.keys(EXTRA_DEFAULTS).forEach(name=>{
      if(Number.isFinite(data.extra[name]))setExtra(name,data.extra[name]);
    });
    if(Number.isFinite(data.tempo))setTempo(data.tempo);
    if(Number.isFinite(data.gate))setGate(data.gate);
    if(Number.isFinite(data.transpose))setTranspose(data.transpose);
    if(Number.isFinite(data.octave))setOctave(data.octave);
    if(Number.isFinite(data.patternIndex))patternIndex=Math.max(0,Math.min(3,data.patternIndex));
    if(Number.isFinite(data.root))root=Math.max(0,Math.min(11,data.root));
    renderKnobs();toast('Custom patch loaded');
  }catch{toast('No saved custom patch yet');}
}
function bindUI() {
  $('audioButton').addEventListener('click',enableAudio);
  $$('[data-scene]').forEach(button=>button.addEventListener('click',()=>setScene(Number(button.dataset.scene))));
  $$('[data-bank]').forEach(button=>button.addEventListener('click',()=>setBank(Number(button.dataset.bank))));
  $('resetButton').addEventListener('click',()=>setPage('fx'));
  $('loadButton').addEventListener('click',()=>{loadPatch();setPage('soundA')});
  $('saveButton').addEventListener('click',savePatch);
  $('octaveDown').addEventListener('click',()=>setOctave(octave-1));
  $('octaveUp').addEventListener('click',()=>setOctave(octave+1));
  $('holdToggle').addEventListener('click',toggleHold);
  $('panicButton').addEventListener('click',panic);
  $('bankEnv').addEventListener('click',()=>setPage('env'));
  $('bankLfo').addEventListener('click',()=>setPage('lfo'));
  $('bankEdit').addEventListener('click',()=>setPage('soundB'));
  $('bankHome').addEventListener('click',()=>setPage('soundA'));
  $('bankGlobal').addEventListener('click',()=>setPage('global'));
  $('arpButton').addEventListener('click',()=>setTransportMode('arp'));
  $('bankSeq').addEventListener('click',()=>setTransportMode('seq'));
  $('transportButton').addEventListener('click',toggleTransport);
  $('master').addEventListener('input',event=>setMaster(Math.round(Number(event.target.value)*127/100)));
  $('recordButton').addEventListener('click',toggleRecording);
  $('midiButton').addEventListener('click',connectMIDI);
  bindLeftKnobs();
}
bindUI();
createKeyboard();
handleKeys();
setScene(0);
setPage('soundA');
updateTransportStatus();
requestAnimationFrame(animateScope);

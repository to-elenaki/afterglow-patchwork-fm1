/* SPDX-License-Identifier: GPL-3.0-only */
import { AfterglowEngine, PARAM_NAMES, SCENES } from './afterglow-engine.mjs';

const $ = id => document.getElementById(id);
const $$ = selector => [...document.querySelectorAll(selector)];
const KEY_MAP = new Map(Object.entries({
  a:0,w:1,s:2,e:3,d:4,f:5,t:6,g:7,y:8,h:9,u:10,j:11,
  k:12,o:13,l:14,p:15,';':16,"'":17,
}));
const BLACKS = new Set([1,3,6,8,10]);
const KEY_LABELS = ['A','W','S','E','D','F','T','G','Y','H','U','J','K','O','L','P',';','\''];
const STORAGE_KEY = 'afterglow-v03-user-patch';
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

function setScene(index) {
  scene = Math.max(0, Math.min(2,index));
  params = SCENES[scene].params.slice();
  $$('[data-scene]').forEach(button => {
    const selected = Number(button.dataset.scene) === scene;
    button.classList.toggle('selected',selected);
    button.setAttribute('aria-pressed',String(selected));
  });
  document.documentElement.style.setProperty('--accent',SCENES[scene].color);
  $$('.module-preview').forEach(b=>b.classList.toggle('active',Number(b.dataset.scene)===scene));
  $('sceneDescription').textContent = SCENES[scene].description;
  $('sceneCode').textContent = `00${scene+1} / ${SCENES[scene].name}`;
  $('engineMode').textContent = ['GRANULAR CLOUD','DUAL ANALOG','HYBRID SHIMMER'][scene];
  $('screenMessage').textContent = SCENES[scene].tagline.toUpperCase();
  renderKnobs();
  send({type:'scene',scene});
  toast(`${SCENES[scene].name} scene loaded`);
}

function changeParam(index,value) {
  if (index === 7) {
    const val = Math.max(0, Math.min(127, Math.round(value)));
    $('master').value = Math.round(val / 127 * 100);
    $('masterValue').textContent = `${$('master').value}%`;
    send({type:'master',value:Number($('master').value)/100});
    updateKnobVisual(7,val);
    return;
  }
  params[index] = Math.max(0,Math.min(127,Math.round(value)));
  updateKnobVisual(index,params[index]);
  send({type:'param',index,value:params[index]});
}

function updateKnobVisual(index,value) {
  const knob = $(`knob-${index}`);
  if (knob) {
    const pct = value / 127;
    knob.style.setProperty('--arc',`${pct*270}deg`);
    knob.style.setProperty('--rotation',`${pct*270-135}deg`);
    knob.setAttribute('aria-valuenow',value);
    $(`knob-value-${index}`).textContent = `${value}`.padStart(3,'0');
  }
}
function renderKnobs() {
  const grid = $('knobGrid');
  grid.replaceChildren();
  const indexes = knobBank === 0 ? [0,1,2,3] : [4,5,6,7];
  indexes.forEach((index,physical) => {
    const name = index === 7 ? 'MASTER' : PARAM_NAMES[scene][index];
    const getValue = () => index === 7 ? Math.round(Number($('master').value) * 127 / 100) : params[index];
    const cell = document.createElement('div');
    cell.className = 'knob-cell';
    cell.innerHTML = `<div id="knob-${index}" class="knob" role="slider" tabindex="0" aria-label="${name}" aria-valuemin="0" aria-valuemax="127" aria-valuenow="${getValue()}"><div class="knob-track"></div><div class="knob-face"></div><div class="knob-indicator"></div><span class="knob-index">0${physical+1}</span></div><span class="knob-label">${name}</span><span class="knob-value" id="knob-value-${index}">000</span>`;
    grid.append(cell);
    const knob = cell.querySelector('.knob');
    let drag;
    knob.addEventListener('pointerdown',event => {
      if (event.button !== 0) return;
      event.preventDefault();
      drag = {y:event.clientY,x:event.clientX,value:getValue()};
      knob.setPointerCapture(event.pointerId);
      knob.focus();
    });
    knob.addEventListener('pointermove',event => {
      if (!drag) return;
      changeParam(index,drag.value+(drag.y-event.clientY)*0.65+(event.clientX-drag.x)*0.30);
    });
    knob.addEventListener('pointerup',()=>{drag=null;});
    knob.addEventListener('pointercancel',()=>{drag=null;});
    knob.addEventListener('lostpointercapture',()=>{drag=null;});
    knob.addEventListener('wheel',event => {
      event.preventDefault();
      changeParam(index,getValue()+(event.deltaY<0?1:-1)*(event.shiftKey?8:2));
    },{passive:false});
    knob.addEventListener('keydown',event => {
      let delta=0;
      if (event.key==='ArrowUp'||event.key==='ArrowRight') delta=1;
      if (event.key==='ArrowDown'||event.key==='ArrowLeft') delta=-1;
      if (event.key==='PageUp') delta=10;
      if (event.key==='PageDown') delta=-10;
      if (event.key==='Home') {changeParam(index,0);event.preventDefault();}
      if (event.key==='End') {changeParam(index,127);event.preventDefault();}
      if (delta) {changeParam(index,getValue()+delta);event.preventDefault();}
    });
    updateKnobVisual(index,getValue());
  });
}
function setBank(value) {
  knobBank = value === 1 ? 1 : 0;
  $$('[data-bank]').forEach(button => {
    const selected = Number(button.dataset.bank) === knobBank;
    button.classList.toggle('selected',selected);
    button.setAttribute('aria-pressed',String(selected));
  });
  renderKnobs();
}

function midiNote(relative) { return 60 + 12*octave + relative; }
function lightKey(relative,pressed) {
  $$('.piano-key').filter(key => Number(key.dataset.relative)===relative).forEach(key => key.classList.toggle('pressed',pressed));
}
async function noteOn(relative,origin,velocity=105) {
  const note = midiNote(relative);
  const key = `${origin}`;
  if (activeNotes.has(key)) return;
  activeNotes.add(key);
  lightKey(relative,true);
  try {
    await enableAudio();
    if (activeNotes.has(key)) send({type:'noteOn',note,velocity});
  } catch { /* The audio button reports the failure. */ }
}
function noteOff(relative,origin) {
  const key = `${origin}`;
  if (!activeNotes.delete(key)) return;
  lightKey(relative,false);
  send({type:'noteOff',note:midiNote(relative)});
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
  $('holdButton').classList.toggle('active',hold);
  $('holdButton').textContent=hold?'HOLD ON':'HOLD';
  $('holdButton').setAttribute('aria-pressed',String(hold));
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
  releaseControls();
  hold=false;
  $('holdButton').classList.remove('active');
  $('holdButton').setAttribute('aria-pressed','false');
  $('holdButton').textContent='HOLD';
  send({type:'panic'});
  toast('All notes and effect tails cleared');
}

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
  a.download=`afterglow-v0.4-${new Date().toISOString().replace(/[:.]/g,'-')}.wav`;
  document.body.append(a);a.click();a.remove();
  setTimeout(()=>URL.revokeObjectURL(url),60000);
  toast(`Saved ${Math.round(recordFrames/sampleRate)} seconds of stereo WAV`);
  recordChunks=[];recordFrames=0;
}

async function connectMIDI() {
  if(!navigator.requestMIDIAccess) {toast('Web MIDI needs Chrome or Edge over HTTPS');return;}
  try {
    await enableAudio();
    midiAccess=await navigator.requestMIDIAccess({sysex:false});
    const attach=()=>{
      let total=0;
      midiAccess.inputs.forEach(input=>{
        input.onmidimessage=event=>{
          const [status,note,velocity]=event.data;
          const type=status&0xf0;
          if(type===0x90&&velocity>0)send({type:'noteOn',note,velocity});
          else if(type===0x80||(type===0x90&&velocity===0))send({type:'noteOff',note});
        };
        total++;
      });
      $('midiButton').textContent=total?`MIDI ${total}`:'MIDI';
      toast(total?`${total} MIDI input${total===1?'':'s'} ready`:'MIDI permitted; no keyboard detected');
    };
    midiAccess.onstatechange=attach;
    attach();
  } catch(error) {console.warn(error);toast('MIDI access unavailable or denied');}
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

function bindUI() {
  $('audioButton').addEventListener('click',enableAudio);
  $$('[data-scene]').forEach(button=>button.addEventListener('click',()=>setScene(Number(button.dataset.scene))));
  $$('[data-bank]').forEach(button=>button.addEventListener('click',()=>setBank(Number(button.dataset.bank))));
  $('resetButton').addEventListener('click',()=>setScene(scene));
  $('saveButton').addEventListener('click',()=>{
    try {localStorage.setItem(STORAGE_KEY,JSON.stringify({scene,params}));toast('Patch saved in this browser');}
    catch {toast('Browser storage is unavailable');}
  });
  $('loadButton').addEventListener('click',()=>{
    try {
      const data=JSON.parse(localStorage.getItem(STORAGE_KEY));
      if(!data||!Array.isArray(data.params)||data.params.length!==7||!Number.isInteger(data.scene)||data.scene<0||data.scene>2)throw Error('no saved patch');
      setScene(data.scene);
      data.params.forEach((value,index)=>changeParam(index,Number.isFinite(value)?value:0));
      toast('Saved patch loaded');
    } catch {toast('No saved patch in this browser');}
  });
  $('octaveDown').addEventListener('click',()=>setOctave(octave-1));
  $('octaveUp').addEventListener('click',()=>setOctave(octave+1));
  $('holdButton').addEventListener('click',toggleHold);
  $('panicButton').addEventListener('click',panic);
  ['bankEnv','bankLfo','bankEdit','bankHome','bankSeq'].forEach((id,i)=> $(id).addEventListener('click',()=>setBank(i%2)));
  $('master').addEventListener('input',event=>{
    const value=Number(event.target.value);
    $('masterValue').textContent=`${value}%`;
    updateKnobVisual(7,Math.round(value*127/100));
    send({type:'master',value:value/100});
  });
  $('recordButton').addEventListener('click',toggleRecording);
  $('midiButton').addEventListener('click',connectMIDI);
}

bindUI();
createKeyboard();
handleKeys();
setScene(0);
setBank(0);
requestAnimationFrame(animateScope);

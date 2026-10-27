/* SPDX-License-Identifier: GPL-3.0-only */
import assert from 'node:assert/strict';
import { AfterglowEngine, SCENES } from './afterglow-engine.mjs';

const render = (engine, frames) => {
  const l = new Float32Array(frames);
  const r = new Float32Array(frames);
  engine.render(l, r);
  for (const n of [...l, ...r]) assert.ok(Number.isFinite(n) && Math.abs(n) <= 1, 'bounded finite output');
  const energy = l.reduce((s, n) => s + n * n, 0) / frames;
  return { energy, l, r };
};

for (let scene = 0; scene < 3; scene++) {
  const engine = new AfterglowEngine(44100);
  engine.setScene(scene);
  assert.deepEqual(engine.params, SCENES[scene].params);
  [48, 52, 55, 59].forEach(note => engine.noteOn(note));
  const first = render(engine, 16384);
  assert.ok(first.energy > 0.0000001, `${SCENES[scene].name} audible`);
  engine.setParam(3, 127);
  engine.setParam(4, 127);
  render(engine, 16384);
  engine.allNotesOff();
  render(engine, 16384);
  engine.panic();
  assert.ok(engine.voices.every(v => !v.held && v.level === 0));
  console.log(`${SCENES[scene].name}: pass; RMS ${(Math.sqrt(first.energy)).toFixed(4)}`);
}

// Verify sample-rate adaptation, voice stealing, and note-release behavior.
const engine48 = new AfterglowEngine(48000);
for (let note = 48; note < 70; note++) engine48.noteOn(note, 110);
assert.equal(engine48.voices.filter(v => v.held).length, 4);
render(engine48, 32768);
engine48.setHold(true);
engine48.noteOff(69);
assert.ok(engine48.voices.some(v => v.held && v.note === 69));
engine48.setHold(false);
assert.ok(engine48.voices.every(v => !v.held));
console.log('48 kHz, voice stealing, hold, release: pass');

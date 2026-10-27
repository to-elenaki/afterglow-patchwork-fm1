/* SPDX-License-Identifier: GPL-3.0-only */
import { AfterglowEngine } from './afterglow-engine.mjs';

class AfterglowProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.engine = new AfterglowEngine(sampleRate);
    this.count = 0;
    this.recording = false;
    this.recordBuffer = new Float32Array(8192);
    this.recordWrite = 0;
    this.port.onmessage = ({ data }) => {
      switch (data.type) {
        case 'noteOn': this.engine.noteOn(data.note, data.velocity); break;
        case 'noteOff': this.engine.noteOff(data.note); break;
        case 'transportOff': this.engine.noteOff(data.note, true); break;
        case 'scene': this.engine.setScene(data.scene); break;
        case 'param': this.engine.setParam(data.index, data.value); break;
        case 'extra': this.engine.setExtra(data.name, data.value); break;
        case 'master': this.engine.master = Math.max(0, Math.min(1, data.value)); break;
        case 'hold': this.engine.setHold(data.value); break;
        case 'panic': this.engine.panic(); break;
        case 'recordStart': this.recording = true; this.recordWrite = 0; break;
        case 'recordStop':
          this.flushRecording();
          this.recording = false;
          this.port.postMessage({ type: 'recordDone' });
          break;
      }
    };
    this.port.postMessage({ type: 'ready', sampleRate });
  }

  flushRecording() {
    if (!this.recordWrite) return;
    const chunk = this.recordBuffer.slice(0, this.recordWrite);
    this.port.postMessage({ type: 'recordChunk', samples: chunk }, [chunk.buffer]);
    this.recordWrite = 0;
  }

  process(_inputs, outputs) {
    const output = outputs[0];
    if (!output || !output[0]) return true;
    const left = output[0];
    const right = output[1] || output[0];
    this.engine.render(left, right);
    if (this.recording) {
      for (let i = 0; i < left.length; i++) {
        this.recordBuffer[this.recordWrite++] = left[i];
        this.recordBuffer[this.recordWrite++] = right[i];
        if (this.recordWrite >= this.recordBuffer.length) this.flushRecording();
      }
    }
    if (++this.count % 16 === 0) {
      const scope = new Float32Array(64);
      let peak = 0;
      for (let i = 0; i < 64; i++) {
        scope[i] = (left[i * 2] + right[i * 2]) / 2;
        peak = Math.max(peak, Math.abs(scope[i]));
      }
      this.port.postMessage({ type: 'scope', samples: scope, peak }, [scope.buffer]);
    }
    return true;
  }
}

registerProcessor('afterglow-v03', AfterglowProcessor);

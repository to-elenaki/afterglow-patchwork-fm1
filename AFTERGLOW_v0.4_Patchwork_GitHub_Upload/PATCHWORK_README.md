# AFTERGLOW — FM-1 Patchwork Interface

Status: ready-to-deploy source package, **not deployed to the existing ChatGPT-hosted site**.

## What changed
- Replaced the desktop dashboard with a compact, FM-1-inspired horizontal chassis and centered square display.
- Added a 27-pad keyboard with mouse, Mac keyboard, and existing MIDI note input support.
- Split seven engine parameters into two right-hand knob banks, with master volume as the fourth knob in Bank B.
- Kept NEBULA, BLOOM and HORIZON scene selection.
- Preserved the original browser sound engine, AudioWorklet/compatibility fallback, hold, octave, panic, save/load, WAV recording, and Web MIDI support.
- Responsive mobile layout.

## Run locally on a Mac
From this folder, run `python3 -m http.server 8000` then open http://localhost:8000 in Chrome.
Click ENABLE AUDIO to start sound. The audio worklet requires localhost or HTTPS (a secure context).

## Deploy
Upload the contents of **this `web` directory** to the existing site's static web root. Replace its index.html, style.css, and app.mjs, and include the audio engine and worklet modules unchanged. Back up the currently published version first. The destination site was *not* modified in this process.

## Testing performed
`node web/test-engine.mjs`: all three scenes and voice/hold/48k tests passed. JavaScript syntax check passed. Automated browser interaction could not run in the editing environment due to browser navigation restrictions; test UI/audio/MIDI/recording on the published HTTPS site before considering release validated.

Firmware files remain unchanged. This is a browser UI redesign, not an FM-1 flashable firmware update.

import React from 'react';
import { renderToString } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { createServer } from 'vite';
const vite = await createServer({ root: process.cwd(), server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' });
const stages = ['ready', 'boot', 'greet', 'speaking', 'listening', 'thinking', 'gate', 'summary', 'done'];
let failed = false;
try {
  const { default: SpeakingLive } = await vite.ssrLoadModule('/src/components/speaking/SpeakingLive.jsx');
  const { default: SpeakingView } = await vite.ssrLoadModule('/src/views/SpeakingView.jsx');
  try { renderToString(React.createElement(MemoryRouter, null, React.createElement(SpeakingView))); console.log('SpeakingView: OK'); }
  catch (err) { failed = true; console.error('SpeakingView: CRASHED:', (err.stack || err.message).split('\n').slice(0, 4).join('\n')); }
  for (const s of stages) {
    try {
      const html = renderToString(React.createElement(MemoryRouter, null, React.createElement(SpeakingLive, { phase: 'practice', target: 6.5, initialStage: s })));
      console.log('stage ' + s + ': OK (' + html.length + ' chars)');
    } catch (err) { failed = true; console.error('stage ' + s + ': CRASHED:', (err.stack || err.message).split('\n').slice(0, 4).join('\n')); }
  }
} finally { await vite.close(); }
if (failed) process.exitCode = 1;

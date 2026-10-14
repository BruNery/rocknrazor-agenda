import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync, cpSync } from 'node:fs';
const r = await build({ entryPoints: ['src/main.ts'], bundle: true, minify: true, format: 'iife', target: 'es2020', write: false });
const js = r.outputFiles[0].text.replace(/<\/script/g, '<\\/script');
const css = readFileSync('src/style.css', 'utf8');
const html = `<title>Agenda Rock n' Razor</title>
<meta name="claude:viewport-fit-sides" content="cover">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Instrument+Sans:wght@400;500;600;700&family=Rye&display=swap">
<style>${css}</style>
<div id="app"></div>
<div id="booking" hidden></div>
<script>${js}</script>
`;
mkdirSync('dist', { recursive: true }); writeFileSync('dist/index.html', html); console.log('dist/index.html', html.length, 'bytes');

// Versão instalável (alojada em HTTPS): mesma app + manifesto, ícones, service worker. RR_API="" = API no mesmo endereço.
const api = process.env.RR_API;
const pwa = `<!doctype html><html lang="pt-PT"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#0A0605"><link rel="manifest" href="manifest.webmanifest"><link rel="apple-touch-icon" href="icons/apple-touch-icon.png">
${api === undefined ? '' : `<script>window.RR_API=${JSON.stringify(api)}</script>`}
${html.replace('<meta name="claude:viewport-fit-sides" content="cover">\n', '')}</html>`;
mkdirSync('dist/pwa', { recursive: true }); writeFileSync('dist/pwa/index.html', pwa);
cpSync('pwa', 'dist/pwa', { recursive: true }); console.log('dist/pwa pronto');

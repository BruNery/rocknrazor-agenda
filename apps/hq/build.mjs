import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
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

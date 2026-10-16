import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync, cpSync } from 'node:fs';
const r = await build({ entryPoints: ['src/main.ts'], bundle: true, minify: true, format: 'iife', target: 'es2020', write: false });
const js = r.outputFiles[0].text.replace(/<\/script/g, '<\\/script');
const css = readFileSync('src/style.css', 'utf8');
// Caminhos relativos: a mesma app serve em marcar.rockandrazor.com/ e em /marcar/ (para testar antes do domínio).
const html = `<!doctype html><html lang="pt-PT"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Marcar · Rock n' Razor</title><meta name="theme-color" content="#0A0605"><meta name="description" content="Marca o teu corte na barbearia Rock n' Razor.">
<link rel="manifest" href="manifest.webmanifest"><link rel="icon" href="icons/icon-192.png"><link rel="apple-touch-icon" href="icons/apple-touch-icon.png">
<meta name="apple-mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-title" content="Rock n' Razor">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Instrument+Sans:wght@400;500;600;700&family=Rye&display=swap">
<style>${css}</style>
<div id="app"></div>
<script>${js}</script></html>
`;
mkdirSync('dist', { recursive: true }); writeFileSync('dist/index.html', html);
cpSync('pwa', 'dist', { recursive: true }); cpSync('../hq/pwa/icons', 'dist/icons', { recursive: true });
console.log('dist/ pronto', html.length, 'bytes');

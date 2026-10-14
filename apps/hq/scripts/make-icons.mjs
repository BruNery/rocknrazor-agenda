// Gera os ícones da app (monograma original "RR" dourado sobre preto quente). Corre com: node scripts/make-icons.mjs
import { chromium } from 'playwright-core';
const gold = '#D7B86D', black = '#0A0605';
const svg = (size, { pad, bg, fg }) => `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 100 100">${bg ? `<rect width="100" height="100" fill="${bg}"/>` : ''}<g transform="translate(50 50) scale(${1 - pad * 2}) translate(-50 -50)"><circle cx="50" cy="50" r="40" fill="none" stroke="${fg}" stroke-width="3"/><text x="50" y="62" text-anchor="middle" font-family="Georgia, 'Times New Roman', serif" font-weight="700" font-size="38" fill="${fg}" letter-spacing="-1">RR</text></g></svg>`;
const out = [['icon-192.png', 192, { pad: .08, bg: black, fg: gold }], ['icon-512.png', 512, { pad: .08, bg: black, fg: gold }], ['maskable-512.png', 512, { pad: .22, bg: black, fg: gold }], ['apple-touch-icon.png', 180, { pad: .08, bg: black, fg: gold }], ['badge.png', 96, { pad: .04, bg: null, fg: '#FFFFFF' }]];
const b = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/opt/pw-browsers/chromium', args: ['--no-sandbox'] });
for (const [name, size, o] of out) { const p = await b.newPage({ viewport: { width: size, height: size } }); await p.setContent(`<body style="margin:0;background:transparent">${svg(size, o)}</body>`); await p.screenshot({ path: `pwa/icons/${name}`, omitBackground: !o.bg }); await p.close(); }
await b.close(); console.log('ícones gerados');

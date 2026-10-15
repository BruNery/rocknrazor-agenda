// Junta o servidor e o CLI em ficheiros únicos (o domínio vai dentro; as bibliotecas de npm ficam de fora).
import { build } from 'esbuild';
await build({
  entryPoints: { server: 'src/server.ts', cli: 'src/cli.ts' }, outdir: 'dist', outExtension: { '.js': '.mjs' },
  bundle: true, platform: 'node', format: 'esm', target: 'node22', sourcemap: true,
  external: ['pg', 'fastify', 'web-push', 'zod', 'pg-native'],
});
console.log('apps/api/dist pronto');

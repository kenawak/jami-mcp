import { defineConfig } from 'tsup';

export default defineConfig({
	// `index` is the CLI (stdio / HTTP); `server` is the embeddable factory.
	entry: { index: 'src/index.ts', server: 'src/server.ts' },
	format: ['esm'],
	dts: { entry: { server: 'src/server.ts' } },
	sourcemap: true,
	clean: true,
	target: 'node18'
});

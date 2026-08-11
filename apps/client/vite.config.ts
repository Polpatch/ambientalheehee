import { defineConfig } from 'vite';
const web = process.env.GITHUB_REPOSITORY ? `/${process.env.GITHUB_REPOSITORY.split('/')[1]}/` : '/';
export default defineConfig(({ mode }) => ({ base: mode === 'web' ? web : './', build: { outDir: `dist/${mode === 'web' ? 'web' : 'desktop'}`, emptyOutDir: true } }));

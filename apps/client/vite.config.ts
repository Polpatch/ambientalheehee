import { defineConfig } from 'vite';
const web = process.env.GITHUB_REPOSITORY ? `/${process.env.GITHUB_REPOSITORY.split('/')[1]}/` : '/';
export default defineConfig(({ mode }) => ({ base: mode === 'web' ? web : './', plugins: [{ name: 'pages-preview-base', configurePreviewServer(server) { return () => server.middlewares.use((request, _response, next) => { if (web !== '/' && request.url?.startsWith(web)) request.url = request.url.slice(web.length - 1) || '/'; next(); }); } }], build: { outDir: `dist/${mode === 'web' ? 'web' : 'desktop'}`, emptyOutDir: true } }));

import { defineConfig } from 'vite';

function normalizeBase(value: string | undefined) {
  if (!value || value === '/') return '/';
  return `/${value.replace(/^\/+|\/+$/g, '')}/`;
}

const repository = process.env.GITHUB_REPOSITORY?.split('/')[1];
const webBase = normalizeBase(process.env.VITE_BASE_PATH ?? (repository ? `/${repository}/` : '/'));

export default defineConfig(({ mode }) => ({
  base: mode === 'web' ? webBase : './',
  plugins: [{
    name: 'pages-preview-base',
    configurePreviewServer(server) {
      return () => server.middlewares.use((request, _response, next) => {
        if (webBase !== '/' && request.url?.startsWith(webBase)) request.url = request.url.slice(webBase.length - 1) || '/';
        next();
      });
    },
  }],
  build: {
    outDir: `dist/${mode === 'web' ? 'web' : 'desktop'}`,
    emptyOutDir: true,
  },
}));

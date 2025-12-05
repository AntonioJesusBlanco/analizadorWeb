import { defineConfig } from 'astro/config';

export default defineConfig({
  output: 'static', // <- importante
  adapter: undefined, // no uses ningún adapter
});
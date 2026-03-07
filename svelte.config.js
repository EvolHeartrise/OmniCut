import adapter from 'svelte-adapter-bun';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	kit: {
		adapter: adapter(),
		experimental: {
			remoteFunctions: true
		}
	},
	compilerOptions: {
		experimental: {
			async: true
		},
		warningFilter: (warning) =>
			!warning.code.startsWith('a11y') && warning.code !== 'state_referenced_locally'
	}
};

export default config;

// Text files embedded at build time (import x from "./file.md" with { type: "text" }).
declare module "*.md" {
	const text: string;
	export default text;
}

// Files embedded at build time as a path (import x from "./file.wasm" with { type: "file" }).
declare module "*.wasm" {
	const path: string;
	export default path;
}

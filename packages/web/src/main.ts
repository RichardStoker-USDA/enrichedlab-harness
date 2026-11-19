import { mount } from "svelte";
import App from "./App.svelte";
import "./styles/app.css";

const root = document.getElementById("app")!;
const runRoute = location.pathname.match(/^\/runs\/([A-Za-z0-9][A-Za-z0-9._-]{0,159})\/?$/);
if (runRoute) {
	const { default: RunView } = await import("./run/RunView.svelte");
	mount(RunView, { target: root, props: { id: runRoute[1] } });
} else if (/^\/runs\/?$/.test(location.pathname)) {
	const { default: RunList } = await import("./run/RunList.svelte");
	mount(RunList, { target: root });
} else {
	mount(App, { target: root });
}

// A box that clips its content never scrolls. focus() or scrollIntoView() on something inside a box with
// overflow: hidden can still move it, and moving the window's frame slides the whole interface out of view. Put any
// such box back at once; real scrollers (overflow: auto) are left alone.
document.addEventListener(
	"scroll",
	(event) => {
		const box = event.target === document ? document.documentElement : event.target;
		if (!(box instanceof HTMLElement) || (!box.scrollTop && !box.scrollLeft)) return;
		const style = getComputedStyle(box);
		const fixed = (axis: string) => box === document.documentElement || box === document.body || axis === "hidden" || axis === "clip";
		if (box.scrollTop && fixed(style.overflowY)) box.scrollTop = 0;
		if (box.scrollLeft && fixed(style.overflowX)) box.scrollLeft = 0;
	},
	{ capture: true, passive: true },
);

// The macOS app reads pages with the same script as the desktop app (apps/desktop/src/page_script.mjs): its copy in
// the Swift package's resources must stay identical, so both windows number a page's controls the same way.

import { expect, test } from "bun:test";
import { join } from "node:path";
import { SNAPSHOT } from "../apps/desktop/src/page_script.mjs";

test("the macOS app's page script matches the desktop app's", async () => {
	const copy = await Bun.file(join(import.meta.dir, "..", "apps/macos/Sources/EnrichedLabUI/Resources/page_snapshot.js")).text();
	expect(copy.replaceAll("\r\n", "\n").trim()).toBe(SNAPSHOT.trim());
});

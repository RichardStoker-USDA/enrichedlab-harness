/** Loopback campaign recording for the run view. All payloads describe this fixture's files. */
import { createHash } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { createServer as createVite } from "vite";
import { z } from "zod";
import { eventSchema } from "../src/run/contract.ts";

const id = "reference-package";
const base = "/v1/runs/" + id;
const port = Number(process.env.RUN_VIEW_PORT ?? 5186);
const origin = "http://127.0.0.1:" + port;
const objective = "Verify that the reference package can be rerun from its recorded inputs.";
const hash = (data: Uint8Array | string) => createHash("sha256").update(data).digest("hex");
const files = new Map<string, Buffer>();
function artifact(name: string, mime: string, data: Buffer) {
	const sha256 = hash(data), uri = "/v1/artifacts/" + sha256 + "/" + name;
	files.set(uri, data);
	return { name, mime, uri, sha256, bytes:data.length };
}
const table = artifact("manifest.tsv", "text/tab-separated-values", Buffer.from("File\tVerification\nrecipe.json\tPresent\nmanifest.tsv\tPresent\n"));
const bundle = artifact("reference.json.gz", "application/gzip", gzipSync(Buffer.from(JSON.stringify({schema:1, purpose:"interface qualification", table}))));
const run = { id, session:id, title:"Reference package verification", status:"running",
	"x-campaign":"recorded-reference", "x-steering":{ messages:true, stop:true, budget:{path:base+"/budget",unit:"minutes"} } };
const log: z.infer<typeof eventSchema>[] = [];
const listeners = new Set<ServerResponse>();
function append(kind: string, data: Record<string, unknown>, time = new Date().toISOString()) {
	const e = eventSchema.parse({v:1, seq:log.length+1, time, kind, data});
	log.push(e);
	for (const listener of listeners) listener.write(`id: ${e.seq}\ndata: ${JSON.stringify(e)}\n\n`);
}
append("user",{text:objective},"2026-11-18T08:00:00Z");
append("x-campaign-event",{type:"budget.changed",minutes:45},"2026-11-18T08:01:00Z");
append("x-campaign-event",{type:"delivery.published",n:1,milestone:"Source manifest",receipt:hash(table.sha256),artifacts:[table]},"2026-11-18T08:12:00Z");
append("x-campaign-event",{type:"delivery.published",n:2,milestone:"Rerun package",note:"The package contains the reference manifest and its digest.",receipt:hash(bundle.sha256),artifacts:[table,bundle]},"2026-11-18T08:26:00Z");
append("x-campaign-event",{type:"milestone.revised",milestone:"Check the package on a clean workspace."},"2026-11-18T08:27:00Z");
const root = fileURLToPath(new URL("..",import.meta.url));
const vite = await createVite({ root, server:{middlewareMode:true, hmr:false}, appType:"spa" });
const http = createServer(async (req, res) => {
	const url = new URL(req.url ?? "/", origin);
	function json(value: unknown, status=200) { res.writeHead(status,{"Content-Type":"application/json","Cache-Control":"no-store"}); res.end(JSON.stringify(value)); }
	if (req.headers.host !== "127.0.0.1:"+port) { json({},403); return; }
	if (!url.pathname.startsWith("/v1/")) { vite.middlewares(req,res); return; }
	if (req.method === "GET") {
		if (url.pathname === "/v1/runs") return json({runs:[run],next:null});
		if (url.pathname === base) return json(run);
		if (url.pathname === base+"/log") return json(log);
		if (url.pathname === base+"/events") {
			res.writeHead(200,{"Content-Type":"text/event-stream","Cache-Control":"no-store"});
			const cursor=Number(req.headers["last-event-id"] ?? 0);
			for (const e of log.slice(cursor)) res.write(`id: ${e.seq}\ndata: ${JSON.stringify(e)}\n\n`);
			listeners.add(res); res.on("close",()=>listeners.delete(res)); return;
		}
		const file=files.get(url.pathname);
		if (file) {res.writeHead(200,{"Content-Type":"application/octet-stream","Content-Length":file.length});res.end(file);return;}
	}
	if (req.method === "POST" && req.headers.origin===origin && req.headers["content-type"]==="application/json") {
		try {
			let body="";
			for await (const chunk of req) { body+=chunk; if (body.length>8192) return json({},413); }
			const data=JSON.parse(body);
			if(url.pathname===base+"/messages") append("x-campaign-event",{type:"feedback.received",text:z.string().min(1).max(2000).parse(data.text)});
			else if(url.pathname===base+"/budget") append("x-campaign-event",{type:"budget.changed",minutes:z.number().int().positive().parse(data.minutes)});
			else if(url.pathname===base+"/stop") append("x-campaign-event",{type:"stop.requested"});
			else return json({},404);
			return json({},202);
		} catch { return json({},400); }
	}
	json({},404);
});
http.listen(port,"127.0.0.1",()=>console.info(origin+"/runs/"+id));

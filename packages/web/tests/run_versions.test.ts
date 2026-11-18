import { expect, test } from "bun:test";
import { budgetPath, eventSchema, project, readDeliveryView, readRunSnapshot, runPage, runSchema } from "../src/run/contract.ts";
const run = runSchema.parse({id:"test",session:"test",status:"running",title:"Fixture"});
const event = (seq: number, type: string, more: object={}) => eventSchema.parse({
	v:1,seq,time:"2026-11-18T08:00:00Z",kind:"x-campaign-event",data:{type,...more},
});
const delivered = {milestone:"Manifest",receipt:"a".repeat(64),artifacts:[]};
test("a terminal summary is followed by a fresh log with its last delivery", async () => {
	const requested: string[] = [];
	let finish!: () => void;
	const committed = new Promise<void>(resolve => { finish = resolve; });
	const log: ReturnType<typeof event>[] = [];
	const read = async (path: string) => {
		requested.push(path);
		if (path.endsWith("/log")) return Response.json(log);
		await committed;
		return Response.json({...run, status:"finished"});
	};
	const pending = readRunSnapshot(run.id, {}, read);
	expect(requested).toEqual(["/v1/runs/test"]);
	log.push(event(1, "delivery.published", {...delivered,n:1}));
	finish();
	const snapshot = await pending;
	expect(project(snapshot.summary, snapshot.entries).versions.map(v => v.n)).toEqual([1]);
	expect(requested).toEqual(["/v1/runs/test","/v1/runs/test/log"]);
});
test("the site and broker run lists keep the returned cursor", () => {
	expect(runPage.parse({ data:[run] })).toEqual({ runs:[run],next:null });
	expect(runPage.parse({ runs:[run],next:"after" })).toEqual({ runs:[run],next:"after" });
	expect(runPage.safeParse({ data:[{id:"missing"}] }).success).toBe(false);
});
test("an invalid final delivery never produces a terminal view", async () => {
	const corrupt = [event(1,"delivery.published",{...delivered,n:1}),event(2,"delivery.published",{...delivered,n:1})];
	const summary = runSchema.parse({...run,status:"finished"});
	await expect(readDeliveryView(summary, {}, async () => Response.json(corrupt))).rejects.toThrow("Two publications");
	const fixed = await readDeliveryView(summary, {}, async () => Response.json(corrupt.slice(0,1)));
	expect(fixed.view.versions.map(v => v.n)).toEqual([1]);
});
test("ordered versions and person steering are reconstructed from the log", () => {
	const actual=project(run,[event(1,"delivery.published",{...delivered,n:1}),event(2,"delivery.published",{...delivered,n:2}),
		event(3,"feedback.received",{text:"Check the manifest"}),event(4,"budget.changed",{minutes:30}),event(5,"stop.requested")]);
	expect(actual.versions.map(v=>v.n)).toEqual([2,1]);
	expect(actual.activity.at(-1)?.text).toBe("Check the manifest");
	expect(actual.minutes).toBe(30); expect(actual.stopping).toBe(true);
});
test("gaps and conflicting version numbers refuse the projection",()=>{
	expect(()=>project(run,[event(2,"stop.requested")])).toThrow();
	expect(()=>project(run,[event(1,"delivery.published",{...delivered,n:1}),event(2,"delivery.published",{...delivered,n:1})])).toThrow();
});
test("budget changes are bound to the selected run's advertised writer",()=>{
	expect(budgetPath(run)).toBeUndefined();
	for (const path of ["https://outside.example/a","/v1/runs/other/budget","/admin"]) {
		expect(budgetPath({...run,"x-steering":{budget:{unit:"minutes",path}}})).toBeUndefined();
	}
	expect(budgetPath({...run,"x-steering":{budget:{unit:"minutes",path:"/v1/runs/test/budget"}}})).toBe("/v1/runs/test/budget");
});

import { expect, test } from "bun:test";
import { budgetPath, eventSchema, project, runSchema } from "../src/run/contract.ts";
const run = runSchema.parse({id:"test",session:"test",status:"running",title:"Fixture"});
const event = (seq: number, type: string, more: object={}) => eventSchema.parse({
	v:1,seq,time:"2026-11-18T08:00:00Z",kind:"x-campaign-event",data:{type,...more},
});
const delivered = {milestone:"Manifest",receipt:"a".repeat(64),artifacts:[]};
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

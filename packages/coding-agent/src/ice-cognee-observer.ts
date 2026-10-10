import { appendFile, chmod, mkdir, readFile, rename, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import { redactMemoryText } from "./ice-cognee.ts";

export const COGNEE_OBSERVATION_FILE = "observations.jsonl";
const MAX_EVENTS = 500;
const MAX_PREVIEW_CHARS = 900;
/** The log rotates to a single `.1` generation past this size, so it never grows without bound. */
export const MAX_OBSERVATION_FILE_BYTES = 2 * 1024 * 1024;
const POLL_MS = 350;

export type CogneeObservationOperation =
	| "session"
	| "recall"
	| "remember_entry"
	| "remember"
	| "trace"
	| "improve"
	| "queue";
export type CogneeObservationPhase = "started" | "queued" | "succeeded" | "failed";

export interface CogneeObservation {
	id: string;
	at: string;
	agentId?: string;
	sessionId?: string;
	dataset?: string;
	endpoint?: string;
	operation: CogneeObservationOperation;
	phase: CogneeObservationPhase;
	requestId?: string;
	latencyMs?: number;
	statusCode?: number;
	preview?: string;
	error?: string;
	meta?: Record<string, string | number | boolean | null>;
}

export interface CogneeObserverHandle {
	url: string;
	close(): Promise<void>;
}

export interface CogneeObserverOptions {
	storageDir: string;
	host?: string;
	port?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isObservation(value: unknown): value is CogneeObservation {
	return (
		isRecord(value) &&
		typeof value.id === "string" &&
		typeof value.at === "string" &&
		typeof value.operation === "string" &&
		typeof value.phase === "string"
	);
}

function observationPath(storageDir: string): string {
	return join(storageDir, COGNEE_OBSERVATION_FILE);
}

export async function appendCogneeObservation(storageDir: string, observation: CogneeObservation): Promise<void> {
	const safe = {
		...observation,
		preview: observation.preview === undefined ? undefined : redactMemoryText(observation.preview, MAX_PREVIEW_CHARS),
	};
	try {
		await mkdir(storageDir, { recursive: true, mode: 0o700 });
		const path = observationPath(storageDir);
		await appendFile(path, `${JSON.stringify(safe)}\n`, { encoding: "utf8", mode: 0o600 });
		await chmod(path, 0o600);
		if ((await stat(path)).size > MAX_OBSERVATION_FILE_BYTES) await rename(path, `${path}.1`);
	} catch {
		// Observation must never affect the Ice loop.
	}
}

export async function readCogneeObservations(storageDir: string): Promise<CogneeObservation[]> {
	const readLines = async (path: string): Promise<string[]> => {
		try {
			return (await readFile(path, "utf8")).split("\n").filter((line) => line.length > 0);
		} catch {
			return [];
		}
	};
	const path = observationPath(storageDir);
	let lines = await readLines(path);
	// Right after a rotation the live file is short; fill the view from the previous generation.
	if (lines.length < MAX_EVENTS) lines = [...(await readLines(`${path}.1`)), ...lines];
	const events: CogneeObservation[] = [];
	for (const line of lines.slice(-MAX_EVENTS)) {
		try {
			const parsed: unknown = JSON.parse(line);
			if (isObservation(parsed)) events.push(parsed);
		} catch {
			// Ignore incomplete or corrupt lines while the observer stays live.
		}
	}
	return events;
}

function json(res: ServerResponse, body: unknown, status = 200): void {
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-store",
		"x-content-type-options": "nosniff",
	});
	res.end(JSON.stringify(body));
}

function servePage(res: ServerResponse): void {
	res.writeHead(200, {
		"content-type": "text/html; charset=utf-8",
		"cache-control": "no-store",
		"content-security-policy":
			"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'none'; base-uri 'none'; frame-ancestors 'none'",
		"x-content-type-options": "nosniff",
	});
	res.end(OBSERVER_HTML);
}

function requestPath(req: IncomingMessage): string {
	return new URL(req.url ?? "/", "http://127.0.0.1").pathname;
}

async function streamEvents(res: ServerResponse, storageDir: string): Promise<void> {
	res.writeHead(200, {
		"content-type": "text/event-stream; charset=utf-8",
		"cache-control": "no-cache, no-transform",
		connection: "keep-alive",
		"x-accel-buffering": "no",
	});
	let initialized = false;
	let lastId: string | undefined;
	const send = async (): Promise<void> => {
		const events = await readCogneeObservations(storageDir);
		if (!initialized) {
			initialized = true;
			lastId = events.at(-1)?.id;
			res.write(`event: snapshot\ndata: ${JSON.stringify({ events })}\n\n`);
			return;
		}
		const index = events.findIndex((event) => event.id === lastId);
		for (const event of index < 0 ? events : events.slice(index + 1)) {
			lastId = event.id;
			res.write(`event: observation\ndata: ${JSON.stringify(event)}\n\n`);
		}
	};
	await send();
	let closed = false;
	res.once("close", () => {
		closed = true;
	});
	const tick = async (): Promise<void> => {
		if (closed) return;
		await send().catch(() => {});
		if (!closed) setTimeout(() => void tick(), POLL_MS);
	};
	setTimeout(() => void tick(), POLL_MS);
}

export async function startCogneeObserver(options: CogneeObserverOptions): Promise<CogneeObserverHandle> {
	const host = options.host ?? "127.0.0.1";
	const sseResponses = new Set<ServerResponse>();
	const server: Server = createServer((req, res) => {
		if (req.method !== "GET") {
			json(res, { error: "method_not_allowed" }, 405);
			return;
		}
		const path = requestPath(req);
		if (path === "/") {
			servePage(res);
			return;
		}
		if (path === "/api/state") {
			void readCogneeObservations(options.storageDir).then((events) => json(res, { events }));
			return;
		}
		if (path === "/api/events") {
			sseResponses.add(res);
			res.once("close", () => sseResponses.delete(res));
			void streamEvents(res, options.storageDir).catch(() => res.destroy());
			return;
		}
		json(res, { error: "not_found" }, 404);
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(options.port ?? 0, host, () => {
			server.removeListener("error", reject);
			resolve();
		});
	});
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Cognee observer did not receive a TCP address");
	return {
		url: `http://${host}:${address.port}`,
		close: () =>
			new Promise<void>((resolve, reject) => {
				for (const response of sseResponses) response.end();
				server.close((error) => (error ? reject(error) : resolve()));
			}),
	};
}

const OBSERVER_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Cognee Signal Room</title>
<style>
:root{--ink:#192624;--muted:#70807a;--paper:#f2eee5;--deep:#e6dfd2;--panel:#fffdf7c2;--line:#19262422;--teal:#147d72;--teal-soft:#d6eee6;--amber:#d8872d;--amber-soft:#f5e0bf;--coral:#c95d4e;--shadow:0 22px 65px #242f2a1f}*{box-sizing:border-box}body{margin:0;color:var(--ink);background:radial-gradient(circle at 12% 5%,#d8872d2e,transparent 31rem),radial-gradient(circle at 88% 18%,#147d7224,transparent 28rem),linear-gradient(135deg,var(--paper),#ebe5d9);font-family:ui-monospace,"IBM Plex Mono","SFMono-Regular",monospace;min-height:100vh}body:before{content:"";position:fixed;inset:0;pointer-events:none;opacity:.22;background-image:linear-gradient(#1926240f 1px,transparent 1px),linear-gradient(90deg,#1926240f 1px,transparent 1px);background-size:34px 34px;mask-image:linear-gradient(to bottom,#000,transparent 88%)}main{max-width:1420px;margin:0 auto;padding:28px clamp(18px,4vw,64px) 70px;position:relative}.topline{display:flex;align-items:center;justify-content:space-between;gap:20px;border-bottom:1px solid var(--line);padding-bottom:18px}.brand{display:flex;align-items:center;gap:12px;font-size:11px;letter-spacing:.18em;text-transform:uppercase;font-weight:800}.mark{width:28px;height:28px;border-radius:8px 8px 8px 2px;background:var(--ink);position:relative;box-shadow:7px 7px 0 var(--amber)}.mark:after{content:"";position:absolute;width:7px;height:7px;background:var(--teal-soft);border-radius:50%;left:8px;top:8px;box-shadow:10px 0 0 var(--amber)}.live{display:inline-flex;align-items:center;gap:8px;font-size:11px;color:var(--teal);font-weight:800;letter-spacing:.1em;text-transform:uppercase}.dot{width:8px;height:8px;border-radius:50%;background:var(--teal);box-shadow:0 0 0 5px #147d7224;animation:breathe 1.8s ease-in-out infinite}@keyframes breathe{50%{transform:scale(.65);opacity:.58}}.hero{display:grid;grid-template-columns:minmax(0,1.4fr) minmax(280px,.6fr);gap:30px;padding:70px 0 42px;align-items:end}.kicker{color:var(--amber);font-size:11px;letter-spacing:.2em;text-transform:uppercase;font-weight:800;margin-bottom:16px}h1{font-family:Georgia,"Times New Roman",serif;font-weight:400;font-size:clamp(48px,8vw,104px);letter-spacing:-.07em;line-height:.88;max-width:800px;margin:0}h1 em{color:var(--teal);font-style:normal}.copy{max-width:380px;color:var(--muted);font-size:12px;line-height:1.8;border-left:2px solid var(--amber);padding-left:18px}.identity{display:grid;grid-template-columns:1.1fr 1.5fr .8fr .8fr;border:1px solid var(--line);background:var(--panel);box-shadow:var(--shadow);backdrop-filter:blur(12px)}.cell{padding:16px 18px;border-right:1px solid var(--line);min-width:0}.cell:last-child{border:0}.label{display:block;font-size:9px;letter-spacing:.16em;text-transform:uppercase;color:var(--muted);margin-bottom:8px}.value{font-size:12px;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.metrics{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-top:18px}.metric{padding:17px 18px;background:var(--ink);color:var(--paper);min-height:90px;position:relative;overflow:hidden}.metric:nth-child(2){background:var(--teal)}.metric:nth-child(3){background:var(--amber);color:var(--ink)}.metric:nth-child(4){background:var(--deep);color:var(--ink)}.metric-label{font-size:9px;text-transform:uppercase;letter-spacing:.13em;opacity:.7}.metric-value{font-family:Georgia,serif;font-size:33px;margin-top:8px}.dashboard{display:grid;grid-template-columns:minmax(0,1.35fr) minmax(300px,.65fr);gap:18px;margin-top:18px}.panel{border:1px solid var(--line);background:var(--panel);box-shadow:var(--shadow);backdrop-filter:blur(12px)}.head{display:flex;align-items:baseline;justify-content:space-between;gap:12px;padding:18px 20px;border-bottom:1px solid var(--line)}.title{font-family:Georgia,"Times New Roman",serif;font-size:22px}.meta{color:var(--muted);font-size:10px}.events{min-height:430px;max-height:620px;overflow:auto;padding:8px}.event{display:grid;grid-template-columns:78px 10px minmax(0,1fr) auto;gap:12px;align-items:start;padding:14px 12px;border-bottom:1px solid var(--line);cursor:pointer;transition:background .18s ease,transform .18s ease;animation:reveal .35s both}.event:hover,.event.selected{background:#147d7214;transform:translateX(4px)}@keyframes reveal{from{opacity:0;transform:translateY(5px)}to{opacity:1;transform:translateY(0)}}.time{color:var(--muted);font-size:10px}.event-dot{width:9px;height:9px;margin-top:3px;border-radius:50%;background:var(--muted)}.event-dot.succeeded{background:var(--teal)}.event-dot.started,.event-dot.queued{background:var(--amber);animation:breathe 1.2s infinite}.event-dot.failed{background:var(--coral)}.event-main{min-width:0}.event-name{font-size:12px;font-weight:800}.sub{color:var(--muted);font-size:10px;margin-top:6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.badge{font-size:9px;text-transform:uppercase;letter-spacing:.1em;padding:5px 7px;border-radius:2px;background:var(--deep);color:var(--muted)}.badge.succeeded{background:var(--teal-soft);color:var(--teal)}.badge.failed{background:#f4d8d2;color:var(--coral)}.badge.started,.badge.queued{background:var(--amber-soft);color:#8a551d}.inspector{padding:22px;min-height:430px}.empty{color:var(--muted);font-size:12px;line-height:1.7;padding-top:35px}.detail-grid{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin:20px 0}.preview{background:#202b29;color:#d6eee6;padding:16px;font-size:11px;line-height:1.7;white-space:pre-wrap;overflow-wrap:anywhere;min-height:120px}.foot{display:flex;justify-content:space-between;gap:20px;color:var(--muted);font-size:10px;margin-top:18px}@media(max-width:900px){.hero,.dashboard{grid-template-columns:1fr}.identity{grid-template-columns:1fr 1fr}.cell:nth-child(2){border-right:0}.cell:nth-child(-n+2){border-bottom:1px solid var(--line)}}@media(max-width:560px){main{padding-inline:14px}.hero{padding-top:48px}h1{font-size:58px}.metrics{grid-template-columns:1fr 1fr}.event{grid-template-columns:58px 10px minmax(0,1fr)}.event .badge{grid-column:3;justify-self:start}.identity{grid-template-columns:1fr}.cell{border-right:0;border-bottom:1px solid var(--line)}.cell:last-child{border-bottom:0}}
</style>
</head>
<body><main>
<div class="topline"><div class="brand"><span class="mark"></span>Cognee / local observer</div><div class="live"><span class="dot"></span><span id="connection">Connecting</span></div></div>
<section class="hero"><div><div class="kicker">Realtime memory instrumentation</div><h1>Cognee<br><em>Signal Room</em></h1></div><p class="copy">A local window into what ICE sends, remembers, recalls, and improves. Redacted by default. No API keys leave this machine.</p></section>
<section class="identity"><div class="cell"><span class="label">Agent</span><span class="value" id="agent">--</span></div><div class="cell"><span class="label">Session</span><span class="value" id="session">--</span></div><div class="cell"><span class="label">Dataset</span><span class="value" id="dataset">--</span></div><div class="cell"><span class="label">Cognee endpoint</span><span class="value" id="endpoint">--</span></div></section>
<section class="metrics"><div class="metric"><div class="metric-label">Requests</div><div class="metric-value" id="requests">0</div></div><div class="metric"><div class="metric-label">Successful</div><div class="metric-value" id="success">0</div></div><div class="metric"><div class="metric-label">Ingested</div><div class="metric-value" id="ingested">0</div></div><div class="metric"><div class="metric-label">Failures</div><div class="metric-value" id="failures">0</div></div></section>
<section class="dashboard"><div class="panel"><div class="head"><span class="title">Event stream</span><span class="meta" id="stream-meta">waiting for signal</span></div><div class="events" id="event-list"><div class="empty">Waiting for the first Cognee request.<br>Send a prompt in <strong>ice</strong> and watch the pipeline appear here.</div></div></div><div class="panel"><div class="head"><span class="title">Ingest inspector</span><span class="meta" id="inspector-meta">select an event</span></div><div class="inspector" id="inspector"><div class="empty">Select an event to inspect its redacted payload preview, lifecycle, latency, agent identity, and request ID.</div></div></div></section>
<div class="foot"><span>LOCAL / LOOPBACK ONLY / REDACTED PREVIEWS</span><span id="updated">No events yet</span></div>
</main>
<script>
(function(){
var events=[],selected=null,names={session:"Session",recall:"Recall",remember_entry:"Remember entry",remember:"Durable remember",trace:"Tool trace",improve:"Improve",queue:"Queue"};
var $=function(id){return document.getElementById(id)},esc=function(v){return String(v==null?"":v).replace(/[&<>"']/g,function(c){return c==="&"?"&amp;":c==="<"?"&lt;":c===">"?"&gt;":c.charCodeAt(0)===34?"&quot;":"&#39;"})},latest=function(){return events.length?events[events.length-1]:null};
function show(event){if(!event){$("inspector").innerHTML='<div class="empty">Select an event to inspect its redacted payload preview, lifecycle, latency, agent identity, and request ID.</div>';$("inspector-meta").textContent="select an event";return}$("inspector-meta").textContent=names[event.operation]||event.operation;$("inspector").innerHTML='<div class="detail-grid"><div><span class="label">Operation</span><span class="value">'+esc(names[event.operation]||event.operation)+'</span></div><div><span class="label">Phase</span><span class="value">'+esc(event.phase)+'</span></div><div><span class="label">Request ID</span><span class="value">'+esc(event.requestId||event.id)+'</span></div><div><span class="label">Latency</span><span class="value">'+esc(event.latencyMs==null?"pending":event.latencyMs+"ms")+'</span></div></div><span class="label">Redacted ingest / result preview</span><div class="preview">'+esc(event.preview||event.error||"No preview recorded")+'</div>'}
function render(){var requestIds=new Set(events.map(function(e){return e.requestId||e.id})),ok=new Set(events.filter(function(e){return e.phase==="succeeded"}).map(function(e){return e.requestId||e.id})),fail=new Set(events.filter(function(e){return e.phase==="failed"}).map(function(e){return e.requestId||e.id})),ing=events.filter(function(e){return (e.operation==="remember_entry"||e.operation==="remember"||e.operation==="trace")&&(e.phase==="succeeded"||e.phase==="queued")}).length;$("requests").textContent=requestIds.size;$("success").textContent=ok.size;$("ingested").textContent=ing;$("failures").textContent=fail.size;var last=latest();$("stream-meta").textContent=last?"last signal "+new Date(last.at).toLocaleTimeString():"waiting for signal";if(last){$("agent").textContent=last.agentId||"unassigned";$("session").textContent=last.sessionId||"none";$("dataset").textContent=last.dataset||"default";$("endpoint").textContent=last.endpoint||"configured";$("updated").textContent="Updated "+new Date(last.at).toLocaleString()}var list=$("event-list");list.innerHTML=events.length?events.slice().reverse().map(function(e,i){return '<div class="event'+(selected===e.id?" selected":"")+'" data-id="'+esc(e.id)+'" style="animation-delay:'+Math.min(i*20,280)+'ms"><div class="time">'+esc(new Date(e.at).toLocaleTimeString())+'</div><div class="event-dot '+esc(e.phase)+'"></div><div class="event-main"><div class="event-name">'+esc(names[e.operation]||e.operation)+'</div><div class="sub">'+esc(e.sessionId||"no session")+(e.latencyMs==null?"":" / "+e.latencyMs+"ms")+'</div></div><span class="badge '+esc(e.phase)+'">'+esc(e.phase)+'</span></div>'}).join(""): '<div class="empty">Waiting for the first Cognee request.<br>Send a prompt in <strong>ice</strong> and watch the pipeline appear here.</div>';Array.prototype.forEach.call(document.querySelectorAll(".event"),function(node){node.addEventListener("click",function(){selected=node.getAttribute("data-id");show(events.find(function(e){return e.id===selected}));render()})});show(events.find(function(e){return e.id===selected})||null)}
function add(incoming){var next=Array.isArray(incoming)?incoming: [incoming];next.forEach(function(e){if(!events.some(function(old){return old.id===e.id}))events.push(e)});events=events.slice(-500);render()}
fetch("/api/state").then(function(r){return r.json()}).then(function(data){add(data.events||[]);$("connection").textContent="Live"}).catch(function(){$("connection").textContent="Offline"});
var source=new EventSource("/api/events");source.addEventListener("open",function(){$("connection").textContent="Live"});source.addEventListener("error",function(){$("connection").textContent="Reconnecting"});source.addEventListener("snapshot",function(e){add(JSON.parse(e.data).events||[])});source.addEventListener("observation",function(e){add(JSON.parse(e.data))});
})();
</script>
</body></html>`;

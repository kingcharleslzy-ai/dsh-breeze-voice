import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { createReadStream, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { stat } from "node:fs/promises";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as setTimeout$1 } from "node:timers/promises";
import { randomUUID } from "node:crypto";
//#region lib/types/voice-defaults.js
const DEFAULT_INSTRUCTION = "一位温柔自然的年轻女性，声音清晰，语气亲切，用自然的普通话交谈。";
const DEFAULT_VOICE_PROMPT = "当前用户正在通过实时语音与你对话。请用自然、简洁、适合听的中文回答，通常先给结论，再补充必要说明。优先使用短句，避免不必要的列表、表格、代码和链接；如果用户明确需要细节，仍然完整回答。需要执行任务时继续使用当前会话的工具和审批流程，并简短说明结果。不要朗读内部推理，也不要把尚未执行的操作说成已完成。";
//#endregion
//#region lib/types/config.js
const defaults = {
	sshHost: "",
	remotePort: 8870,
	localPort: 19889,
	apiKey: "",
	remoteTaskName: "",
	instruction: DEFAULT_INSTRUCTION,
	voiceId: "",
	asrHotwords: "",
	asrEngine: "server",
	reviewBeforeSend: false,
	silenceMs: 1200,
	vadThreshold: .018,
	bargeIn: true,
	idleMinutes: 10,
	activeVoiceId: "custom",
	voiceProfiles: [],
	voicePromptEnabled: true,
	voicePrompt: DEFAULT_VOICE_PROMPT,
	personaEnabled: false,
	personaName: "",
	personaPrompt: ""
};
const Config = z.object({
	sshHost: z.string().default("").volatile(),
	remotePort: z.number().default(8870).volatile(),
	localPort: z.number().default(19889).volatile(),
	apiKey: z.string().default("").role("secret").volatile(),
	remoteTaskName: z.string().default("").volatile(),
	instruction: z.string().default(defaults.instruction).volatile(),
	voiceId: z.string().default("").volatile(),
	asrEngine: z.union(["server", "dsh"]).default("server").volatile(),
	asrHotwords: z.string().default("").volatile(),
	reviewBeforeSend: z.boolean().default(false).volatile(),
	silenceMs: z.number().default(1200).volatile(),
	vadThreshold: z.number().default(.018).volatile(),
	bargeIn: z.boolean().default(true).volatile(),
	idleMinutes: z.number().default(10).volatile(),
	activeVoiceId: z.string().default("custom").volatile(),
	voiceProfiles: z.array(z.object({
		id: z.string(),
		name: z.string(),
		instruction: z.string()
	})).default([]).volatile(),
	voicePromptEnabled: z.boolean().default(true).volatile(),
	voicePrompt: z.string().default(DEFAULT_VOICE_PROMPT).volatile(),
	personaEnabled: z.boolean().default(false).volatile(),
	personaName: z.string().default("").volatile(),
	personaPrompt: z.string().default("").volatile()
});
function resolveConfig(raw) {
	const c = {
		...defaults,
		...raw
	};
	if (c.sshHost && !/^[a-zA-Z0-9][a-zA-Z0-9_.@-]{0,200}$/.test(c.sshHost)) throw Error("SSH 主机别名格式无效");
	if (c.remoteTaskName && !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,100}$/.test(c.remoteTaskName)) throw Error("服务器任务名称格式无效");
	for (const port of [c.localPort, c.remotePort]) if (!Number.isInteger(port) || port < 1024 || port > 65535) throw Error("端口须为 1024–65535 的整数");
	if (!Number.isFinite(c.silenceMs) || c.silenceMs < 400 || c.silenceMs > 3e3) throw Error("停顿时间须为 400–3000 毫秒");
	if (!Number.isFinite(c.vadThreshold) || c.vadThreshold < .005 || c.vadThreshold > .2) throw Error("麦克风阈值须为 0.005–0.2");
	if (typeof c.voiceId !== "string" || c.voiceId && !/^[a-zA-Z0-9_-]{1,100}$/.test(c.voiceId)) throw Error("固定音色标识无效");
	if (!["server", "dsh"].includes(c.asrEngine)) throw Error("识别引擎无效");
	if (typeof c.asrHotwords !== "string" || c.asrHotwords.length > 2e3) throw Error("识别热词最多 2000 字");
	if (c.instruction.length > 1e3) throw Error("声音描述过长");
	if (!Number.isInteger(c.idleMinutes) || c.idleMinutes < 0 || c.idleMinutes > 120) throw Error("空闲卸载时间须为 0–120 分钟的整数；0 表示不自动卸载");
	if (typeof c.voicePrompt !== "string" || c.voicePrompt.length > 6e3) throw Error("语音模式提示词最多 6000 字");
	if (typeof c.personaPrompt !== "string" || c.personaPrompt.length > 6e3) throw Error("角色提示词最多 6000 字");
	if (typeof c.personaName !== "string" || c.personaName.length > 80) throw Error("角色名称最多 80 字");
	if (typeof c.activeVoiceId !== "string" || c.activeVoiceId.length > 100) throw Error("音色标识无效");
	if (!Array.isArray(c.voiceProfiles) || c.voiceProfiles.length > 40) throw Error("最多保存 40 个音色");
	const ids = /* @__PURE__ */ new Set();
	for (const voice of c.voiceProfiles) {
		if (!voice || !/^[a-zA-Z0-9_-]{1,100}$/.test(voice.id) || ids.has(voice.id)) throw Error("音色标识无效或重复");
		if (typeof voice.name !== "string" || !voice.name.trim() || voice.name.length > 80) throw Error("音色名称须为 1–80 字");
		if (typeof voice.instruction !== "string" || !voice.instruction.trim() || voice.instruction.length > 1e3) throw Error("音色描述须为 1–1000 字");
		ids.add(voice.id);
	}
	return c;
}
//#endregion
//#region lib/types/chat-control.js
const editable = {
	instruction: "string",
	asrEngine: "string",
	asrHotwords: "string",
	reviewBeforeSend: "boolean",
	silenceMs: "number",
	bargeIn: "boolean",
	idleMinutes: "number",
	voicePromptEnabled: "boolean",
	voicePrompt: "string",
	personaEnabled: "boolean",
	personaName: "string",
	personaPrompt: "string"
};
function remoteControl(current, tunnel) {
	return async (path, method = "GET", body, signal) => {
		signal?.throwIfAborted();
		const c = resolveConfig(current());
		const release = await tunnel.acquire(c);
		try {
			signal?.throwIfAborted();
			const response = await fetch(`http://127.0.0.1:${c.localPort}${path}`, {
				method,
				headers: {
					"content-type": "application/json",
					...c.apiKey ? { authorization: `Bearer ${c.apiKey}` } : {}
				},
				...body === void 0 ? {} : { body: JSON.stringify(body) },
				signal: AbortSignal.any([...signal ? [signal] : [], AbortSignal.timeout(path === "/v1/voices" && method === "POST" ? 18e4 : 2e4)])
			});
			if (!response.ok) throw Error(response.status === 409 ? "语音服务忙碌，请稍后重试" : `语音服务请求失败（HTTP ${response.status}）`);
			return await response.json();
		} finally {
			release();
		}
	};
}
var VoiceChatControl = class {
	current;
	settings;
	remote;
	active;
	nativeReady;
	pending = Promise.resolve();
	constructor(current, settings, remote, active = () => 0, nativeReady = () => false) {
		this.current = current;
		this.settings = settings;
		this.remote = remote;
		this.active = active;
		this.nativeReady = nativeReady;
	}
	descriptor() {
		const d = this.settings.describe({ redactSecrets: true }).find((d) => d.ns === "breeze-voice");
		if (!d) throw Error("语音插件设置尚未就绪");
		return d;
	}
	snapshot() {
		const d = this.descriptor(), c = resolveConfig(this.current());
		return {
			revision: d.revision,
			settings: Object.fromEntries([...Object.keys(editable), "voiceId"].map((key) => [key, c[key]])),
			active_calls: this.active(),
			scope: "当前 DSH profile 的所有语音会话",
			restart_required: false
		};
	}
	serial(fn) {
		const next = this.pending.then(fn, fn);
		this.pending = next.catch(() => {});
		return next;
	}
	revision(value) {
		if (!Number.isInteger(value) || value !== this.descriptor().revision) throw Error("设置已变更或缺少 revision，请先读取设置，再带回最新修订号");
	}
	validate(patch) {
		if (!patch || typeof patch !== "object" || Array.isArray(patch) || !Object.keys(patch).length) throw Error("patch 不能为空");
		for (const [key, value] of Object.entries(patch)) {
			if (!Object.hasOwn(editable, key)) throw Error(`不可通过设置工具修改 ${key}；固定音色请用音色工具选择`);
			if (typeof value !== editable[key]) throw Error(`${key} 类型无效`);
		}
		resolveConfig({
			...this.current(),
			...patch
		});
		if (Object.hasOwn(patch, "asrEngine") && patch.asrEngine !== resolveConfig(this.current()).asrEngine) {
			if (this.active()) throw Error("请先结束语音通话，再切换识别引擎");
			if (patch.asrEngine === "dsh" && !this.nativeReady()) throw Error("DSH 原生语音识别尚未就绪，请先在原生插件中准备模型");
		}
		return patch;
	}
	async save(patch, revision, signal) {
		signal?.throwIfAborted();
		this.revision(revision);
		await this.settings.mutate("breeze-voice", Object.entries(patch).map(([key, value]) => ({
			op: "set",
			path: [key],
			value
		})), revision);
		const result = this.snapshot();
		const readback = Object.entries(patch).every(([key, value]) => JSON.stringify(result.settings[key]) === JSON.stringify(value));
		return {
			...result,
			saved: readback,
			changed_fields: Object.keys(patch),
			...readback ? {} : { warning: "写入后配置又发生变化，请核对回读值" }
		};
	}
	async update(patch, revision, signal) {
		return this.serial(async () => {
			this.revision(revision);
			const values = this.validate(patch);
			const saved = await this.save(values, revision, signal);
			let server_sync = { required: false };
			if (saved.saved && Object.hasOwn(values, "idleMinutes")) try {
				server_sync = await this.syncIdle(signal);
			} catch {
				server_sync = {
					ok: false,
					error: "本机已保存，服务器同步未确认；请用 service sync_idle 重试，不要重复覆盖设置"
				};
			}
			const latest = this.snapshot();
			const matches = Object.entries(values).every(([key, value]) => JSON.stringify(latest.settings[key]) === JSON.stringify(value));
			return {
				...saved,
				...latest,
				saved: saved.saved && matches,
				...!matches ? { warning: "保存后设置被再次修改，以当前回读值为准" } : {},
				server_sync,
				effect: Object.fromEntries(Object.keys(values).map((key) => [key, [
					"silenceMs",
					"bargeIn",
					"reviewBeforeSend",
					"asrEngine"
				].includes(key) ? "下次开始语音通话" : key === "instruction" ? "仅新建/试听音色描述，不改变已固定音色" : key === "idleMinutes" ? "本机已保存；服务器以 server_sync 为准" : "下一次相关识别或语音对话请求"]))
			};
		});
	}
	async syncIdle(signal) {
		for (let n = 0; n < 3; n++) {
			const seconds = resolveConfig(this.current()).idleMinutes * 60;
			if ((await this.remote("/v1/settings", "PATCH", { idle_seconds: seconds }, signal)).idle_seconds !== seconds) throw Error("服务器空闲策略回读不一致");
			if (resolveConfig(this.current()).idleMinutes * 60 === seconds) return {
				ok: true,
				idle_seconds: seconds
			};
		}
		throw Error("设置被连续修改，服务器同步未确认");
	}
	async voices(args, signal) {
		const action = args.action ?? "list";
		if (action === "list") {
			const library = await this.remote("/v1/voices", "GET", void 0, signal);
			return {
				...library,
				selected_voice_id: resolveConfig(this.current()).voiceId || library.default_voice_id,
				revision: this.descriptor().revision
			};
		}
		if (action === "select") return this.serial(async () => {
			this.revision(args.revision);
			if (typeof args.voice_id !== "string" || !/^[a-f0-9]{32}$/.test(args.voice_id)) throw Error("必须提供列表中真实的 voice_id");
			const library = await this.remote("/v1/voices", "GET", void 0, signal);
			if (!Array.isArray(library.voices) || !library.voices.some((v) => v.id === args.voice_id)) throw Error("所选音色不存在，请重新读取列表");
			return {
				...await this.save({ voiceId: args.voice_id }, args.revision, signal),
				effect: "下一段新合成的语音；已播放/正在播放的音频不变"
			};
		});
		if (action === "create") {
			if (typeof args.name !== "string" || !args.name.trim() || args.name.length > 80 || typeof args.instruction !== "string" || !args.instruction.trim() || args.instruction.length > 1e3) throw Error("新音色需要 1–80 字名称和 1–1000 字声音描述");
			try {
				return {
					created: await this.remote("/v1/voices", "POST", {
						name: args.name.trim(),
						instruction: args.instruction.trim()
					}, signal),
					selected: false,
					note: "固定参考音色已创建；如需切换，请先 list 后 select"
				};
			} catch {
				throw Error("创建音色未确认。请先 list 检查是否已保存，不要自动重复创建");
			}
		}
		throw Error("音色 action 应为 list、select 或 create");
	}
	async service(action = "status", signal) {
		if (action === "status") return {
			server: await this.remote("/health", "GET", void 0, signal),
			active_calls: this.active()
		};
		if (action === "sync_idle") return this.serial(() => this.syncIdle(signal));
		if (action === "release") {
			if (this.active()) throw Error("仍有语音通话，请先结束通话后释放模型");
			return { server: await this.remote("/v1/models/unload", "POST", {}, signal) };
		}
		throw Error("服务 action 应为 status、sync_idle 或 release");
	}
};
//#endregion
//#region lib/types/chat-tools.js
const output = {
	schema: {
		type: "object",
		properties: { result: {
			type: "string",
			required: true
		} },
		additionalProperties: false
	},
	render: (_args, value) => [{
		type: "text",
		text: value.result
	}]
};
const fields = {
	instruction: {
		type: "string",
		description: "1–1000 字，新音色描述草稿；不改变固定音色。要切换声音用 breeze_voice_voices。"
	},
	asrEngine: {
		type: "string",
		enum: ["server", "dsh"],
		description: "server 为 4090 中文识别；dsh 为已准备好的原生语音输入。切换前结束通话。"
	},
	asrHotwords: {
		type: "string",
		description: "识别热词，上限 2000 字。"
	},
	reviewBeforeSend: {
		type: "boolean",
		description: "识别后人工确认再发送；下次通话生效。"
	},
	silenceMs: {
		type: "integer",
		description: "断句停顿 400–3000 毫秒，下次通话生效。"
	},
	bargeIn: {
		type: "boolean",
		description: "允许说话打断朗读，下次通话生效。"
	},
	idleMinutes: {
		type: "integer",
		description: "闲置释放模型：0–120 分钟，0 为保持加载。自动同步服务器并返回确认结果。"
	},
	voicePromptEnabled: { type: "boolean" },
	voicePrompt: {
		type: "string",
		description: "语音模式默认提示词，最多 6000 字，只作用于正在语音连接的会话。"
	},
	personaEnabled: { type: "boolean" },
	personaName: {
		type: "string",
		description: "当前语音角色名称，最多 80 字。"
	},
	personaPrompt: {
		type: "string",
		description: "当前语音角色提示词，最多 6000 字；保存一个当前角色，不是多角色库。"
	}
};
function voiceToolDefinitions(control) {
	return [
		defineTool({
			name: "breeze_voice_settings",
			description: "读取或修改 Breeze 语音插件设置。get 读取 revision；用户明确要求修改时 update，只传要修改的 patch 字段及 revision。与原生侧栏共用持久配置，写后回读；不需要重启或编辑 YAML。作用于当前 profile 的所有语音通话。检查 saved、server_sync 和 effect 后报告结果。音色切换使用 breeze_voice_voices。",
			timeoutMs: 12e4,
			parameters: {
				action: {
					type: "string",
					enum: ["get", "update"]
				},
				revision: { type: "integer" },
				patch: {
					type: "object",
					properties: fields,
					additionalProperties: false
				}
			},
			output,
			async execute(args, exec) {
				if ((args.action ?? "get") === "get") {
					if (args.patch !== void 0) throw Error("读取操作不能带 patch");
					return { result: JSON.stringify(control.snapshot()) };
				}
				return { result: JSON.stringify(await control.update(args.patch, args.revision, exec.signal)) };
			}
		}),
		defineTool({
			name: "breeze_voice_voices",
			description: "管理 Breeze 固定参考音色：list 读取真实音色及设置 revision；select 用列表真实 voice_id 和 revision 持久选择，下一段新合成生效；create 按 name/instruction 创建并保存固定参考声音，耗用服务器 GPU，但不自动选中。只在用户要求时 create/select；已有合适音色直接选择。创建超时先 list 核实，禁止自动重试生成。",
			timeoutMs: 24e4,
			parameters: {
				action: {
					type: "string",
					enum: [
						"list",
						"select",
						"create"
					]
				},
				voice_id: { type: "string" },
				revision: { type: "integer" },
				name: { type: "string" },
				instruction: { type: "string" }
			},
			output,
			async execute(args, exec) {
				return { result: JSON.stringify(await control.voices(args, exec.signal)) };
			}
		}),
		defineTool({
			name: "breeze_voice_service",
			description: "Breeze 语音服务器：status 检查连接和模型状态；sync_idle 将当前已保存空闲策略同步服务器并验证；release 在用户要求且无通话时释放本插件的语音模型，忙碌时拒绝。通过已有私有连接工作。不会修改连接凭证或其他服务，不启动麦克风，不替用户发消息。",
			timeoutMs: 12e4,
			parameters: { action: {
				type: "string",
				enum: [
					"status",
					"sync_idle",
					"release"
				]
			} },
			output,
			async execute(args, exec) {
				return { result: JSON.stringify(await control.service(args.action, exec.signal)) };
			}
		})
	];
}
function registerVoiceTools(ctx, control) {
	for (const tool of voiceToolDefinitions(control)) ctx.tools.register(tool);
}
//#endregion
//#region lib/types/skill.js
function bundledVoiceSkill() {
	const path = fileURLToPath(new URL("../skills/breeze-voice/SKILL.md", import.meta.url));
	const match = readFileSync(path, "utf8").match(/^---\r?\n([\s\S]*?)\r?\n---\s*\r?\n([\s\S]*)$/);
	if (!match) throw Error("语音技能缺少 frontmatter");
	const meta = Object.fromEntries(match[1].split(/\r?\n/).map((line) => {
		const field = line.match(/^(name|description|whenToUse): (.+)$/);
		if (!field) throw Error("语音技能元数据无效");
		return [field[1], field[2]];
	}));
	if (meta.name !== "breeze-voice" || !meta.description || !meta.whenToUse || !match[2].trim()) throw Error("语音技能内容不完整");
	return {
		name: meta.name,
		description: meta.description,
		whenToUse: meta.whenToUse,
		content: match[2].trim(),
		path,
		source: "语音",
		invocation: {
			modelInvocable: true,
			userInvocable: true
		}
	};
}
//#endregion
//#region lib/types/native-asr.js
const NATIVE_PROVIDER = "sensevoice-local";
function serviceOf(source) {
	const value = source && "get" in source ? source.get("speechToText") : source;
	return value && typeof value.snapshot === "function" && typeof value.resolve === "function" && typeof value.transcribe === "function" ? value : void 0;
}
function lookupNativeAsr(source) {
	const service = serviceOf(source);
	if (!service) return {
		available: false,
		ready: false,
		phase: "unavailable",
		providerId: NATIVE_PROVIDER,
		name: "DSH SenseVoice",
		message: "先在 DSH 插件中启用「语音输入」，再到语音输入设置准备本机 SenseVoice。"
	};
	try {
		const provider = service.snapshot().providers.find((p) => p.id === NATIVE_PROVIDER);
		if (!provider) return {
			available: false,
			ready: false,
			phase: "unavailable",
			providerId: NATIVE_PROVIDER,
			name: "DSH SenseVoice",
			message: "DSH 语音服务已启用，但未注册本机 SenseVoice。请启用原生语音输入插件。"
		};
		const phase = provider.preparation?.phase ?? "ready";
		const ready = ["ready", "standby"].includes(phase) && (!provider.languages || provider.languages.includes("zh"));
		return {
			available: true,
			ready,
			phase,
			providerId: NATIVE_PROVIDER,
			name: provider.name ?? "DSH SenseVoice",
			message: ready ? phase === "standby" ? "本机模型已准备，首次识别会按需加载。" : "本机识别已就绪。" : `原生识别尚未就绪（${phase}）。请在 DSH 语音输入设置中完成准备；本插件不会自动下载模型。`
		};
	} catch {
		return {
			available: false,
			ready: false,
			phase: "error",
			providerId: NATIVE_PROVIDER,
			name: "DSH SenseVoice",
			message: "无法读取 DSH 原生语音服务状态，请检查原生插件。"
		};
	}
}
function validateWav(bytes) {
	const a = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	if (a.length < 46 || a.length > 774444 || a.toString("ascii", 0, 4) !== "RIFF" || a.toString("ascii", 8, 12) !== "WAVE" || a.toString("ascii", 12, 16) !== "fmt " || a.readUInt32LE(16) !== 16 || a.readUInt16LE(20) !== 1 || a.readUInt16LE(22) !== 1 || a.readUInt32LE(24) !== 16e3 || a.readUInt32LE(28) !== 32e3 || a.readUInt16LE(32) !== 2 || a.readUInt16LE(34) !== 16 || a.toString("ascii", 36, 40) !== "data" || a.readUInt32LE(4) !== a.length - 8 || a.readUInt32LE(40) !== a.length - 44 || (a.length - 44) % 2) throw Error("原生识别只接受 24 秒以内的 16 kHz 单声道 PCM16 WAV");
	return {
		audio: a,
		duration: (a.length - 44) / 32e3
	};
}
async function recognizeNativeAsr(source, bytes, signal) {
	signal.throwIfAborted();
	const status = lookupNativeAsr(source);
	if (!status.ready) throw Error(status.message);
	const service = serviceOf(source);
	const { audio, duration } = validateWav(bytes);
	const spec = service.resolve({
		audio,
		providerId: NATIVE_PROVIDER,
		language: "zh"
	});
	const result = await service.transcribe(spec, signal);
	signal.throwIfAborted();
	if (!result || typeof result !== "object" || typeof result.text !== "string") throw Error("DSH 原生识别未返回有效文本");
	return {
		text: result.text.trim(),
		language: "zh",
		duration
	};
}
//#endregion
//#region lib/types/tunnel.js
/** Owns only the SSH process created by this plugin. Never closes user tunnels. */
var Tunnel = class {
	child;
	opening;
	identity = "";
	idle;
	active = 0;
	async acquire(c) {
		clearTimeout(this.idle);
		const identity = `${c.sshHost}:${c.localPort}:${c.remotePort}`;
		if (this.identity && this.identity !== identity) {
			if (this.active) throw Error("语音正在运行，请结束通话后修改连接设置");
			this.close();
		}
		this.identity = identity;
		if (c.sshHost && !this.child && !this.opening) this.opening = this.open(c).finally(() => {
			this.opening = void 0;
		});
		if (this.opening) await this.opening;
		this.active++;
		let released = false;
		return () => {
			if (released) return;
			released = true;
			this.active--;
			if (!this.active && c.idleMinutes > 0) this.idle = setTimeout(() => this.close(), c.idleMinutes * 6e4);
			this.idle?.unref();
		};
	}
	async open(c) {
		if (c.remoteTaskName) await promisify(execFile)("ssh", [
			"-T",
			"-o",
			"BatchMode=yes",
			"-o",
			"ConnectTimeout=10",
			c.sshHost,
			"schtasks",
			"/Run",
			"/TN",
			c.remoteTaskName
		], {
			timeout: 2e4,
			windowsHide: true
		});
		const child = spawn("ssh", [
			"-N",
			"-T",
			"-o",
			"BatchMode=yes",
			"-o",
			"ExitOnForwardFailure=yes",
			"-o",
			"ConnectTimeout=10",
			"-o",
			"ServerAliveInterval=15",
			"-o",
			"ServerAliveCountMax=2",
			"-L",
			`127.0.0.1:${c.localPort}:127.0.0.1:${c.remotePort}`,
			c.sshHost
		], { stdio: [
			"ignore",
			"ignore",
			"pipe"
		] });
		let failure = "";
		child.stderr?.on("data", (part) => {
			failure = (failure + part.toString()).slice(-1e3);
		});
		child.on("error", (e) => {
			failure = e.message;
		});
		child.on("exit", () => {
			if (this.child === child) this.child = void 0;
		});
		this.child = child;
		for (let i = 0; i < 24; i++) {
			if (child.exitCode !== null || failure) break;
			try {
				const response = await fetch(`http://127.0.0.1:${c.localPort}/health`, {
					headers: c.apiKey ? { authorization: `Bearer ${c.apiKey}` } : {},
					signal: AbortSignal.timeout(700)
				});
				if (response.ok) return;
				if (response.status === 401 || response.status === 403) {
					failure = "语音服务密钥不正确";
					break;
				}
			} catch {}
			await setTimeout$1(250);
		}
		if (this.child === child) this.close();
		throw Error(failure.trim() || "无法连接语音服务，请检查服务器网关和 SSH 配置");
	}
	close() {
		clearTimeout(this.idle);
		this.child?.kill("SIGTERM");
		this.child = void 0;
		this.identity = "";
	}
};
//#endregion
//#region lib/types/prompt-session.js
/** Process-local leases: no model instructions are persisted into user messages. */
var VoicePromptSessions = class {
	current;
	clock;
	leases = /* @__PURE__ */ new Map();
	ttlMs = 9e4;
	constructor(current, clock = Date.now) {
		this.current = current;
		this.clock = clock;
	}
	prune() {
		const now = this.clock();
		for (const [id, lease] of this.leases) if (lease.expiresAt <= now) this.leases.delete(id);
	}
	activeCount() {
		this.prune();
		return this.leases.size;
	}
	handle(input) {
		this.prune();
		if (!input || typeof input.sessionId !== "string" || !/^[a-zA-Z0-9_.:-]{1,200}$/.test(input.sessionId)) throw Error("语音会话标识无效");
		const existing = this.leases.get(input.sessionId);
		if (input.action === "start") {
			if (existing) throw Error("此会话已在另一个语音窗口中连接，请先结束原通话");
			if (this.leases.size >= 32) throw Error("语音连接过多，请结束闲置的通话");
			const lease = {
				leaseId: randomUUID(),
				expiresAt: this.clock() + this.ttlMs
			};
			this.leases.set(input.sessionId, lease);
			return {
				...lease,
				active: true,
				...this.promptStatus()
			};
		}
		if (input.action !== "keepalive" && input.action !== "stop") throw Error("语音会话操作无效");
		if (!existing) {
			if (input.action === "stop") return { active: false };
			throw Error("语音连接已过期，请重新开始");
		}
		if (typeof input.leaseId !== "string" || input.leaseId !== existing.leaseId) throw Error("语音连接标识不匹配");
		if (input.action === "stop") {
			this.leases.delete(input.sessionId);
			return { active: false };
		}
		existing.expiresAt = this.clock() + this.ttlMs;
		return {
			...existing,
			active: true,
			...this.promptStatus()
		};
	}
	promptStatus() {
		const c = resolveConfig(this.current());
		return {
			voicePromptActive: c.voicePromptEnabled && Boolean(c.voicePrompt.trim()),
			personaActive: c.personaEnabled && Boolean(c.personaPrompt.trim()),
			personaName: c.personaName
		};
	}
	textFor(context) {
		this.prune();
		const agent = context?.agent, header = agent?.session?.header ?? agent?.session;
		const id = typeof header?.id === "string" ? header.id : agent?.id;
		if (typeof id !== "string" || !this.leases.has(id)) return "";
		const c = resolveConfig(this.current()), parts = [];
		if (c.voicePromptEnabled && c.voicePrompt.trim()) parts.push(`【当前语音交流方式】\n${c.voicePrompt.trim()}`);
		if (c.personaEnabled && c.personaPrompt.trim()) parts.push(`【当前语音对话角色${c.personaName.trim() ? `：${c.personaName.trim()}` : ""}】\n${c.personaPrompt.trim()}`);
		return parts.join("\n\n");
	}
	dispose() {
		this.leases.clear();
	}
};
function installVoicePromptSessions(ctx, current) {
	const manager = new VoicePromptSessions(current);
	const prompt = ctx.get("systemPrompt");
	if (!prompt) throw Error("当前 DSH 未提供原生系统提示词服务");
	let order = 250;
	try {
		order = prompt.getSectionOrder("DEPLOYMENT_PERSONA_PREFIX") + 2;
	} catch {}
	ctx.effect(() => prompt.section({
		name: "BREEZE_VOICE_SESSION",
		order,
		interpolate: false,
		text: (context) => manager.textFor(context)
	}), "breeze-voice scoped prompt");
	ctx.effect(() => () => manager.dispose(), "breeze-voice session leases");
	return manager;
}
//#endregion
//#region lib/types/index.js
const name = "breeze-voice";
const inject = ["webServer", "systemPrompt"];
const API = "/api/breeze-voice";
async function readBody(req, limit) {
	const chunks = [];
	let size = 0;
	for await (const chunk of req) {
		size += chunk.length;
		if (size > limit) throw Error("录音过长，请分段说话");
		chunks.push(Buffer.from(chunk));
	}
	return Buffer.concat(chunks);
}
function validOrigin(req) {
	if (req.headers["sec-fetch-site"] === "cross-site") return false;
	const origin = req.headers.origin;
	if (!origin) return true;
	try {
		return new URL(origin).host === req.headers.host;
	} catch {
		return false;
	}
}
function createHandler(current, tunnel, route, sessions, nativeSource) {
	return async (req, res) => {
		const json = (code, value) => {
			res.writeHead(code, {
				"content-type": "application/json",
				"cache-control": "no-store"
			});
			res.end(JSON.stringify(value));
		};
		const controller = new AbortController();
		const closed = () => {
			if (!res.writableEnded) controller.abort();
		};
		res.on("close", closed);
		let release;
		try {
			if (!validOrigin(req)) return json(403, { error: "禁止跨站访问语音服务" });
			const c = resolveConfig(current());
			if (route === "config" && req.method === "GET") {
				const { apiKey, ...publicConfig } = c;
				return json(200, {
					...publicConfig,
					apiKeyConfigured: Boolean(apiKey)
				});
			}
			if (route === "native-asr") {
				if (req.method !== "GET") return json(405, { error: "请求方法不支持" });
				return json(200, lookupNativeAsr(nativeSource));
			}
			if (route === "session") {
				if (req.method !== "POST") return json(405, { error: "请求方法不支持" });
				if (!sessions) return json(503, { error: "会话提示词服务尚未就绪" });
				try {
					const data = JSON.parse((await readBody(req, 16384)).toString());
					return json(200, sessions.handle(data));
				} catch (e) {
					return json(400, { error: e instanceof Error ? e.message : "会话请求无效" });
				}
			}
			const expectedMethod = route === "health" || route === "voices" && req.method === "GET" ? "GET" : "POST";
			if (req.method !== expectedMethod) return json(405, { error: "请求方法不支持" });
			let body;
			let contentType = req.headers["content-type"] ?? "";
			if (route === "speech" || route === "preview") {
				const data = JSON.parse((await readBody(req, 65536)).toString());
				if (typeof data.input !== "string" || !data.input.trim() || data.input.length > 2e3) return json(400, { error: "朗读文本须为 1–2000 字" });
				if (route === "preview" && !data.voiceId && (typeof data.instruction !== "string" || !data.instruction.trim() || data.instruction.length > 1e3)) return json(400, { error: "试听需要 1–1000 字的音色描述" });
				const voice = route === "preview" ? data.voiceId : c.voiceId;
				if (voice && (typeof voice !== "string" || !/^[a-f0-9]{32}$/.test(voice))) return json(400, { error: "音色 ID 无效" });
				body = JSON.stringify({
					input: data.input,
					instructions: route === "preview" && !voice ? data.instruction.trim() : c.instruction,
					voice: voice || void 0,
					design: route === "preview" && !voice,
					response_format: "pcm"
				});
				contentType = "application/json";
			} else if (route === "transcriptions") {
				if (!contentType.startsWith("multipart/form-data;")) return json(400, { error: "需要 WAV 录音" });
				const incoming = await readBody(req, 4194304);
				const file = (await new Response(incoming, { headers: { "content-type": contentType } }).formData()).get("file");
				if (!(file instanceof Blob)) return json(400, { error: "需要 WAV 录音" });
				if (c.asrEngine === "dsh") try {
					return json(200, await recognizeNativeAsr(nativeSource, new Uint8Array(await file.arrayBuffer()), controller.signal));
				} catch (e) {
					return json(503, { error: e instanceof Error ? e.message : "原生语音识别失败" });
				}
				body = new FormData();
				body.append("file", file, "utterance.wav");
				body.set("hotwords", c.asrHotwords);
				contentType = "";
			} else if (route === "voices") {
				if (expectedMethod === "POST") {
					const data = JSON.parse((await readBody(req, 16384)).toString());
					if (typeof data.name !== "string" || !data.name.trim() || data.name.length > 80 || typeof data.instruction !== "string" || !data.instruction.trim() || data.instruction.length > 1e3) return json(400, { error: "请填写音色名称和描述" });
					body = JSON.stringify({
						name: data.name,
						instruction: data.instruction
					});
					contentType = "application/json";
				}
			} else if (route === "voice-default") {
				const data = JSON.parse((await readBody(req, 4096)).toString());
				if (typeof data.voiceId !== "string" || !/^[a-f0-9]{32}$/.test(data.voiceId)) return json(400, { error: "音色 ID 无效" });
				body = JSON.stringify({ voice_id: data.voiceId });
				contentType = "application/json";
			} else if (route === "service-settings") {
				body = JSON.stringify({ idle_seconds: c.idleMinutes * 60 });
				contentType = "application/json";
			} else if (route === "warmup" || route === "release") {
				body = route === "warmup" ? JSON.stringify({ asr: c.asrEngine !== "dsh" }) : "{}";
				contentType = "application/json";
			} else if (route !== "health") return json(404, { error: "未知语音接口" });
			release = await tunnel.acquire(c);
			if (controller.signal.aborted) return;
			const remotePath = route === "voices" ? "/v1/voices" : route === "voice-default" ? "/v1/voices/default" : route === "health" ? "/health" : route === "service-settings" ? "/v1/settings" : route === "release" ? "/v1/models/unload" : `/v1/audio/${route === "preview" ? "speech" : route}`;
			const upstream = await fetch(`http://127.0.0.1:${c.localPort}${remotePath}`, {
				method: route === "service-settings" ? "PATCH" : expectedMethod,
				headers: {
					...contentType ? { "content-type": contentType } : {},
					...c.apiKey ? { authorization: `Bearer ${c.apiKey}` } : {}
				},
				...body === void 0 ? {} : { body },
				signal: AbortSignal.any([controller.signal, AbortSignal.timeout(route === "health" ? 15e3 : 18e4)])
			});
			if (!upstream.ok) {
				const error = await upstream.text();
				let message = `语音服务返回 ${upstream.status}`;
				try {
					const parsed = JSON.parse(error);
					message = String(parsed.error?.message ?? parsed.error ?? parsed.detail ?? message);
				} catch {}
				return json(upstream.status, { error: message.slice(0, 500) });
			}
			res.writeHead(upstream.status, {
				"content-type": upstream.headers.get("content-type") ?? "application/octet-stream",
				"cache-control": "no-store",
				"x-sample-rate": upstream.headers.get("x-sample-rate") ?? "24000"
			});
			if (upstream.body) for await (const chunk of upstream.body) {
				if (controller.signal.aborted) break;
				if (!res.write(chunk)) await once(res, "drain", { signal: controller.signal });
			}
			res.end();
		} catch (e) {
			if (!res.headersSent && !res.destroyed) json(502, { error: e instanceof Error && e.message !== "fetch failed" ? e.message : "无法连接语音网关，请检查服务器任务、SSH 别名和端口。" });
			else if (!res.destroyed) res.destroy();
		} finally {
			release?.();
			res.off("close", closed);
		}
	};
}
const VAD_ASSETS = {
	"ort.wasm.min.js": "text/javascript",
	"ort-wasm-simd-threaded.mjs": "text/javascript",
	"ort-wasm-simd-threaded.wasm": "application/wasm",
	"silero_vad_v5.onnx": "application/octet-stream",
	"vad.worklet.bundle.min.js": "text/javascript"
};
function assetHandler(filename) {
	return async (req, res) => {
		if (!Object.hasOwn(VAD_ASSETS, filename) || !validOrigin(req)) {
			res.writeHead(403);
			res.end();
			return;
		}
		if (req.method !== "GET" && req.method !== "HEAD") {
			res.writeHead(405);
			res.end();
			return;
		}
		try {
			const location = new URL("../assets/vad/" + filename, import.meta.url);
			const info = await stat(location);
			res.writeHead(200, {
				"content-type": VAD_ASSETS[filename],
				"content-length": info.size,
				"cache-control": "no-cache"
			});
			if (req.method === "HEAD") {
				res.end();
				return;
			}
			const stream = createReadStream(location);
			res.on("close", () => stream.destroy());
			stream.on("error", () => res.destroy());
			stream.pipe(res);
		} catch {
			if (!res.headersSent) res.writeHead(404);
			res.end();
		}
	};
}
function apply(ctx, config = {}) {
	const tunnel = new Tunnel();
	const current = () => Object.fromEntries(Object.entries(config).map(([key, value]) => [key, value && typeof value === "object" && "get" in value ? value.get() : value]));
	const sessions = installVoicePromptSessions(ctx, current);
	const injectServices = ctx.inject;
	injectServices.call(ctx, ["tools", "settings"], (owner) => {
		registerVoiceTools(owner, new VoiceChatControl(current, owner.get("settings"), remoteControl(current, tunnel), () => sessions.activeCount(), () => lookupNativeAsr(ctx).ready));
	});
	injectServices.call(ctx, ["skills"], (owner) => {
		const skills = owner.get("skills");
		owner.effect(() => skills.register(bundledVoiceSkill()), "breeze-voice chat skill");
	});
	const web = ctx.get("webServer");
	ctx.effect(() => web.register({
		kind: "exact",
		path: `${API}/capabilities`,
		handler: async (req, res) => {
			if (!validOrigin(req) || req.method !== "GET") {
				res.writeHead(403);
				res.end();
				return;
			}
			const tools = ctx.get("tools");
			const skills = ctx.get("skills");
			const skill = skills ? await skills.get("breeze-voice").catch(() => void 0) : void 0;
			res.writeHead(200, {
				"content-type": "application/json",
				"cache-control": "no-store"
			});
			res.end(JSON.stringify({
				tools: [
					"breeze_voice_settings",
					"breeze_voice_voices",
					"breeze_voice_service"
				].filter((name) => Boolean(tools?.get(name))),
				skill: skill ? "breeze-voice" : null,
				active_calls: sessions.activeCount()
			}));
		}
	}), "breeze-voice capabilities");
	for (const route of [
		"config",
		"health",
		"warmup",
		"speech",
		"transcriptions",
		"preview",
		"release",
		"service-settings",
		"session",
		"voices",
		"voice-default",
		"native-asr"
	]) ctx.effect(() => web.register({
		kind: "exact",
		path: `${API}/${route}`,
		handler: createHandler(current, tunnel, route, sessions, ctx)
	}), `breeze-voice ${route}`);
	for (const filename of Object.keys(VAD_ASSETS)) ctx.effect(() => web.register({
		kind: "exact",
		path: `${API}/assets/${filename}`,
		handler: assetHandler(filename)
	}), `breeze-voice asset ${filename}`);
	ctx.effect(() => () => tunnel.close(), "breeze-voice owned SSH");
}
//#endregion
export { API, Config, VAD_ASSETS, apply, assetHandler, createHandler, inject, name, readBody, validOrigin };

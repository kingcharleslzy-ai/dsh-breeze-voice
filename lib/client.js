window.__ModuleLoader__.load({
	id: "dsh-breeze-voice",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react_jsx_runtime = require("react/jsx-runtime");
		let react = require("react");
		//#region lib/types/voice-defaults.js
		const DEFAULT_INSTRUCTION = "一位温柔自然的年轻女性，声音清晰，语气亲切，用自然的普通话交谈。";
		const DEFAULT_VOICE_PROMPT = "当前用户正在通过实时语音与你对话。请用自然、简洁、适合听的中文回答，通常先给结论，再补充必要说明。优先使用短句，避免不必要的列表、表格、代码和链接；如果用户明确需要细节，仍然完整回答。需要执行任务时继续使用当前会话的工具和审批流程，并简短说明结果。不要朗读内部推理，也不要把尚未执行的操作说成已完成。";
		const VOICE_PRESETS = [
			{
				id: "warm",
				name: "温柔清晰",
				tag: "自然 · 女声",
				instruction: DEFAULT_INSTRUCTION
			},
			{
				id: "steady",
				name: "沉稳从容",
				tag: "温暖 · 男声",
				instruction: "一位沉稳温暖的成年男性，音色干净略低沉，普通话标准，语速适中，像面对面交流一样自然。"
			},
			{
				id: "bright",
				name: "轻快明亮",
				tag: "轻盈 · 女声",
				instruction: "一位声音明亮轻盈的年轻女性，普通话标准，语气友好而有活力，吐字清晰，节奏轻快但不急促。"
			},
			{
				id: "narrator",
				name: "柔和讲述",
				tag: "舒缓 · 男声",
				instruction: "一位声音柔和有质感的成年男性，使用清晰自然的普通话，语速稍慢，语气平和，像耐心讲解故事一样交谈。"
			}
		];
		const PERSONA_PRESETS = [
			{
				name: "务实搭档",
				prompt: "你是一位务实可靠的工作搭档。先理解用户的目标，再给出可执行的下一步。表达清楚、有分寸，遇到不确定的事实坦诚说明，不夸大结果。"
			},
			{
				name: "耐心讲解者",
				prompt: "你是一位耐心的讲解者。先用容易理解的话说明重点，再按用户需要逐步展开。使用贴近日常的小例子，适当确认用户是否跟得上，不居高临下。"
			},
			{
				name: "轻松聊天",
				prompt: "你是一位温暖、有好奇心的聊天伙伴。自然回应用户刚说的话，语气轻松，避免机械复述和过度热情。可以适时问一个简短的问题，让对话自然继续。"
			}
		];
		//#endregion
		//#region lib/types/client/vad-model.js
		/** Local-only Silero v5 inference. No remote model, script, worker or telemetry. */
		const VAD_ASSETS = "/api/breeze-voice/assets/";
		let runtime;
		function loadRuntime() {
			return runtime ??= new Promise((resolve, reject) => {
				const script = document.createElement("script");
				script.src = VAD_ASSETS + "ort.wasm.min.js";
				script.onload = () => {
					const ort = window.ort;
					if (!ort) {
						script.remove();
						reject(Error("本机语音检测运行库未加载"));
						return;
					}
					ort.env.wasm.numThreads = 1;
					ort.env.wasm.proxy = false;
					ort.env.wasm.wasmPaths = new URL(VAD_ASSETS, location.href).href;
					ort.env.logLevel = "error";
					resolve(ort);
				};
				script.onerror = () => {
					script.remove();
					reject(Error("无法加载本机语音检测资源，请检查插件安装"));
				};
				document.head.append(script);
			}).catch((error) => {
				runtime = void 0;
				throw error;
			});
		}
		async function loadVadModel() {
			const ort = await loadRuntime();
			const session = await ort.InferenceSession.create(VAD_ASSETS + "silero_vad_v5.onnx", {
				executionProviders: ["wasm"],
				graphOptimizationLevel: "all"
			});
			const sr = new ort.Tensor("int64", new BigInt64Array([16000n]));
			const state = () => new ort.Tensor("float32", /* @__PURE__ */ new Float32Array(256), [
				2,
				1,
				128
			]);
			let hidden = state(), context = /* @__PURE__ */ new Float32Array(64);
			return {
				async process(frame) {
					const data = /* @__PURE__ */ new Float32Array(576);
					data.set(context);
					data.set(frame, 64);
					const input = new ort.Tensor("float32", data, [1, 576]);
					let output;
					try {
						output = await session.run({
							input,
							state: hidden,
							sr
						});
						if (!output.stateN || !output.output) throw Error("语音检测模型返回不完整");
						const probability = Number(output.output.data[0]);
						if (!Number.isFinite(probability)) throw Error("语音检测模型返回无效概率");
						hidden.dispose();
						hidden = output.stateN;
						context = frame.slice(-64);
						return probability;
					} finally {
						input.dispose();
						output?.output?.dispose();
					}
				},
				reset() {
					hidden.dispose();
					hidden = state();
					context.fill(0);
				},
				async dispose() {
					await session.release();
					hidden.dispose();
					sr.dispose();
				}
			};
		}
		//#endregion
		//#region lib/types/client/vad-turn.js
		var SpeechTurn = class {
			options;
			preRoll = [];
			frames = [];
			candidateFrames = [];
			positiveMs = 0;
			gapMs = 0;
			quietMs = 0;
			active = false;
			constructor(options) {
				this.options = options;
			}
			push(frame, probability) {
				const ms = frame.length / 16;
				const playback = this.options.isPlayback?.() ?? false;
				const positive = probability >= (playback ? .7 : .5);
				if (!this.active) {
					if (this.candidateFrames.length) this.candidateFrames.push(frame);
					if (this.candidateFrames.length * ms >= 24e3) this.candidateFrames = [];
					this.preRoll.push(frame);
					while (this.preRoll.length > Math.ceil(800 / ms)) this.preRoll.shift();
					if (positive) {
						this.positiveMs += ms;
						this.gapMs = 0;
					} else {
						this.gapMs += ms;
						if (this.gapMs >= 128) this.positiveMs = 0;
					}
					if (!this.candidateFrames.length && this.positiveMs >= 128) this.candidateFrames = [...this.preRoll];
					if (this.gapMs >= Math.max(400, Math.min(3e3, this.options.silenceMs))) this.candidateFrames = [];
					if (this.positiveMs < (playback ? 480 : 192)) return;
					this.active = true;
					this.frames = this.preRoll.splice(0);
					this.candidateFrames = [];
					this.options.speechStart();
				} else this.frames.push(frame);
				if (probability >= .5) this.quietMs = 0;
				else if (probability < .35) this.quietMs += ms;
				if (this.quietMs >= Math.max(400, Math.min(3e3, this.options.silenceMs)) || this.frames.length * ms >= 24e3) this.flush();
			}
			flush() {
				if (!this.active) {
					if (!this.candidateFrames.length) {
						this.reset();
						return;
					}
					this.frames = this.candidateFrames;
					this.active = true;
					this.options.speechStart();
				}
				const samples = new Float32Array(this.frames.reduce((n, frame) => n + frame.length, 0));
				let offset = 0;
				for (const frame of this.frames) {
					samples.set(frame, offset);
					offset += frame.length;
				}
				this.reset();
				this.options.utterance(samples);
			}
			reset() {
				this.preRoll = [];
				this.frames = [];
				this.candidateFrames = [];
				this.positiveMs = 0;
				this.gapMs = 0;
				this.quietMs = 0;
				this.active = false;
			}
		};
		//#endregion
		//#region lib/types/client/audio.js
		/** Small PCM helpers shared by microphone capture, playback and acceptance tests. */
		function wav16(samples, sampleRate) {
			const targetRate = 16e3;
			const count = Math.floor(samples.length * targetRate / sampleRate);
			const buffer = /* @__PURE__ */ new ArrayBuffer(44 + count * 2), view = new DataView(buffer);
			const ascii = (offset, text) => [...text].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)));
			ascii(0, "RIFF");
			view.setUint32(4, 36 + count * 2, true);
			ascii(8, "WAVE");
			ascii(12, "fmt ");
			view.setUint32(16, 16, true);
			view.setUint16(20, 1, true);
			view.setUint16(22, 1, true);
			view.setUint32(24, targetRate, true);
			view.setUint32(28, targetRate * 2, true);
			view.setUint16(32, 2, true);
			view.setUint16(34, 16, true);
			ascii(36, "data");
			view.setUint32(40, count * 2, true);
			for (let i = 0; i < count; i++) {
				const from = Math.floor(i * sampleRate / targetRate), to = Math.max(from + 1, Math.floor((i + 1) * sampleRate / targetRate));
				let sum = 0;
				for (let j = from; j < to && j < samples.length; j++) sum += samples[j];
				const value = Math.max(-1, Math.min(1, sum / (to - from)));
				view.setInt16(44 + i * 2, Math.round(value * (value < 0 ? 32768 : 32767)), true);
			}
			return new Blob([buffer], { type: "audio/wav" });
		}
		var PcmDecoder = class {
			pending;
			push(bytes) {
				const data = this.pending === void 0 ? bytes : new Uint8Array([this.pending, ...bytes]);
				const usable = data.length - data.length % 2;
				this.pending = usable === data.length ? void 0 : data[data.length - 1];
				const out = new Float32Array(usable / 2), view = new DataView(data.buffer, data.byteOffset, usable);
				for (let i = 0; i < out.length; i++) out[i] = view.getInt16(i * 2, true) / 32768;
				return out;
			}
			finish() {
				if (this.pending !== void 0) throw Error("语音服务返回了不完整的 PCM 数据");
			}
		};
		var PcmPlayer = class {
			context;
			sources = /* @__PURE__ */ new Set();
			cursor = 0;
			constructor(context) {
				this.context = context;
			}
			get pendingSeconds() {
				return Math.max(0, this.cursor - this.context.currentTime);
			}
			push(samples, sampleRate) {
				if (!samples.length) return;
				const buffer = this.context.createBuffer(1, samples.length, sampleRate);
				buffer.copyToChannel(samples, 0);
				const source = this.context.createBufferSource();
				source.buffer = buffer;
				source.connect(this.context.destination);
				const start = Math.max(this.cursor, this.context.currentTime + .025);
				this.cursor = start + buffer.duration;
				this.sources.add(source);
				source.onended = () => {
					this.sources.delete(source);
					source.disconnect();
				};
				source.start(start);
			}
			stop() {
				for (const source of this.sources) {
					try {
						source.stop();
					} catch {}
					source.disconnect();
				}
				this.sources.clear();
				this.cursor = 0;
			}
		};
		var Microphone = class {
			context;
			options;
			media;
			source;
			processor;
			silent;
			model;
			closed = false;
			enabled = false;
			muted = false;
			generation = 0;
			pending = 0;
			chain = Promise.resolve();
			turn;
			constructor(context, options) {
				this.context = context;
				this.options = options;
				this.turn = new SpeechTurn({
					...options,
					utterance: (samples) => options.utterance(wav16(samples, 16e3))
				});
			}
			async start() {
				if (!navigator.mediaDevices?.getUserMedia) throw Error("当前窗口无法访问麦克风，请在 DSH 桌面版或本机安全连接中使用");
				const media = await navigator.mediaDevices.getUserMedia({
					audio: {
						echoCancellation: true,
						noiseSuppression: true,
						autoGainControl: true,
						channelCount: 1
					},
					video: false
				});
				if (this.closed) {
					media.getTracks().forEach((t) => t.stop());
					return;
				}
				this.media = media;
				for (const track of media.getAudioTracks?.() ?? media.getTracks()) track.enabled = !this.muted;
				try {
					const model = await loadVadModel();
					if (this.closed) {
						await model.dispose();
						return;
					}
					this.model = model;
					this.source = this.context.createMediaStreamSource(media);
					this.silent = this.context.createGain();
					this.silent.gain.value = 0;
					if (this.context.audioWorklet && typeof AudioWorkletNode !== "undefined") {
						await this.context.audioWorklet.addModule(VAD_ASSETS + "vad.worklet.bundle.min.js");
						if (this.closed) return;
						const node = new AudioWorkletNode(this.context, "vad-helper-worklet", { processorOptions: { frameSamples: 512 } });
						node.port.onmessage = (event) => {
							if (event.data?.data instanceof ArrayBuffer) this.capture(new Float32Array(event.data.data));
						};
						this.processor = node;
					} else {
						const node = this.context.createScriptProcessor(2048, 1, 1);
						let input = [];
						node.onaudioprocess = (event) => {
							input.push(...event.inputBuffer.getChannelData(0));
							const needed = Math.ceil(512 * this.context.sampleRate / 16e3);
							while (input.length >= needed) {
								const frame = /* @__PURE__ */ new Float32Array(512);
								for (let i = 0; i < 512; i++) {
									const from = Math.floor(i * needed / 512), to = Math.floor((i + 1) * needed / 512);
									for (let j = from; j < to; j++) frame[i] += input[j] / (to - from);
								}
								input = input.slice(needed);
								this.capture(frame);
							}
						};
						this.processor = node;
					}
					this.source.connect(this.processor);
					this.processor.connect(this.silent);
					this.silent.connect(this.context.destination);
				} catch (error) {
					this.stop();
					throw error;
				}
			}
			capture(frame) {
				if (this.closed) return;
				this.options.level(Math.sqrt(frame.reduce((sum, x) => sum + x * x, 0) / frame.length));
				const enabled = !this.muted && this.options.canListen();
				if (enabled !== this.enabled) {
					this.enabled = enabled;
					this.generation++;
					this.turn.reset();
					this.chain = this.chain.then(() => this.model?.reset());
				}
				if (!enabled) return;
				if (this.pending >= 32) {
					this.fail(Error("本机语音检测处理过慢，请关闭其他高负载程序后重试"));
					return;
				}
				const generation = this.generation;
				this.pending++;
				this.chain = this.chain.then(async () => {
					if (this.closed || this.muted || generation !== this.generation || !this.options.canListen()) return;
					const probability = await this.model.process(frame);
					if (!this.closed && !this.muted && generation === this.generation && this.options.canListen()) this.turn.push(frame, probability);
				}).catch((error) => this.fail(error)).finally(() => {
					this.pending--;
				});
			}
			setMuted(muted) {
				this.muted = muted;
				this.enabled = false;
				this.generation++;
				this.turn.reset();
				for (const track of this.media?.getTracks() ?? []) track.enabled = !muted;
				this.chain = this.chain.then(() => this.model?.reset());
				this.options.level(0);
			}
			flush() {
				const generation = this.generation;
				this.chain = this.chain.then(() => {
					if (!this.closed && !this.muted && generation === this.generation && this.options.canListen()) this.turn.flush();
				});
			}
			fail(error) {
				if (this.closed) return;
				this.stop();
				this.options.error?.(error instanceof Error ? error : Error(String(error)));
			}
			stop() {
				if (this.closed) return;
				this.closed = true;
				this.generation++;
				this.turn.reset();
				if (this.processor && "port" in this.processor) {
					this.processor.port.onmessage = null;
					this.processor.port.postMessage("SPEECH_STOP");
				} else if (this.processor) this.processor.onaudioprocess = null;
				this.processor?.disconnect();
				this.source?.disconnect();
				this.silent?.disconnect();
				this.media?.getTracks().forEach((t) => t.stop());
				const model = this.model;
				this.model = void 0;
				this.chain.finally(() => model?.dispose()).catch(() => {});
			}
		};
		//#endregion
		//#region lib/types/client/feed.js
		/** Only speak new assistant text. Never reads reasoning, tool arguments or historical messages. */
		var ReplyFeed = class {
			speak;
			end;
			seen = /* @__PURE__ */ new Set();
			streamed = /* @__PURE__ */ new Map();
			pending = "";
			baseline = -1;
			fence = false;
			turn;
			constructor(speak, end) {
				this.speak = speak;
				this.end = end;
			}
			reset(entries) {
				this.seen.clear();
				this.streamed.clear();
				this.pending = "";
				this.fence = false;
				this.turn = void 0;
				this.baseline = entries.reduce((n, { event }) => Math.max(n, event.seq), -1);
			}
			accept(snapshot) {
				if (snapshot.change.kind === "prepend") return;
				const entries = snapshot.change.kind === "append" ? snapshot.change.entries ?? [] : snapshot.change.kind === "settle-assistant" ? snapshot.change.entry ? [snapshot.change.entry] : [] : snapshot.entries;
				for (const { event } of entries) {
					if (event.seq <= this.baseline) continue;
					const key = `${event.type}:${event.seq}:${event.data?.attemptId ?? ""}`;
					if (this.seen.has(key)) continue;
					this.seen.add(key);
					if (event.type === "turn/start" && this.turn === void 0) this.turn = event.data?.turn;
					if (this.turn === void 0 || event.data?.turn !== this.turn) continue;
					const step = `${event.data?.turn}:${event.data?.step}`;
					if (event.type === "assistant/live-chunk" && event.data?.chunk?.type === "text-delta") {
						const text = event.data.chunk.text;
						if (typeof text !== "string") continue;
						this.streamed.set(step, (this.streamed.get(step) ?? "") + text);
						this.append(text);
					} else if (event.type === "assistant/message" && event.surfaceOp === "append") {
						const content = event.data?.message?.content;
						const text = Array.isArray(content) ? content.filter((b) => b.type === "text" && typeof b.text === "string").map((b) => b.text).join("") : "";
						const streamed = this.streamed.get(step) ?? "";
						if (text.startsWith(streamed)) this.append(text.slice(streamed.length));
						this.flush();
					} else if (event.type === "turn/end") {
						this.flush();
						this.end();
					}
				}
			}
			append(text) {
				this.pending += text;
				let match;
				while (match = /[。！？!?；;\n]|\.(?:\s|$)/u.exec(this.pending)) {
					const at = match.index + match[0].length;
					const part = this.pending.slice(0, at);
					this.pending = this.pending.slice(at);
					this.emit(part);
				}
				if (this.pending.length > 180) {
					const at = this.pending.slice(0, 160).lastIndexOf(" ");
					const split = at > 40 ? at : 140;
					this.emit(this.pending.slice(0, split));
					this.pending = this.pending.slice(split);
				}
			}
			flush() {
				if (this.pending.trim()) this.emit(this.pending);
				this.pending = "";
			}
			emit(text) {
				const parts = text.split("```");
				let clean = "";
				for (let i = 0; i < parts.length; i++) {
					if (!this.fence) clean += parts[i];
					if (i < parts.length - 1) this.fence = !this.fence;
				}
				clean = clean.replace(/!\[[^\]]*\]\([^)]*\)/g, "").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/https?:\/\/\S+/g, "").replace(/^[\s#>*-]+/gm, "").replace(/[`*_~]/g, "").trim();
				while (clean.length > 140) {
					const whitespace = clean.slice(0, 140).lastIndexOf(" "), at = whitespace > 50 ? whitespace : 140;
					this.speak(clean.slice(0, at).trim());
					clean = clean.slice(at).trimStart();
				}
				if (clean) this.speak(clean);
			}
		};
		//#endregion
		//#region lib/types/client/controller.js
		const API = "/api/breeze-voice";
		async function responseOrThrow(response) {
			if (!response.ok) {
				let message = `语音请求失败 (${response.status})`;
				try {
					const data = await response.json();
					message = data.error?.message ?? data.error ?? data.detail ?? message;
				} catch {}
				throw Error(String(message));
			}
			return response;
		}
		var VoiceController = class {
			binding;
			conversation;
			changed;
			state = {
				active: false,
				phase: "语音对话",
				transcript: "",
				error: "",
				level: 0,
				cold: false
			};
			context;
			mic;
			player;
			settings;
			generation = 0;
			speechAbort;
			listenAbort;
			lifetime;
			queue = [];
			speaking = false;
			transcribing = false;
			uttering = false;
			ownTurn = false;
			awaiting = false;
			canceled = Promise.resolve();
			unsubscribe;
			sessionUnsubscribe;
			lastLevelAt = 0;
			leaseId;
			leaseTimer;
			leaseCheck = false;
			feed;
			constructor(binding, conversation, changed) {
				this.binding = binding;
				this.conversation = conversation;
				this.changed = changed;
				this.feed = new ReplyFeed((text) => {
					this.queue.push(text);
					this.pump();
				}, () => {
					this.awaiting = false;
					this.ownTurn = false;
					this.refreshPhase();
				});
			}
			patch(values) {
				this.state = {
					...this.state,
					...values
				};
				this.changed(this.state);
			}
			async start() {
				if (this.state.active) return;
				if (this.binding.session.getSnapshot().running) throw Error("当前 DSH 任务仍在运行，请等它结束后开启语音对话");
				this.patch({
					active: true,
					phase: "正在连接语音服务…",
					error: "",
					transcript: "",
					reviewText: void 0,
					ready: false,
					muted: false,
					replyText: "",
					personaName: void 0,
					promptActive: false,
					startedAt: void 0
				});
				const gen = ++this.generation;
				this.lifetime = new AbortController();
				try {
					this.context = new AudioContext();
					await this.context.resume();
					this.player = new PcmPlayer(this.context);
					const [configResponse, healthResponse] = await Promise.all([fetch(`${API}/config`, { signal: this.lifetime.signal }).then(responseOrThrow), fetch(`${API}/health`, { signal: AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(25e3)]) }).then(responseOrThrow)]);
					this.settings = await configResponse.json();
					const health = await healthResponse.json();
					if (gen !== this.generation || !this.state.active) return;
					if (this.settings.asrEngine === "dsh") {
						const native = await fetch(`${API}/native-asr`, { signal: AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(1e4)]) }).then(responseOrThrow).then((r) => r.json());
						if (!native.ready) throw Error(native.message ?? "DSH 原生识别尚未准备好，请在原生语音输入设置完成准备");
						if (gen !== this.generation || !this.state.active) return;
					}
					await fetch(`${API}/service-settings`, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: "{}",
						signal: AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(25e3)])
					}).then(responseOrThrow);
					if (gen !== this.generation || !this.state.active) return;
					const cold = this.settings.asrEngine === "dsh" ? health.tts !== "ready" : health.ready === false;
					this.patch({ cold });
					if (cold) {
						this.patch({ phase: "首次加载语音模型…" });
						await fetch(`${API}/warmup`, {
							method: "POST",
							headers: { "content-type": "application/json" },
							body: "{}",
							signal: AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(18e4)])
						}).then(responseOrThrow);
						if (gen !== this.generation || !this.state.active) return;
						this.patch({ cold: false });
					}
					this.feed.reset(this.binding.eventSource.getSnapshot().entries);
					this.unsubscribe = this.binding.eventSource.subscribe(() => {
						if (this.state.active && this.ownTurn) this.feed.accept(this.binding.eventSource.getSnapshot());
					});
					this.sessionUnsubscribe = this.binding.session.subscribe(() => {
						if (this.binding.session.getSnapshot().removed) this.stop();
					});
					this.mic = new Microphone(this.context, {
						silenceMs: this.settings.silenceMs,
						threshold: this.settings.vadThreshold,
						canListen: () => this.state.active && !this.state.muted && Boolean(this.leaseId) && this.state.reviewText === void 0 && !this.transcribing && (this.settings.bargeIn || !this.speaking && !this.awaiting),
						isPlayback: () => Boolean(this.player && this.player.pendingSeconds > .03),
						error: (error) => {
							this.stop().then(() => this.patch({ error: `本机语音检测失败：${error.message}` }));
						},
						speechStart: () => this.interrupt(),
						utterance: (wav) => {
							this.transcribe(wav);
						},
						level: (level) => {
							if (performance.now() - this.lastLevelAt > 80) {
								this.lastLevelAt = performance.now();
								this.patch({ level });
							}
						}
					});
					this.patch({ phase: "请允许麦克风访问…" });
					await this.mic.start();
					if (gen !== this.generation || !this.state.active) return;
					const lease = await this.sessionAction("start");
					if (typeof lease.leaseId !== "string") throw Error("DSH 语音会话接口没有返回连接标识");
					if (gen !== this.generation || !this.state.active) {
						await this.releaseLease(lease.leaseId);
						return;
					}
					this.leaseId = lease.leaseId;
					this.leaseTimer = setInterval(() => {
						this.keepLease();
					}, 25e3);
					this.patch({
						phase: "正在听",
						ready: true,
						startedAt: Date.now(),
						personaName: lease.personaActive ? lease.personaName : void 0,
						promptActive: Boolean(lease.voicePromptActive)
					});
				} catch (e) {
					if (gen === this.generation) {
						await this.stop();
						this.patch({ error: e instanceof Error && e.name === "NotAllowedError" ? "麦克风访问被拒绝，请在系统和 DSH 权限中允许麦克风后重试。" : e instanceof Error ? e.message : "无法启动语音" });
					}
				}
			}
			async sessionAction(action, leaseId = this.leaseId) {
				return (await fetch(`${API}/session`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						action,
						sessionId: this.binding.sessionId,
						...leaseId ? { leaseId } : {}
					}),
					signal: AbortSignal.timeout(15e3),
					keepalive: action === "stop"
				}).then(responseOrThrow)).json();
			}
			async releaseLease(leaseId) {
				await this.sessionAction("stop", leaseId).catch(() => {});
			}
			async keepLease() {
				if (this.leaseCheck || !this.leaseId || !this.state.active) return;
				this.leaseCheck = true;
				const leaseId = this.leaseId;
				try {
					const lease = await this.sessionAction("keepalive", leaseId);
					if (this.leaseId === leaseId) this.patch({
						personaName: lease.personaActive ? lease.personaName : void 0,
						promptActive: Boolean(lease.voicePromptActive)
					});
				} catch (e) {
					if (this.leaseId === leaseId) {
						await this.stop();
						this.patch({ error: `语音连接已中断：${e instanceof Error ? e.message : String(e)}` });
					}
				} finally {
					this.leaseCheck = false;
				}
			}
			interrupt() {
				if (!this.state.active) return;
				this.generation++;
				this.uttering = true;
				this.speechAbort?.abort();
				this.listenAbort?.abort();
				this.player?.stop();
				this.queue = [];
				this.awaiting = false;
				this.speaking = false;
				this.transcribing = false;
				if (this.ownTurn && this.binding.session.getSnapshot().running) {
					this.canceled = this.conversation.cancel().catch((e) => {
						this.patch({ error: `停止上次回答失败：${e.message}` });
						throw e;
					});
					this.canceled.catch(() => {});
				}
				this.ownTurn = false;
				this.feed.reset(this.binding.eventSource.getSnapshot().entries);
				this.patch({
					phase: "正在听你说",
					error: ""
				});
			}
			setMuted(muted) {
				if (!this.state.active || !this.state.ready) return;
				this.mic?.setMuted(muted);
				this.uttering = false;
				this.patch({
					muted,
					level: 0
				});
				this.refreshPhase();
			}
			finishUtterance() {
				if (!this.state.muted) this.mic?.flush();
			}
			stopReply() {
				this.interrupt();
				this.uttering = false;
				this.refreshPhase();
			}
			async transcribe(wav) {
				if (!this.state.active) return;
				const gen = this.generation;
				this.uttering = false;
				this.transcribing = true;
				this.listenAbort = new AbortController();
				this.patch({ phase: "正在识别…" });
				try {
					const body = new FormData();
					body.append("file", wav, "utterance.wav");
					const data = await (await fetch(`${API}/transcriptions`, {
						method: "POST",
						body,
						signal: AbortSignal.any([this.listenAbort.signal, AbortSignal.timeout(9e4)])
					}).then(responseOrThrow)).json();
					if (gen !== this.generation || !this.state.active) return;
					const text = typeof data.text === "string" ? data.text.trim() : "";
					if (!text) {
						this.patch({ phase: "没听清，请再说一次" });
						return;
					}
					this.patch({ transcript: text });
					if (this.settings?.reviewBeforeSend) {
						this.patch({
							reviewText: text,
							phase: "确认识别内容后发送"
						});
						return;
					}
					await this.submitText(text, gen);
				} catch (e) {
					if (gen === this.generation && this.state.active) {
						this.ownTurn = false;
						this.awaiting = false;
						this.patch({ error: e instanceof Error ? e.message : "语音识别失败" });
					}
				} finally {
					if (gen === this.generation) {
						this.transcribing = false;
						this.refreshPhase();
					}
				}
			}
			setReviewText(text) {
				if (this.state.reviewText !== void 0) this.patch({ reviewText: text });
			}
			discardReview() {
				this.patch({ reviewText: void 0 });
				this.refreshPhase();
			}
			async sendReviewed() {
				const text = this.state.reviewText?.trim();
				if (!text || !this.state.active || this.transcribing) return;
				const gen = this.generation;
				this.transcribing = true;
				try {
					await this.submitText(text, gen);
					if (gen === this.generation) this.patch({
						reviewText: void 0,
						transcript: text
					});
				} catch (e) {
					if (gen === this.generation) this.patch({ error: e instanceof Error ? e.message : String(e) });
				} finally {
					if (gen === this.generation) {
						this.transcribing = false;
						this.refreshPhase();
					}
				}
			}
			async submitText(text, gen) {
				await this.canceled;
				if (gen !== this.generation || !this.state.active) return;
				if (!this.leaseId) throw Error("语音连接已结束，请重新开始");
				await this.sessionAction("keepalive");
				if (gen !== this.generation || !this.state.active) return;
				this.patch({
					phase: "DSH 正在思考…",
					error: "",
					replyText: ""
				});
				this.feed.reset(this.binding.eventSource.getSnapshot().entries);
				this.ownTurn = true;
				this.awaiting = true;
				try {
					await this.conversation.send(text);
				} catch (e) {
					this.ownTurn = false;
					this.awaiting = false;
					throw e;
				}
			}
			refreshPhase() {
				if (!this.state.active || this.uttering || this.transcribing) return;
				this.patch({ phase: this.state.reviewText !== void 0 ? "确认识别内容后发送" : this.speaking ? "正在回答" : this.awaiting ? "DSH 正在思考…" : this.state.muted ? "麦克风已静音" : "正在听" });
			}
			async pump() {
				if (this.speaking || !this.state.active || !this.queue.length) return;
				this.speaking = true;
				const gen = this.generation;
				this.speechAbort = new AbortController();
				const signal = this.speechAbort.signal;
				this.patch({ phase: this.state.cold ? "首次加载语音模型…" : "正在回答" });
				try {
					const health = await (await fetch(`${API}/health`, { signal: AbortSignal.any([signal, AbortSignal.timeout(25e3)]) }).then(responseOrThrow)).json();
					if (signal.aborted || gen !== this.generation) return;
					this.patch({
						cold: health.tts === "unloaded" || health.tts === "loading",
						phase: health.tts === "unloaded" || health.tts === "loading" ? "正在重新加载语音模型…" : "正在回答"
					});
					while (this.queue.length && this.state.active && !signal.aborted && gen === this.generation) {
						const input = this.queue.shift();
						this.patch({ replyText: input });
						const response = await fetch(`${API}/speech`, {
							method: "POST",
							headers: { "content-type": "application/json" },
							body: JSON.stringify({ input }),
							signal: AbortSignal.any([signal, AbortSignal.timeout(18e4)])
						}).then(responseOrThrow);
						if (!response.body) throw Error("语音服务没有返回音频流");
						const sampleRate = Number(response.headers.get("x-sample-rate") ?? 24e3);
						if (!Number.isFinite(sampleRate) || sampleRate < 8e3 || sampleRate > 96e3) throw Error("语音采样率无效");
						const reader = response.body.getReader(), decoder = new PcmDecoder();
						try {
							while (true) {
								const { value, done } = await reader.read();
								if (done) break;
								if (signal.aborted || gen !== this.generation) {
									await reader.cancel();
									break;
								}
								this.patch({
									cold: false,
									phase: "正在回答"
								});
								this.player.push(decoder.push(value), sampleRate);
								while (this.player.pendingSeconds > 2 && !signal.aborted) await new Promise((r) => setTimeout(r, 50));
							}
							if (!signal.aborted) decoder.finish();
						} finally {
							reader.releaseLock();
						}
					}
					while (this.player.pendingSeconds > .03 && !signal.aborted && gen === this.generation) await new Promise((r) => setTimeout(r, 50));
				} catch (e) {
					if (!signal.aborted && gen === this.generation) {
						this.queue = [];
						this.player?.stop();
						this.patch({ error: e instanceof Error ? e.message : "播放失败" });
					}
				} finally {
					if (gen === this.generation) {
						this.speaking = false;
						this.refreshPhase();
						if (this.queue.length) this.pump();
					}
				}
			}
			async stop() {
				this.generation++;
				this.lifetime?.abort();
				this.listenAbort?.abort();
				this.speechAbort?.abort();
				this.mic?.stop();
				this.player?.stop();
				this.queue = [];
				this.unsubscribe?.();
				this.sessionUnsubscribe?.();
				clearInterval(this.leaseTimer);
				this.leaseTimer = void 0;
				const leaseId = this.leaseId;
				this.leaseId = void 0;
				await this.context?.close().catch(() => {});
				this.context = void 0;
				this.mic = void 0;
				this.player = void 0;
				this.speaking = false;
				this.transcribing = false;
				this.ownTurn = false;
				this.awaiting = false;
				this.uttering = false;
				this.patch({
					active: false,
					phase: "语音对话",
					level: 0,
					reviewText: void 0,
					ready: false,
					muted: false,
					promptActive: false,
					personaName: void 0,
					startedAt: void 0
				});
				if (leaseId) await this.releaseLease(leaseId);
			}
		};
		//#endregion
		//#region lib/types/client/preview.js
		/** Auditions the draft description without changing persisted voice settings. */
		var VoicePreview = class {
			abort;
			context;
			player;
			async play(input, instruction, onPhase, voiceId) {
				await this.stop();
				const abort = new AbortController();
				this.abort = abort;
				const context = new AudioContext();
				this.context = context;
				const player = new PcmPlayer(context);
				this.player = player;
				try {
					await context.resume();
					onPhase("正在生成试听…");
					const response = await fetch(`${API}/preview`, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({
							input,
							instruction,
							...voiceId ? { voiceId } : {}
						}),
						signal: AbortSignal.any([abort.signal, AbortSignal.timeout(18e4)])
					}).then(responseOrThrow);
					if (!response.body) throw Error("服务没有返回试听音频");
					const rate = Number(response.headers.get("x-sample-rate") ?? 24e3);
					if (!Number.isFinite(rate) || rate < 8e3 || rate > 96e3) throw Error("试听采样率无效");
					const reader = response.body.getReader(), decoder = new PcmDecoder();
					try {
						while (true) {
							const { value, done } = await reader.read();
							if (done) break;
							if (abort.signal.aborted) {
								await reader.cancel();
								break;
							}
							onPhase("正在播放");
							player.push(decoder.push(value), rate);
							while (player.pendingSeconds > 2 && !abort.signal.aborted) await new Promise((r) => setTimeout(r, 40));
						}
						if (!abort.signal.aborted) decoder.finish();
					} finally {
						reader.releaseLock();
					}
					while (player.pendingSeconds > .03 && !abort.signal.aborted) await new Promise((r) => setTimeout(r, 40));
					if (!abort.signal.aborted) onPhase("试听完成");
				} catch (e) {
					if (!abort.signal.aborted) throw e;
				} finally {
					player.stop();
					await context.close().catch(() => {});
					if (this.abort === abort) {
						this.abort = void 0;
						this.context = void 0;
						this.player = void 0;
					}
				}
			}
			async stop() {
				this.abort?.abort();
				this.player?.stop();
				await this.context?.close().catch(() => {});
				this.abort = void 0;
				this.context = void 0;
				this.player = void 0;
			}
		};
		//#endregion
		//#region lib/types/client/workbench-style.js
		/** Use the host's semantic tokens, including its active light/dark theme. */
		const WORKBENCH_STYLE = `
.bv-page{--bv-ink:var(--dsw-alias-label-primary,#171717);--bv-muted:var(--dsw-alias-label-secondary,#626262);--bv-line:var(--dsw-alias-border-l2,#e5e5e5);--bv-surface:var(--dsw-alias-bg-base,#fff);--bv-field:var(--dsw-specific-input-major,#fff);--bv-accent:var(--dsw-alias-state-business-primary,#4d6bfe);height:100%;box-sizing:border-box;overflow:auto;color:var(--bv-ink);background:var(--bv-surface);font-family:inherit;font-size:13px;line-height:1.55;padding:0 clamp(24px,4vw,48px) 48px}
.bv-page *{box-sizing:border-box}.bv-inner{max-width:960px;margin:0 auto}.bv-header{display:flex;gap:16px;align-items:flex-start;justify-content:space-between;padding-top:28px;margin-bottom:24px}[data-platform=darwin] .bv-header{padding-top:calc(28px + var(--dsh-frame-top-clearance,0px))}.bv-header h1{font-size:20px;line-height:28px;margin:0;font-weight:500;letter-spacing:normal}.bv-header p{margin:4px 0 0;color:var(--bv-muted);font-size:13px;line-height:20px}.bv-save-group{display:flex;align-items:center;gap:12px;flex-shrink:0}.bv-dirty{font-size:12px;color:var(--bv-muted)}
.bv-button{appearance:none;cursor:pointer;border:.5px solid var(--dsw-alias-border-l3,var(--bv-line));border-radius:var(--dsw-radius-md,10px);background:transparent;color:var(--bv-ink);padding:6px 12px;min-height:32px;font:inherit;font-size:13px;line-height:20px;display:inline-flex;gap:6px;align-items:center;justify-content:center;white-space:nowrap}.bv-button:hover:not(:disabled){background:var(--dsw-specific-selector,#f3f3f3)}.bv-button:disabled{opacity:.45;cursor:default}.bv-button-primary{color:var(--dsw-alias-label-primary-foreground,#fff);background:var(--dsw-alias-button-primary-fill,#171717);border-color:transparent}.bv-button-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover,#333)}.bv-button-danger{color:var(--dsw-alias-state-error-primary,#ba3838)}.bv-button svg{flex:none}.bv-page :is(button,input,textarea,select,summary):focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--bv-accent));outline-offset:3px}
.bv-statusbar{display:flex;align-items:center;flex-wrap:wrap;gap:8px;min-height:32px;margin:0 0 24px;font-size:12px;color:var(--bv-muted)}.bv-statusbar strong{font-weight:400}.bv-statusbar>.bv-muted{margin-right:auto}.bv-statusbar .bv-button{border:0;padding:4px 6px;min-height:28px;font-size:12px}.bv-statusdot{height:6px;width:6px;border-radius:50%;background:var(--dsw-alias-label-tertiary,#888);flex:none}.bv-statusdot.ready{background:var(--dsw-alias-state-success-primary,#23834a)}.bv-statusdot.busy{background:var(--dsw-alias-state-warning-primary,#ad7100)}
.bv-tabs{display:flex;gap:2px;width:fit-content;max-width:100%;padding:4px;margin-bottom:28px;border-radius:var(--dsw-radius-lg,12px);background:var(--dsw-specific-selector,#f1f1f1);overflow-x:auto}.bv-tab{border:.5px solid transparent;background:none;color:var(--bv-muted);font:inherit;font-size:13px;line-height:20px;padding:6px 18px;border-radius:var(--dsw-radius-md,9px);cursor:pointer;white-space:nowrap;display:flex;align-items:center;justify-content:center;gap:6px}.bv-tab[aria-selected=true]{color:var(--bv-ink);background:var(--dsw-alias-bg-layer-1,#fff);border-color:var(--dsw-alias-border-l3,#ddd);font-weight:500}.bv-tab:hover:not([aria-selected=true]){color:var(--bv-ink)}
.bv-grid{display:flex;flex-direction:column;gap:28px}.bv-grid>div,.bv-grid>section,.bv-grid>aside{width:100%;min-width:0}.bv-card{background:transparent;border:0;padding:0;min-width:0}.bv-card+.bv-card{border-top:.5px solid var(--bv-line);margin-top:28px;padding-top:28px}.bv-card h2,.bv-section-title{font-size:14px;line-height:22px;font-weight:500;margin:0 0 4px}.bv-card h3{font-size:13px;margin:0 0 4px;font-weight:500}.bv-muted{color:var(--bv-muted);font-size:12px}.bv-card p{margin:4px 0 16px}.bv-section-head{display:flex;justify-content:space-between;align-items:center;gap:16px}.bv-section-head h2{margin:0}.bv-section-head p{margin-bottom:0}.bv-form-body{max-width:680px}.bv-field{display:block;margin-top:16px;font-size:13px;font-weight:400}.bv-field input,.bv-field textarea,.bv-field select{display:block;width:100%;min-width:0;border:.5px solid var(--dsw-alias-border-l3,var(--bv-line));border-radius:var(--dsw-radius-md,10px);background:var(--bv-field);color:var(--bv-ink);font:inherit;font-weight:400;padding:8px 12px;margin-top:6px;line-height:20px}.bv-field textarea{resize:vertical;min-height:84px}.bv-field input[type=number]{max-width:180px}.bv-help{display:block;margin-top:6px;color:var(--bv-muted);font-size:12px;font-weight:400}.bv-field-row{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:20px}.bv-actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:16px}.bv-divider{height:.5px;background:var(--bv-line);margin:24px 0}.bv-preview{margin-top:20px}.bv-preview-toolbar{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-top:12px}.bv-preview-toolbar p{margin:0}.bv-preview-title{font-weight:500}.bv-fold{border-top:.5px solid var(--bv-line);margin-top:28px;padding-top:20px}.bv-fold>summary{cursor:pointer;list-style:none;display:flex;justify-content:space-between;align-items:center;gap:16px;font-size:14px;font-weight:500;min-height:32px}.bv-fold>summary::-webkit-details-marker{display:none}.bv-fold>summary:after{content:'›';font-size:22px;font-weight:400;color:var(--bv-muted);transition:transform .15s}.bv-fold[open]>summary:after{transform:rotate(90deg)}.bv-fold>summary small{display:block;font-size:12px;font-weight:400;color:var(--bv-muted);margin-top:2px}.bv-fold-body{padding-top:12px}.bv-voice-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;margin:16px 0}.bv-voice-card{border:.5px solid var(--dsw-alias-border-l3,var(--bv-line));background:transparent;color:inherit;border-radius:var(--dsw-radius-md,10px);padding:10px 12px;text-align:left;cursor:pointer;font:inherit;min-width:0}.bv-voice-card:hover{background:var(--dsw-specific-selector,#f3f3f3)}.bv-voice-card[aria-checked=true]{border-color:var(--bv-ink);background:var(--dsw-specific-selector,#f3f3f3)}.bv-voice-name{font-size:13px;font-weight:500;display:block;overflow-wrap:anywhere}.bv-voice-tag{font-size:11px;color:var(--bv-muted);display:block;margin-top:2px}
.bv-switchline{display:flex;gap:20px;align-items:center;justify-content:space-between;border-bottom:.5px solid var(--bv-line);padding:14px 0;margin:0;font-size:13px;cursor:pointer}.bv-switchline>span{order:0;flex:1}.bv-switchline input{appearance:none;order:1;width:36px;height:20px;border:0;border-radius:20px;flex:none;margin:0;cursor:pointer;background:var(--dsw-specific-selector,#ddd);position:relative;transition:background .15s}.bv-switchline input:before{content:'';position:absolute;width:16px;height:16px;top:2px;left:2px;border-radius:50%;background:var(--dsw-alias-label-tertiary,#888);transition:transform .15s}.bv-switchline input:checked{background:var(--dsw-alias-button-primary-fill,#171717)}.bv-switchline input:checked:before{transform:translateX(16px);background:var(--dsw-alias-label-primary-foreground,#fff)}.bv-switchline small{display:block;font-size:12px;color:var(--bv-muted);font-weight:400;margin-top:3px}.bv-chiprow{display:flex;gap:6px;flex-wrap:wrap;margin:12px 0}.bv-chip{font:inherit;border:.5px solid var(--dsw-alias-border-l3,var(--bv-line));border-radius:8px;background:transparent;color:var(--bv-muted);font-size:12px;cursor:pointer;padding:4px 10px}.bv-chip:hover{background:var(--dsw-specific-selector,#f3f3f3);color:var(--bv-ink)}.bv-prompt-preview{font-size:13px;line-height:1.7;white-space:pre-wrap;max-height:390px;overflow:auto;color:var(--bv-muted);overflow-wrap:anywhere}.bv-kv{display:flex;justify-content:space-between;gap:16px;padding:10px 0;border-bottom:.5px solid var(--bv-line);font-size:13px;max-width:680px}.bv-kv:last-child{border:0}.bv-kv span{color:var(--bv-muted)}.bv-kv strong{font-weight:400;text-align:right;overflow-wrap:anywhere}.bv-notice{font-size:13px;border-radius:8px;padding:10px 12px;background:var(--dsw-specific-selector,#f3f3f3);color:var(--bv-ink);margin:16px 0;overflow-wrap:anywhere}.bv-notice.error{color:var(--dsw-alias-state-error-primary,#ba3838)}.bv-empty{font-size:12px;color:var(--bv-muted);padding:12px 0}.bv-compact{padding:0;max-width:100%;height:auto;background:transparent}.bv-compact .bv-header{padding-top:0}.bv-compact .bv-header h1{font-size:16px}.bv-compact .bv-dirty{display:none}
@media(max-width:640px){.bv-page{padding:0 20px 32px}.bv-header{flex-wrap:wrap;padding-top:24px;gap:12px}.bv-save-group{margin-left:auto}.bv-dirty{display:none}.bv-tabs{width:100%}.bv-tab{flex:1;padding:6px 10px}.bv-tab svg{display:none}.bv-field-row{grid-template-columns:minmax(0,1fr);gap:0}.bv-voice-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.bv-statusbar>.bv-muted{flex-basis:calc(100% - 24px)}.bv-statusbar>.bv-button{margin-left:14px}.bv-compact{padding:0}.bv-section-head{align-items:flex-start}}
@media(prefers-reduced-motion:reduce){.bv-page *{transition:none!important}}
`;
		//#endregion
		//#region lib/types/client/workbench.js
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
		const labels = [
			{
				id: "voice",
				label: "音色",
				icon: "voice"
			},
			{
				id: "persona",
				label: "对话角色",
				icon: "person"
			},
			{
				id: "interaction",
				label: "交互与资源",
				icon: "sliders"
			},
			{
				id: "connection",
				label: "服务连接",
				icon: "server"
			}
		];
		function VoiceIcon({ size = 16 }) {
			return (0, react_jsx_runtime.jsx)(Icon, {
				name: "voice",
				size
			});
		}
		function Icon({ name, size = 16 }) {
			return (0, react_jsx_runtime.jsx)("svg", {
				width: size,
				height: size,
				viewBox: "0 0 24 24",
				fill: "none",
				stroke: "currentColor",
				strokeWidth: "1.6",
				strokeLinecap: "round",
				strokeLinejoin: "round",
				"aria-hidden": "true",
				children: name === "voice" ? (0, react_jsx_runtime.jsx)(react_jsx_runtime.Fragment, { children: (0, react_jsx_runtime.jsx)("path", { d: "M5 9v6m4-10v14m3-17v20m3-17v14m4-10v6" }) }) : name === "person" ? (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [(0, react_jsx_runtime.jsx)("circle", {
					cx: "12",
					cy: "8",
					r: "4"
				}), (0, react_jsx_runtime.jsx)("path", { d: "M5 21v-2a7 7 0 0 1 14 0v2" })] }) : name === "sliders" ? (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
					(0, react_jsx_runtime.jsx)("path", { d: "M4 7h16M4 17h16" }),
					(0, react_jsx_runtime.jsx)("circle", {
						cx: "9",
						cy: "7",
						r: "3",
						fill: "var(--bv-surface,#fff)"
					}),
					(0, react_jsx_runtime.jsx)("circle", {
						cx: "16",
						cy: "17",
						r: "3",
						fill: "var(--bv-surface,#fff)"
					})
				] }) : name === "play" ? (0, react_jsx_runtime.jsx)("path", { d: "m8 4 12 8-12 8Z" }) : name === "stop" ? (0, react_jsx_runtime.jsx)("rect", {
					x: "5",
					y: "5",
					width: "14",
					height: "14",
					rx: "2"
				}) : name === "refresh" ? (0, react_jsx_runtime.jsx)(react_jsx_runtime.Fragment, { children: (0, react_jsx_runtime.jsx)("path", { d: "M20 8a8 8 0 1 0 0 8M20 3v5h-5" }) }) : (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
					(0, react_jsx_runtime.jsx)("rect", {
						x: "4",
						y: "3",
						width: "16",
						height: "7",
						rx: "2"
					}),
					(0, react_jsx_runtime.jsx)("rect", {
						x: "4",
						y: "14",
						width: "16",
						height: "7",
						rx: "2"
					}),
					(0, react_jsx_runtime.jsx)("path", { d: "M8 6.5h.01M8 17.5h.01M13 6.5h4M13 17.5h4" })
				] })
			});
		}
		function modelLabel(value) {
			return value === "ready" ? "已加载" : value === "loading" ? "加载中" : value === "failed" ? "加载失败" : value === "unloaded" ? "未加载" : "尚未检测";
		}
		function minutesLabel(seconds) {
			return seconds === void 0 ? "尚未同步" : seconds === 0 ? "不自动卸载" : `${seconds / 60} 分钟`;
		}
		function validateDraft(value) {
			if (!Number.isInteger(value.idleMinutes) || value.idleMinutes < 0 || value.idleMinutes > 120) throw Error("空闲卸载时间请输入 0–120 分钟的整数");
			if (!Number.isFinite(value.silenceMs) || value.silenceMs < 400 || value.silenceMs > 3e3) throw Error("自动发送停顿请输入 400–3000 毫秒");
			if (!Number.isFinite(value.vadThreshold) || value.vadThreshold < .005 || value.vadThreshold > .2) throw Error("音量阈值请输入 0.005–0.2");
			if (value.instruction.length > 1e3 || value.voicePrompt.length > 6e3 || value.personaPrompt.length > 6e3) throw Error("描述或提示词超过允许长度");
			if (value.voiceProfiles.length > 40) throw Error("最多保存 40 个音色");
		}
		function VoiceWorkbench({ scope, compact = false }) {
			const [tab, setTab] = (0, react.useState)("voice");
			const [value, setValue] = (0, react.useState)(() => ({
				...defaults,
				...scope?.getSnapshot().value
			}));
			const [dirty, setDirty] = (0, react.useState)({});
			const dirtyRef = (0, react.useRef)(dirty);
			dirtyRef.current = dirty;
			const revision = (0, react.useRef)();
			const [busy, setBusy] = (0, react.useState)(false), [notice, setNotice] = (0, react.useState)(""), [error, setError] = (0, react.useState)(false);
			const [health, setHealth] = (0, react.useState)(), [checking, setChecking] = (0, react.useState)(false), [connectionError, setConnectionError] = (0, react.useState)("");
			const [nativeAsr, setNativeAsr] = (0, react.useState)(), [nativeChecking, setNativeChecking] = (0, react.useState)(false);
			const [serverVoices, setServerVoices] = (0, react.useState)([]), [serverDefault, setServerDefault] = (0, react.useState)(""), [voicesBusy, setVoicesBusy] = (0, react.useState)(false);
			const [voiceName, setVoiceName] = (0, react.useState)(""), [sample, setSample] = (0, react.useState)("你好，我在听。今天想一起完成什么？我们可以慢慢聊，也可以直接开始。");
			const [previewing, setPreviewing] = (0, react.useState)(false), [previewPhase, setPreviewPhase] = (0, react.useState)(""), [previewError, setPreviewError] = (0, react.useState)("");
			const preview = (0, react.useRef)(new VoicePreview());
			const previewGeneration = (0, react.useRef)(0);
			(0, react.useEffect)(() => scope?.subscribe(() => {
				const next = scope.getSnapshot();
				setValue((old) => ({
					...defaults,
					...next.value,
					...Object.fromEntries(Object.keys(dirtyRef.current).map((k) => [k, old[k]]))
				}));
			}), [scope]);
			(0, react.useEffect)(() => () => {
				previewGeneration.current++;
				preview.current.stop();
			}, []);
			const change = (key, v) => {
				if (!Object.keys(dirtyRef.current).length) revision.current = scope?.getSnapshot().revision;
				setValue((s) => ({
					...s,
					[key]: v
				}));
				setDirty((s) => ({
					...s,
					[key]: v
				}));
				setNotice("");
			};
			const changes = (patch) => {
				if (!Object.keys(dirtyRef.current).length) revision.current = scope?.getSnapshot().revision;
				setValue((s) => ({
					...s,
					...patch
				}));
				setDirty((s) => ({
					...s,
					...patch
				}));
				setNotice("");
			};
			async function healthCheck() {
				setChecking(true);
				setConnectionError("");
				try {
					const result = await (await fetch(`${API}/health`, { signal: AbortSignal.timeout(3e4) }).then(responseOrThrow)).json();
					setHealth(result);
					return result;
				} catch (e) {
					setConnectionError(e instanceof Error ? e.message : String(e));
					return;
				} finally {
					setChecking(false);
				}
			}
			async function syncService() {
				return (await fetch(`${API}/service-settings`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: "{}",
					signal: AbortSignal.timeout(3e4)
				}).then(responseOrThrow)).json();
			}
			async function save() {
				setBusy(true);
				setNotice("");
				setError(false);
				let localSaved = false;
				try {
					if (!scope) throw Error("DSH 配置服务尚未就绪，请重新打开语音页面");
					validateDraft(value);
					const updates = Object.entries(dirty);
					if (updates.length) {
						if (!await scope.mutate(updates.map(([key, v]) => ({
							op: "set",
							path: [key],
							value: v
						})), revision.current)) throw Error("设置已被其他窗口修改，请重新打开页面核对后保存");
					}
					localSaved = true;
					setDirty({});
					revision.current = void 0;
					setValue({
						...defaults,
						...scope.getSnapshot().value
					});
					const synced = await syncService();
					setHealth((old) => old ? {
						...old,
						...synced
					} : old);
					setNotice("已保存，服务器空闲设置已同步。音色与角色从下一次回复生效；麦克风参数在下次开启语音时生效。");
				} catch (e) {
					setError(true);
					setNotice(`${localSaved ? "本机已保存，服务器同步失败：" : ""}${e instanceof Error ? e.message : String(e)}`);
				} finally {
					setBusy(false);
				}
			}
			async function audition() {
				if (previewing) {
					previewGeneration.current++;
					await preview.current.stop();
					setPreviewing(false);
					setPreviewPhase("已停止");
					return;
				}
				if (!sample.trim() || sample.length > 140) {
					setPreviewError("试听文字请输入 1–140 字");
					return;
				}
				const generation = ++previewGeneration.current;
				setPreviewing(true);
				setPreviewError("");
				try {
					let voiceId = value.voiceId || serverDefault;
					if (!voiceId) {
						setPreviewPhase("正在读取默认音色…");
						const data = await (await fetch(`${API}/voices`, { signal: AbortSignal.timeout(3e4) }).then(responseOrThrow)).json();
						setServerVoices(data.voices ?? []);
						setServerDefault(data.default_voice_id ?? "");
						voiceId = data.default_voice_id ?? "";
					}
					if (generation !== previewGeneration.current) return;
					if (!voiceId) throw Error("服务器还没有固定音色，请先生成并保存一个声音。");
					await preview.current.play(sample.trim(), value.instruction.trim(), (phase) => {
						if (generation === previewGeneration.current) setPreviewPhase(phase);
					}, voiceId);
				} catch (e) {
					if (generation === previewGeneration.current) setPreviewError(e instanceof Error ? e.message : String(e));
				} finally {
					if (generation === previewGeneration.current) setPreviewing(false);
				}
			}
			async function checkNativeAsr() {
				setNativeChecking(true);
				try {
					const r = await fetch(`${API}/native-asr`, { signal: AbortSignal.timeout(1e4) }).then(responseOrThrow);
					setNativeAsr(await r.json());
				} catch (e) {
					setNativeAsr({
						available: false,
						ready: false,
						phase: "error",
						message: e instanceof Error ? e.message : String(e)
					});
				} finally {
					setNativeChecking(false);
				}
			}
			async function loadVoices() {
				setVoicesBusy(true);
				setNotice("");
				setError(false);
				try {
					const data = await (await fetch(`${API}/voices`, { signal: AbortSignal.timeout(3e4) }).then(responseOrThrow)).json();
					if (!Array.isArray(data.voices)) throw Error("服务器没有返回音色列表");
					setServerVoices(data.voices);
					setServerDefault(data.default_voice_id ?? "");
				} catch (e) {
					setError(true);
					setNotice(e instanceof Error ? e.message : String(e));
				} finally {
					setVoicesBusy(false);
				}
			}
			async function createFixedVoice() {
				if (!voiceName.trim() || !value.instruction.trim()) {
					setNotice("请先填写音色描述与名称");
					setError(true);
					return;
				}
				setVoicesBusy(true);
				setNotice("正在生成固定音色参考片段，首次可能需要加载模型…");
				setError(false);
				try {
					const data = await (await fetch(`${API}/voices`, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({
							name: voiceName.trim(),
							instruction: value.instruction.trim()
						}),
						signal: AbortSignal.timeout(18e4)
					}).then(responseOrThrow)).json();
					const voice = data.voice ?? data;
					if (!voice.id) throw Error("服务器没有返回新音色标识");
					setServerVoices((old) => [...old.filter((v) => v.id !== voice.id), voice]);
					change("voiceId", voice.id);
					setNotice("固定音色已在服务器生成。可先试听，点击「保存设置」后用于会话。");
				} catch (e) {
					setError(true);
					setNotice(e instanceof Error ? e.message : String(e));
				} finally {
					setVoicesBusy(false);
				}
			}
			function saveVoice(update = false) {
				const name = voiceName.trim();
				if (!name || name.length > 80) {
					setNotice("请填写 1–80 字的音色名称");
					setError(true);
					return;
				}
				if (!value.instruction.trim()) {
					setNotice("请先填写音色描述");
					setError(true);
					return;
				}
				const id = update ? value.activeVoiceId : `voice_${crypto.randomUUID().replaceAll("-", "")}`;
				const voice = {
					id,
					name,
					instruction: value.instruction.trim()
				};
				const profiles = update ? value.voiceProfiles.map((v) => v.id === id ? voice : v) : [...value.voiceProfiles, voice];
				if (profiles.length > 40) {
					setNotice("最多保存 40 个音色");
					setError(true);
					return;
				}
				changes({
					voiceProfiles: profiles,
					activeVoiceId: id
				});
				setNotice("描述已加入草稿，点击「保存设置」后保留。");
				setError(false);
			}
			function selectVoice(voice) {
				changes({
					activeVoiceId: voice.id,
					instruction: voice.instruction
				});
				setVoiceName(value.voiceProfiles.some((v) => v.id === voice.id) ? voice.name : "");
			}
			async function release() {
				setChecking(true);
				setNotice("");
				setError(false);
				try {
					await fetch(`${API}/release`, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: "{}",
						signal: AbortSignal.timeout(3e4)
					}).then(responseOrThrow);
					setHealth((old) => ({
						...old,
						ready: false,
						tts: "unloaded",
						asr: "unloaded",
						busy: false,
						idle_remaining_seconds: null
					}));
					setNotice("语音模型已卸载并释放显存，下次使用会重新加载。");
				} catch (e) {
					setError(true);
					setNotice(e instanceof Error ? e.message : String(e));
				} finally {
					setChecking(false);
				}
			}
			const selectedName = serverVoices.find((v) => v.id === (value.voiceId || serverDefault))?.name ?? [...VOICE_PRESETS, ...value.voiceProfiles].find((v) => v.id === value.activeVoiceId)?.name ?? (value.voiceId ? "已选固定音色" : "服务器默认音色");
			const savedSelected = value.voiceProfiles.some((v) => v.id === value.activeVoiceId);
			const effectivePrompt = [value.voicePromptEnabled && value.voicePrompt.trim() ? `【语音交流方式】\n${value.voicePrompt.trim()}` : "", value.personaEnabled && value.personaPrompt.trim() ? `【对话角色${value.personaName ? `：${value.personaName}` : ""}】\n${value.personaPrompt.trim()}` : ""].filter(Boolean).join("\n\n");
			const VoiceCard = (voice) => (0, react_jsx_runtime.jsxs)("button", {
				type: "button",
				className: "bv-voice-card",
				role: "radio",
				"aria-checked": value.activeVoiceId === voice.id,
				onClick: () => selectVoice(voice),
				children: [(0, react_jsx_runtime.jsx)("span", {
					className: "bv-voice-name",
					children: voice.name
				}), (0, react_jsx_runtime.jsx)("span", {
					className: "bv-voice-tag",
					children: voice.tag ?? "描述草稿"
				})]
			}, voice.id);
			return (0, react_jsx_runtime.jsxs)("div", {
				className: `bv-page${compact ? " bv-compact" : ""}`,
				children: [(0, react_jsx_runtime.jsx)("style", { children: WORKBENCH_STYLE }), (0, react_jsx_runtime.jsxs)("div", {
					className: "bv-inner",
					children: [
						(0, react_jsx_runtime.jsxs)("header", {
							className: "bv-header",
							children: [(0, react_jsx_runtime.jsxs)("div", { children: [(0, react_jsx_runtime.jsx)("h1", { children: "语音" }), (0, react_jsx_runtime.jsx)("p", { children: "设置音色、对话方式和语音服务。" })] }), (0, react_jsx_runtime.jsxs)("div", {
								className: "bv-save-group",
								children: [(0, react_jsx_runtime.jsx)("span", {
									className: "bv-dirty",
									children: Object.keys(dirty).length ? "有未保存的更改" : ""
								}), (0, react_jsx_runtime.jsx)("button", {
									className: "bv-button bv-button-primary",
									disabled: busy || !scope,
									onClick: () => void save(),
									children: busy ? "保存中…" : "保存设置"
								})]
							})]
						}),
						(0, react_jsx_runtime.jsxs)("div", {
							className: "bv-statusbar",
							children: [
								(0, react_jsx_runtime.jsx)("span", { className: `bv-statusdot${health?.busy ? " busy" : health ? " ready" : ""}` }),
								(0, react_jsx_runtime.jsx)("strong", { children: checking ? "正在连接…" : connectionError ? "连接失败" : health ? health.busy ? "语音服务使用中" : health.ready ? "语音服务已就绪" : "服务已连接，模型按需加载" : "私有语音服务" }),
								(0, react_jsx_runtime.jsx)("span", {
									className: "bv-muted",
									children: health ? `TTS ${modelLabel(health.tts)} · 识别 ${modelLabel(health.asr)}` : "尚未检测，不会自动加载模型"
								}),
								(0, react_jsx_runtime.jsxs)("button", {
									className: "bv-button",
									"aria-label": "检测语音服务连接",
									disabled: checking,
									onClick: () => void healthCheck(),
									children: [(0, react_jsx_runtime.jsx)(Icon, { name: "refresh" }), health ? "刷新" : "检测连接"]
								})
							]
						}),
						connectionError && (0, react_jsx_runtime.jsx)("div", {
							role: "alert",
							className: "bv-notice error",
							children: connectionError
						}),
						(0, react_jsx_runtime.jsx)("nav", {
							className: "bv-tabs",
							role: "tablist",
							"aria-label": "语音设置分类",
							children: labels.map((t) => (0, react_jsx_runtime.jsxs)("button", {
								className: "bv-tab",
								type: "button",
								role: "tab",
								id: `bv-tab-${t.id}`,
								"aria-selected": tab === t.id,
								"aria-controls": `bv-panel-${t.id}`,
								onClick: () => setTab(t.id),
								children: [(0, react_jsx_runtime.jsx)(Icon, { name: t.icon }), t.label]
							}, t.id))
						}),
						notice && (0, react_jsx_runtime.jsx)("div", {
							role: error ? "alert" : "status",
							className: `bv-notice${error ? " error" : ""}`,
							children: notice
						}),
						(0, react_jsx_runtime.jsxs)("section", {
							role: "tabpanel",
							id: `bv-panel-${tab}`,
							"aria-labelledby": `bv-tab-${tab}`,
							children: [
								tab === "voice" && (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [(0, react_jsx_runtime.jsxs)("section", {
									className: "bv-card",
									children: [(0, react_jsx_runtime.jsxs)("div", {
										className: "bv-section-head",
										children: [(0, react_jsx_runtime.jsxs)("div", { children: [(0, react_jsx_runtime.jsx)("h2", { children: "会话音色" }), (0, react_jsx_runtime.jsx)("p", {
											className: "bv-muted",
											children: "选定后保存，后续回复会使用同一个声音。"
										})] }), (0, react_jsx_runtime.jsxs)("button", {
											className: "bv-button",
											disabled: voicesBusy,
											onClick: () => void loadVoices(),
											children: [(0, react_jsx_runtime.jsx)(Icon, { name: "refresh" }), voicesBusy ? "读取中…" : "刷新音色库"]
										})]
									}), (0, react_jsx_runtime.jsxs)("div", {
										className: "bv-form-body",
										children: [(0, react_jsx_runtime.jsxs)("label", {
											className: "bv-field",
											children: ["会话使用的固定音色", (0, react_jsx_runtime.jsxs)("select", {
												value: value.voiceId,
												onChange: (e) => change("voiceId", e.target.value),
												children: [
													(0, react_jsx_runtime.jsxs)("option", {
														value: "",
														children: ["服务器默认音色", serverVoices.find((v) => v.id === serverDefault)?.name ? ` · ${serverVoices.find((v) => v.id === serverDefault).name}` : ""]
													}),
													value.voiceId && !serverVoices.some((v) => v.id === value.voiceId) && (0, react_jsx_runtime.jsxs)("option", {
														value: value.voiceId,
														children: ["已配置的音色 · ", value.voiceId]
													}),
													serverVoices.map((v) => (0, react_jsx_runtime.jsx)("option", {
														value: v.id,
														children: v.name
													}, v.id))
												]
											})]
										}), (0, react_jsx_runtime.jsxs)("div", {
											className: "bv-preview",
											children: [
												(0, react_jsx_runtime.jsxs)("label", {
													className: "bv-field",
													children: [
														"试听文字",
														(0, react_jsx_runtime.jsx)("textarea", {
															value: sample,
															maxLength: 140,
															onChange: (e) => setSample(e.target.value)
														}),
														(0, react_jsx_runtime.jsxs)("span", {
															className: "bv-help",
															children: [
																sample.length,
																" / 140 字 · 当前音色：",
																selectedName
															]
														})
													]
												}),
												(0, react_jsx_runtime.jsxs)("div", {
													className: "bv-preview-toolbar",
													children: [(0, react_jsx_runtime.jsxs)("button", {
														className: "bv-button",
														onClick: () => void audition(),
														children: [(0, react_jsx_runtime.jsx)(Icon, { name: previewing ? "stop" : "play" }), previewing ? "停止试听" : "生成并试听"]
													}), (0, react_jsx_runtime.jsx)("p", {
														className: "bv-muted",
														role: "status",
														children: previewPhase || "首次试听需要等待模型加载。"
													})]
												}),
												previewError && (0, react_jsx_runtime.jsx)("div", {
													role: "alert",
													className: "bv-notice error",
													children: previewError
												})
											]
										})]
									})]
								}), (0, react_jsx_runtime.jsxs)("details", {
									className: "bv-fold",
									children: [(0, react_jsx_runtime.jsx)("summary", { children: (0, react_jsx_runtime.jsxs)("span", { children: ["创建音色", (0, react_jsx_runtime.jsx)("small", { children: "通过描述生成一个新声音，试听后再用于对话。" })] }) }), (0, react_jsx_runtime.jsxs)("div", {
										className: "bv-fold-body",
										children: [
											(0, react_jsx_runtime.jsx)("div", {
												className: "bv-voice-grid",
												role: "radiogroup",
												"aria-label": "预设音色",
												children: VOICE_PRESETS.map(VoiceCard)
											}),
											(0, react_jsx_runtime.jsxs)("div", {
												className: "bv-form-body",
												children: [
													(0, react_jsx_runtime.jsxs)("label", {
														className: "bv-field",
														children: [
															"音色描述",
															(0, react_jsx_runtime.jsx)("textarea", {
																maxLength: 1e3,
																value: value.instruction,
																onChange: (e) => changes({
																	instruction: e.target.value,
																	activeVoiceId: savedSelected ? value.activeVoiceId : "custom"
																})
															}),
															(0, react_jsx_runtime.jsx)("span", {
																className: "bv-help",
																children: "例如：温暖的成年男声，普通话清晰，语速舒缓。修改描述后需重新生成音色。"
															})
														]
													}),
													(0, react_jsx_runtime.jsxs)("label", {
														className: "bv-field",
														children: ["新音色名称", (0, react_jsx_runtime.jsx)("input", {
															maxLength: 80,
															value: voiceName,
															onChange: (e) => setVoiceName(e.target.value),
															placeholder: "例如：我的日常搭档"
														})]
													}),
													(0, react_jsx_runtime.jsxs)("div", {
														className: "bv-actions",
														children: [
															(0, react_jsx_runtime.jsx)("button", {
																className: "bv-button bv-button-primary",
																disabled: voicesBusy,
																onClick: () => void createFixedVoice(),
																children: "生成并保存固定音色"
															}),
															(0, react_jsx_runtime.jsx)("button", {
																className: "bv-button",
																onClick: () => saveVoice(false),
																children: "保存描述草稿"
															}),
															savedSelected && (0, react_jsx_runtime.jsx)("button", {
																className: "bv-button",
																onClick: () => saveVoice(true),
																children: "更新描述草稿"
															})
														]
													})
												]
											}),
											value.voiceProfiles.length > 0 && (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
												(0, react_jsx_runtime.jsx)("div", { className: "bv-divider" }),
												(0, react_jsx_runtime.jsx)("h3", {
													className: "bv-section-title",
													children: "描述草稿"
												}),
												(0, react_jsx_runtime.jsx)("div", {
													className: "bv-voice-grid",
													role: "radiogroup",
													"aria-label": "保存的描述",
													children: value.voiceProfiles.map(VoiceCard)
												}),
												savedSelected && (0, react_jsx_runtime.jsx)("button", {
													className: "bv-button bv-button-danger",
													onClick: () => changes({
														voiceProfiles: value.voiceProfiles.filter((v) => v.id !== value.activeVoiceId),
														activeVoiceId: "custom"
													}),
													children: "移除描述草稿"
												})
											] })
										]
									})]
								})] }),
								tab === "persona" && (0, react_jsx_runtime.jsxs)("div", {
									className: "bv-grid",
									children: [(0, react_jsx_runtime.jsxs)("div", { children: [(0, react_jsx_runtime.jsxs)("section", {
										className: "bv-card",
										children: [
											(0, react_jsx_runtime.jsx)("h2", { children: "语音模式默认提示词" }),
											(0, react_jsx_runtime.jsx)("p", {
												className: "bv-muted",
												children: "决定回答如何组织，适合听而不是只适合读。"
											}),
											(0, react_jsx_runtime.jsxs)("label", {
												className: "bv-switchline",
												children: [(0, react_jsx_runtime.jsx)("input", {
													type: "checkbox",
													checked: value.voicePromptEnabled,
													onChange: (e) => change("voicePromptEnabled", e.target.checked)
												}), (0, react_jsx_runtime.jsxs)("span", { children: ["使用语音交流提示词", (0, react_jsx_runtime.jsx)("small", { children: "仅在打开语音的聊天中生效；静音或收起面板仍算通话中。" })] })]
											}),
											(0, react_jsx_runtime.jsxs)("label", {
												className: "bv-field",
												children: ["默认提示词", (0, react_jsx_runtime.jsx)("textarea", {
													style: { minHeight: 180 },
													maxLength: 6e3,
													value: value.voicePrompt,
													onChange: (e) => change("voicePrompt", e.target.value)
												})]
											}),
											(0, react_jsx_runtime.jsx)("button", {
												className: "bv-button",
												style: { marginTop: 12 },
												onClick: () => change("voicePrompt", "当前用户正在通过实时语音与你对话。请用自然、简洁、适合听的中文回答，通常先给结论，再补充必要说明。优先使用短句，避免不必要的列表、表格、代码和链接；如果用户明确需要细节，仍然完整回答。需要执行任务时继续使用当前会话的工具和审批流程，并简短说明结果。不要朗读内部推理，也不要把尚未执行的操作说成已完成。"),
												children: "恢复默认提示词"
											})
										]
									}), (0, react_jsx_runtime.jsxs)("section", {
										className: "bv-card",
										children: [
											(0, react_jsx_runtime.jsx)("h2", { children: "对话角色" }),
											(0, react_jsx_runtime.jsx)("p", {
												className: "bv-muted",
												children: "定义交流风格与关注重点。原有会话的工具和审批保持有效。"
											}),
											(0, react_jsx_runtime.jsxs)("label", {
												className: "bv-switchline",
												children: [(0, react_jsx_runtime.jsx)("input", {
													type: "checkbox",
													checked: value.personaEnabled,
													onChange: (e) => change("personaEnabled", e.target.checked)
												}), (0, react_jsx_runtime.jsxs)("span", { children: ["启用语音角色", (0, react_jsx_runtime.jsx)("small", { children: "结束通话后停止添加角色提示词；已产生的聊天记录仍保留。" })] })]
											}),
											(0, react_jsx_runtime.jsx)("div", {
												className: "bv-chiprow",
												children: PERSONA_PRESETS.map((p) => (0, react_jsx_runtime.jsx)("button", {
													className: "bv-chip",
													onClick: () => changes({
														personaEnabled: true,
														personaName: p.name,
														personaPrompt: p.prompt
													}),
													children: p.name
												}, p.name))
											}),
											(0, react_jsx_runtime.jsxs)("label", {
												className: "bv-field",
												children: ["角色名称", (0, react_jsx_runtime.jsx)("input", {
													maxLength: 80,
													value: value.personaName,
													onChange: (e) => change("personaName", e.target.value),
													placeholder: "例如：工作搭档"
												})]
											}),
											(0, react_jsx_runtime.jsxs)("label", {
												className: "bv-field",
												children: ["角色提示词", (0, react_jsx_runtime.jsx)("textarea", {
													style: { minHeight: 140 },
													maxLength: 6e3,
													value: value.personaPrompt,
													onChange: (e) => change("personaPrompt", e.target.value),
													placeholder: "你希望它以什么方式与你交流？"
												})]
											})
										]
									})] }), (0, react_jsx_runtime.jsxs)("details", {
										className: "bv-fold",
										children: [(0, react_jsx_runtime.jsx)("summary", { children: "预览当前提示词" }), (0, react_jsx_runtime.jsxs)("div", {
											className: "bv-fold-body",
											children: [
												(0, react_jsx_runtime.jsx)("p", {
													className: "bv-muted",
													children: "保存后用于后续语音回复。"
												}),
												(0, react_jsx_runtime.jsx)("div", { className: "bv-divider" }),
												(0, react_jsx_runtime.jsx)("div", {
													className: "bv-prompt-preview",
													children: effectivePrompt || "两个开关都关闭时，沿用 DSH 原有会话提示词。"
												}),
												(0, react_jsx_runtime.jsx)("div", { className: "bv-divider" }),
												(0, react_jsx_runtime.jsx)("p", {
													className: "bv-muted",
													children: "这些提示词只在语音通话期间生效。"
												})
											]
										})]
									})]
								}),
								tab === "interaction" && (0, react_jsx_runtime.jsxs)("div", {
									className: "bv-grid",
									children: [(0, react_jsx_runtime.jsxs)("div", { children: [(0, react_jsx_runtime.jsxs)("section", {
										className: "bv-card",
										children: [
											(0, react_jsx_runtime.jsx)("h2", { children: "语音识别" }),
											(0, react_jsx_runtime.jsxs)("label", {
												className: "bv-field",
												children: [
													"识别引擎",
													(0, react_jsx_runtime.jsxs)("select", {
														value: value.asrEngine,
														onChange: (e) => change("asrEngine", e.target.value),
														children: [(0, react_jsx_runtime.jsx)("option", {
															value: "server",
															children: "私有服务器识别"
														}), (0, react_jsx_runtime.jsx)("option", {
															value: "dsh",
															disabled: !nativeAsr?.ready && value.asrEngine !== "dsh",
															children: "DSH 自带 SenseVoice（本机）"
														})]
													}),
													(0, react_jsx_runtime.jsx)("span", {
														className: "bv-help",
														children: "本机识别复用 DSH 已准备的模型；只替换识别环节，录音、打断和语音回答继续由本插件处理。"
													})
												]
											}),
											(0, react_jsx_runtime.jsx)("button", {
												className: "bv-button",
												style: { marginTop: 12 },
												disabled: nativeChecking,
												onClick: () => void checkNativeAsr(),
												children: nativeChecking ? "检测中…" : "检测 DSH 原生识别"
											}),
											(0, react_jsx_runtime.jsx)("p", {
												className: "bv-muted",
												role: "status",
												children: nativeAsr?.message ?? "先在 DSH 插件中启用「语音输入」，在原生语音输入设置完成 SenseVoice 准备，再检测并选择。不会自动下载或修改原生设置。"
											}),
											(0, react_jsx_runtime.jsx)("div", { className: "bv-divider" }),
											(0, react_jsx_runtime.jsx)("h2", { children: "说话与打断" }),
											(0, react_jsx_runtime.jsx)("p", {
												className: "bv-muted",
												children: "根据停顿习惯调整。外放时可关闭自动打断，使用「打断回答」按钮。"
											}),
											(0, react_jsx_runtime.jsxs)("div", {
												className: "bv-field-row",
												children: [(0, react_jsx_runtime.jsxs)("label", {
													className: "bv-field",
													children: [
														"停顿多久自动发送",
														(0, react_jsx_runtime.jsx)("input", {
															type: "number",
															min: 400,
															max: 3e3,
															step: 100,
															value: value.silenceMs,
															onChange: (e) => change("silenceMs", Number(e.target.value))
														}),
														(0, react_jsx_runtime.jsx)("span", {
															className: "bv-help",
															children: "毫秒 · 默认 1200，较大数值可以留出思考时间。"
														})
													]
												}), (0, react_jsx_runtime.jsxs)("div", {
													className: "bv-field",
													children: ["本机语音检测", (0, react_jsx_runtime.jsx)("p", {
														className: "bv-muted",
														children: "自动区分人声与环境声音，确认你在说话后才触发打断。"
													})]
												})]
											}),
											(0, react_jsx_runtime.jsxs)("label", {
												className: "bv-switchline",
												children: [(0, react_jsx_runtime.jsx)("input", {
													type: "checkbox",
													checked: value.bargeIn,
													onChange: (e) => change("bargeIn", e.target.checked)
												}), (0, react_jsx_runtime.jsxs)("span", { children: ["允许开口打断回答", (0, react_jsx_runtime.jsx)("small", { children: "你再次开口时停止播报并取消当前语音回复。建议佩戴耳机。" })] })]
											}),
											(0, react_jsx_runtime.jsxs)("label", {
												className: "bv-switchline",
												children: [(0, react_jsx_runtime.jsx)("input", {
													type: "checkbox",
													checked: value.reviewBeforeSend,
													onChange: (e) => change("reviewBeforeSend", e.target.checked)
												}), (0, react_jsx_runtime.jsxs)("span", { children: ["发送前确认识别内容", (0, react_jsx_runtime.jsx)("small", { children: "识别后暂停收音，可以修改文字再发送，适合专有名词较多的对话。" })] })]
											}),
											(0, react_jsx_runtime.jsxs)("label", {
												className: "bv-field",
												children: [
													"中文识别热词",
													(0, react_jsx_runtime.jsx)("textarea", {
														maxLength: 2e3,
														value: value.asrHotwords,
														onChange: (e) => change("asrHotwords", e.target.value),
														placeholder: "例如：星河语音，Breeze，DSH，Qwen，住院医师"
													}),
													(0, react_jsx_runtime.jsx)("span", {
														className: "bv-help",
														children: "填写常见人名、项目名和术语，用逗号分隔。仅用于服务器识别；DSH 原生识别暂不支持传入热词。"
													})
												]
											}),
											(0, react_jsx_runtime.jsx)("p", {
												className: "bv-muted",
												children: "麦克风参数在下一次开启语音时生效。每段录音最长 24 秒。"
											})
										]
									}), (0, react_jsx_runtime.jsxs)("section", {
										className: "bv-card",
										children: [
											(0, react_jsx_runtime.jsx)("h2", { children: "空闲释放显存" }),
											(0, react_jsx_runtime.jsx)("p", {
												className: "bv-muted",
												children: "语音暂时不用时，让 GPU 腾出空间做其他工作。"
											}),
											(0, react_jsx_runtime.jsxs)("label", {
												className: "bv-field",
												children: [
													"空闲自动卸载间隔",
													(0, react_jsx_runtime.jsx)("input", {
														type: "number",
														min: 0,
														max: 120,
														step: 1,
														value: value.idleMinutes,
														onChange: (e) => change("idleMinutes", Number(e.target.value))
													}),
													(0, react_jsx_runtime.jsx)("span", {
														className: "bv-help",
														children: "分钟 · 默认 10；填写 0 表示不自动卸载。保存会同步到服务器。"
													})
												]
											}),
											(0, react_jsx_runtime.jsx)("div", {
												className: "bv-chiprow",
												children: [
													1,
													5,
													10,
													30,
													0
												].map((n) => (0, react_jsx_runtime.jsx)("button", {
													className: "bv-chip",
													onClick: () => change("idleMinutes", n),
													children: n ? `${n} 分钟` : "不自动卸载"
												}, n))
											})
										]
									})] }), (0, react_jsx_runtime.jsxs)("aside", {
										className: "bv-card",
										children: [
											(0, react_jsx_runtime.jsx)("h2", { children: "服务器资源" }),
											(0, react_jsx_runtime.jsx)("p", {
												className: "bv-muted",
												children: "读取真实网关状态，不会为了查看而加载模型。"
											}),
											(0, react_jsx_runtime.jsxs)("div", {
												className: "bv-kv",
												children: [(0, react_jsx_runtime.jsx)("span", { children: "语音合成" }), (0, react_jsx_runtime.jsx)("strong", { children: modelLabel(health?.tts) })]
											}),
											(0, react_jsx_runtime.jsxs)("div", {
												className: "bv-kv",
												children: [(0, react_jsx_runtime.jsx)("span", { children: "语音识别" }), (0, react_jsx_runtime.jsx)("strong", { children: modelLabel(health?.asr) })]
											}),
											(0, react_jsx_runtime.jsxs)("div", {
												className: "bv-kv",
												children: [(0, react_jsx_runtime.jsx)("span", { children: "服务器卸载间隔" }), (0, react_jsx_runtime.jsx)("strong", { children: minutesLabel(health?.idle_seconds) })]
											}),
											(0, react_jsx_runtime.jsxs)("div", {
												className: "bv-kv",
												children: [(0, react_jsx_runtime.jsx)("span", { children: "预计空闲卸载" }), (0, react_jsx_runtime.jsx)("strong", { children: health?.idle_remaining_seconds != null ? `${Math.ceil(health.idle_remaining_seconds / 60)} 分钟内` : "—" })]
											}),
											(0, react_jsx_runtime.jsxs)("div", {
												className: "bv-actions",
												children: [(0, react_jsx_runtime.jsx)("button", {
													className: "bv-button",
													disabled: checking,
													onClick: () => void healthCheck(),
													children: "刷新状态"
												}), (0, react_jsx_runtime.jsx)("button", {
													className: "bv-button",
													disabled: checking || health?.busy,
													onClick: () => void release(),
													children: "立即释放显存"
												})]
											}),
											(0, react_jsx_runtime.jsx)("p", {
												className: "bv-muted",
												style: { marginTop: 14 },
												children: "只卸载语音模型；服务保持可连接。正在识别或合成时不会强制中断。"
											})
										]
									})]
								}),
								tab === "connection" && (0, react_jsx_runtime.jsxs)("div", {
									className: "bv-grid",
									children: [(0, react_jsx_runtime.jsxs)("section", {
										className: "bv-card",
										children: [
											(0, react_jsx_runtime.jsx)("h2", { children: "语音服务器" }),
											(0, react_jsx_runtime.jsx)("p", {
												className: "bv-muted",
												children: "设置会继续使用已有值。SSH 隧道仅在语音需要服务时建立。"
											}),
											(0, react_jsx_runtime.jsxs)("label", {
												className: "bv-field",
												children: ["SSH 主机别名", (0, react_jsx_runtime.jsx)("input", {
													value: value.sshHost,
													onChange: (e) => change("sshHost", e.target.value),
													placeholder: "留空使用已建立的本机转发"
												})]
											}),
											(0, react_jsx_runtime.jsxs)("label", {
												className: "bv-field",
												children: ["Windows 网关任务名", (0, react_jsx_runtime.jsx)("input", {
													value: value.remoteTaskName,
													onChange: (e) => change("remoteTaskName", e.target.value),
													placeholder: "可选；连接时启动已部署的计划任务"
												})]
											}),
											(0, react_jsx_runtime.jsxs)("div", {
												className: "bv-field-row",
												children: [(0, react_jsx_runtime.jsxs)("label", {
													className: "bv-field",
													children: ["服务器端口", (0, react_jsx_runtime.jsx)("input", {
														type: "number",
														min: 1024,
														max: 65535,
														value: value.remotePort,
														onChange: (e) => change("remotePort", Number(e.target.value))
													})]
												}), (0, react_jsx_runtime.jsxs)("label", {
													className: "bv-field",
													children: ["本机转发端口", (0, react_jsx_runtime.jsx)("input", {
														type: "number",
														min: 1024,
														max: 65535,
														value: value.localPort,
														onChange: (e) => change("localPort", Number(e.target.value))
													})]
												})]
											}),
											(0, react_jsx_runtime.jsxs)("label", {
												className: "bv-field",
												children: [
													"语音服务密钥",
													(0, react_jsx_runtime.jsx)("input", {
														type: "password",
														autoComplete: "new-password",
														value: value.apiKey,
														onChange: (e) => change("apiKey", e.target.value)
													}),
													(0, react_jsx_runtime.jsx)("span", {
														className: "bv-help",
														children: "密钥保存在本机 DSH 配置中，不会写入分享的音色描述。"
													})
												]
											}),
											(0, react_jsx_runtime.jsxs)("div", {
												className: "bv-actions",
												children: [(0, react_jsx_runtime.jsx)("button", {
													className: "bv-button",
													disabled: busy,
													onClick: () => void save(),
													children: "保存并同步服务器"
												}), (0, react_jsx_runtime.jsx)("button", {
													className: "bv-button",
													disabled: checking,
													onClick: () => void healthCheck(),
													children: "测试已保存的连接"
												})]
											})
										]
									}), (0, react_jsx_runtime.jsxs)("aside", {
										className: "bv-card",
										children: [
											(0, react_jsx_runtime.jsx)("h2", { children: "如何开始" }),
											(0, react_jsx_runtime.jsxs)("div", {
												className: "bv-kv",
												children: [(0, react_jsx_runtime.jsx)("span", { children: "01" }), (0, react_jsx_runtime.jsx)("strong", { children: "保存设置并确认连接" })]
											}),
											(0, react_jsx_runtime.jsxs)("div", {
												className: "bv-kv",
												children: [(0, react_jsx_runtime.jsx)("span", { children: "02" }), (0, react_jsx_runtime.jsx)("strong", { children: "回到你正在使用的会话" })]
											}),
											(0, react_jsx_runtime.jsxs)("div", {
												className: "bv-kv",
												children: [(0, react_jsx_runtime.jsx)("span", { children: "03" }), (0, react_jsx_runtime.jsx)("strong", { children: "点击输入框旁的「语音」" })]
											}),
											(0, react_jsx_runtime.jsx)("div", { className: "bv-divider" }),
											(0, react_jsx_runtime.jsx)("p", {
												className: "bv-muted",
												children: "首次开启会预热语音模型，然后请求麦克风访问。识别文本与回答继续保存在原来的会话里。"
											}),
											(0, react_jsx_runtime.jsx)("p", {
												className: "bv-muted",
												children: "语音在你的服务器处理；DSH 的语言模型请求继续使用当前会话配置。"
											})
										]
									})]
								})
							]
						})
					]
				})]
			});
		}
		//#endregion
		//#region lib/types/client/voice-session.js
		/** One controller shared by the native composer button and its inline dock. */
		var VoiceSessionView = class {
			onDispose;
			view = {
				voice: {
					active: false,
					phase: "语音对话",
					transcript: "",
					error: "",
					level: 0,
					cold: false
				},
				open: false,
				minimized: false
			};
			listeners = /* @__PURE__ */ new Set();
			refs = 0;
			disposed = false;
			controller;
			constructor(binding, conversation, onDispose) {
				this.onDispose = onDispose;
				if (binding && conversation) this.controller = new VoiceController(binding, conversation, (voice) => this.set({ voice }));
			}
			snapshot = () => this.view;
			subscribe = (fn) => {
				this.listeners.add(fn);
				return () => {
					this.listeners.delete(fn);
				};
			};
			set(patch) {
				if (this.disposed) return;
				this.view = {
					...this.view,
					...patch
				};
				this.listeners.forEach((fn) => fn());
			}
			retain() {
				this.refs++;
				return () => {
					this.refs--;
					queueMicrotask(() => {
						if (this.refs === 0) this.dispose();
					});
				};
			}
			dispose() {
				if (this.disposed) return;
				this.disposed = true;
				this.controller?.stop();
				this.listeners.clear();
				this.onDispose();
			}
			show() {
				this.set({
					open: true,
					minimized: false
				});
			}
			minimize() {
				this.set({ minimized: true });
			}
			dismiss() {
				if (this.view.voice.active) {
					this.minimize();
					return;
				}
				this.set({ open: false });
			}
			async start() {
				this.show();
				if (!this.controller) {
					this.set({ voice: {
						...this.view.voice,
						error: "当前会话尚未就绪，请重新打开此会话"
					} });
					return;
				}
				try {
					await this.controller.start();
				} catch (e) {
					this.set({ voice: {
						...this.view.voice,
						error: e instanceof Error ? e.message : String(e)
					} });
				}
			}
			async end() {
				await this.controller?.stop();
				this.set({
					open: false,
					minimized: false
				});
			}
		};
		//#endregion
		//#region lib/types/client/call-style.js
		const callStyle = `
.bv-call{--bv-ink:var(--dsw-alias-label-primary,#242424);--bv-muted:var(--dsw-alias-label-secondary,#777);--bv-border:var(--dsw-alias-border-l2,#dedede);--bv-bg:var(--dsw-alias-bg-base,#fff);color:var(--bv-ink);background:var(--bv-bg);border:1px solid var(--bv-border);border-radius:20px;margin:0 0 12px;overflow:hidden;font:inherit;box-sizing:border-box;container-type:inline-size}
.bv-call *{box-sizing:border-box}.bv-call button{font:inherit;cursor:pointer;color:inherit}.bv-call button:disabled{opacity:.4;cursor:default}.bv-call button:focus-visible,.bv-call textarea:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#4d6bfe);outline-offset:3px}
.bv-call-head{display:flex;align-items:center;gap:10px;padding:14px 18px;font-size:13px}.bv-call-head strong{font-weight:550}.bv-call-head small{font-size:11px;color:var(--bv-muted);margin-left:auto;font-variant-numeric:tabular-nums}.bv-icon-btn{border:0;background:transparent;border-radius:8px;width:28px;height:28px;display:grid;place-items:center}.bv-call-dot{width:6px;height:6px;border-radius:50%;background:var(--bv-ink)}
.bv-call-stage{display:flex;flex-direction:column;align-items:center;text-align:center;padding:8px 24px 18px;gap:9px}.bv-call-wave{height:86px;width:180px;display:flex;align-items:center;justify-content:center;gap:7px}.bv-call-wave i{display:block;width:10px;border-radius:20px;background:var(--bv-ink);height:var(--h);transform:scaleY(var(--gain,.3));transition:transform 100ms ease;opacity:.9}.bv-call[data-mode="thinking"] .bv-call-wave i,.bv-call[data-mode="speaking"] .bv-call-wave i,.bv-call[data-mode="connecting"] .bv-call-wave i{animation:bv-breathe 1.5s ease-in-out infinite;animation-delay:var(--delay)}.bv-call[data-mode="thinking"] .bv-call-wave i,.bv-call[data-mode="connecting"] .bv-call-wave i{opacity:.35}.bv-call[data-mode="muted"] .bv-call-wave i{opacity:.2;transform:scaleY(.12)}
.bv-call-status{font-size:19px;line-height:1.4;font-weight:550;margin:0;letter-spacing:-.3px}.bv-call-hint{font-size:12px;line-height:1.6;color:var(--bv-muted);margin:0;max-width:450px}.bv-call-caption{display:grid;gap:5px;font-size:13px;line-height:1.6;max-width:600px;width:100%;max-height:96px;overflow:auto;text-align:left;overflow-wrap:anywhere;padding:10px 12px;border-radius:10px;background:var(--dsw-specific-selector,#8881)}.bv-call-caption p{margin:0}.bv-call-caption small{color:var(--bv-muted);margin-right:8px;font-size:11px}
.bv-call-controls{display:flex;justify-content:center;gap:12px;padding:0 18px 16px}.bv-call-control{border:1px solid var(--bv-border);border-radius:50%;width:46px;height:46px;display:grid;place-items:center;background:transparent}.bv-call-control[aria-pressed="true"]{background:var(--dsw-specific-selector,#8882)}.bv-call-end{background:#be3e39!important;border-color:transparent;color:white!important}.bv-call-control-wrap{display:flex;flex-direction:column;align-items:center;gap:5px;font-size:10px;color:var(--bv-muted)}.bv-call-foot{border-top:1px solid var(--bv-border);padding:9px 16px;display:flex;align-items:center;justify-content:center;gap:12px;flex-wrap:wrap;font-size:11px;color:var(--bv-muted)}.bv-call-foot button{padding:0;border:0;background:transparent;font-size:11px;text-decoration:underline;text-underline-offset:3px}
.bv-call-review{width:100%;max-width:600px;text-align:left}.bv-call-review label{font-size:12px}.bv-call-review textarea{font:inherit;width:100%;min-height:64px;max-height:150px;resize:vertical;background:transparent;color:inherit;border:1px solid var(--bv-border);border-radius:9px;padding:10px;margin:6px 0}.bv-call-text-btn{border:1px solid var(--bv-border);background:transparent;border-radius:8px;padding:6px 12px;font-size:12px!important}.bv-call-error{font-size:12px;line-height:1.5;color:#bc443d;margin:0;overflow-wrap:anywhere;max-width:560px}.bv-call-mini{display:flex;align-items:center;gap:10px;padding:10px 14px;font-size:12px}.bv-call-mini .bv-expand{flex:1;text-align:left;background:transparent;border:0;padding:4px}.bv-call-mini small{display:block;color:var(--bv-muted);margin-top:3px;font-size:10px}
@keyframes bv-breathe{0%,100%{transform:scaleY(.25)}50%{transform:scaleY(.85)}}
@media(prefers-reduced-motion:reduce){.bv-call-wave i{animation:none!important;transition:none!important;transform:scaleY(.5)}}
@container(max-width:420px){.bv-call-stage{padding:2px 14px 14px}.bv-call-wave{height:64px}.bv-call-head{padding:12px 14px}.bv-call-head small{font-size:10px}.bv-call-status{font-size:17px}.bv-call-controls{gap:10px}.bv-call-foot{gap:7px}}
`;
		//#endregion
		//#region lib/types/client/call-panel.js
		function CallIcon({ kind }) {
			return (0, react_jsx_runtime.jsx)("svg", {
				width: "19",
				height: "19",
				viewBox: "0 0 24 24",
				fill: "none",
				stroke: "currentColor",
				strokeWidth: "1.7",
				strokeLinecap: "round",
				strokeLinejoin: "round",
				"aria-hidden": "true",
				children: kind === "mic" || kind === "muted" ? (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
					(0, react_jsx_runtime.jsx)("rect", {
						x: "9",
						y: "2",
						width: "6",
						height: "12",
						rx: "3"
					}),
					(0, react_jsx_runtime.jsx)("path", { d: "M5 10v2a7 7 0 0 0 14 0v-2M12 19v3m-4 0h8" }),
					kind === "muted" && (0, react_jsx_runtime.jsx)("path", { d: "m3 3 18 18" })
				] }) : kind === "end" ? (0, react_jsx_runtime.jsx)("path", { d: "M3 14c5-5 13-5 18 0v4h-5v-4a16 16 0 0 0-8 0v4H3z" }) : kind === "stop" ? (0, react_jsx_runtime.jsx)("rect", {
					x: "6",
					y: "6",
					width: "12",
					height: "12",
					rx: "2"
				}) : kind === "close" ? (0, react_jsx_runtime.jsx)("path", { d: "m6 6 12 12M18 6 6 18" }) : kind === "expand" ? (0, react_jsx_runtime.jsx)("path", { d: "m7 14 5-5 5 5" }) : (0, react_jsx_runtime.jsx)("path", { d: "m7 10 5 5 5-5" })
			});
		}
		function useCall(view) {
			(0, react.useEffect)(() => view.retain(), [view]);
			return (0, react.useSyncExternalStore)(view.subscribe, view.snapshot, view.snapshot);
		}
		function VoiceCallButton({ view }) {
			const { voice, open, minimized } = useCall(view);
			return (0, react_jsx_runtime.jsxs)("button", {
				type: "button",
				"aria-label": voice.active ? "展开语音对话" : "开始语音对话",
				"aria-pressed": voice.active,
				onClick: () => voice.active ? view.show() : void view.start(),
				title: voice.active ? "展开当前通话" : "开始连续语音对话",
				style: {
					display: "inline-flex",
					alignItems: "center",
					gap: 5,
					border: "1px solid var(--dsw-alias-border-l2,#ddd)",
					borderRadius: 20,
					padding: "5px 10px",
					fontSize: 12,
					color: "var(--dsw-alias-label-primary,#222)",
					background: "var(--dsw-specific-selector,#f2f3f5)",
					cursor: "pointer"
				},
				children: [(0, react_jsx_runtime.jsx)(CallIcon, { kind: voice.muted ? "muted" : "mic" }), voice.active ? open && !minimized ? "通话中" : "展开语音" : "语音"]
			});
		}
		function VoiceCallPanel({ view }) {
			const { voice: s, open, minimized } = useCall(view);
			const [now, setNow] = (0, react.useState)(Date.now());
			(0, react.useEffect)(() => {
				if (!s.active) return;
				const timer = setInterval(() => setNow(Date.now()), 1e3);
				return () => clearInterval(timer);
			}, [s.active]);
			if (!open) return null;
			const seconds = s.startedAt ? Math.max(0, Math.floor((now - s.startedAt) / 1e3)) : 0;
			const clock = `${Math.floor(seconds / 60).toString().padStart(2, "0")}:${(seconds % 60).toString().padStart(2, "0")}`;
			const mode = !s.active ? "ended" : !s.ready ? "connecting" : s.phase.includes("回答") ? "speaking" : s.phase.includes("思考") || s.phase.includes("识别") ? "thinking" : s.muted ? "muted" : "listening";
			const prompt = s.personaName ? `角色：${s.personaName}` : s.promptActive ? "语音提示词已启用" : "使用当前会话设定";
			return (0, react_jsx_runtime.jsxs)("section", {
				className: "bv-call",
				role: "region",
				"aria-label": "语音通话面板",
				"data-mode": mode,
				children: [(0, react_jsx_runtime.jsx)("style", { children: callStyle }), minimized && s.active ? (0, react_jsx_runtime.jsxs)("div", {
					className: "bv-call-mini",
					children: [
						(0, react_jsx_runtime.jsx)(CallIcon, { kind: s.muted ? "muted" : "mic" }),
						(0, react_jsx_runtime.jsxs)("button", {
							className: "bv-expand",
							onClick: () => view.show(),
							"aria-label": "展开语音通话面板",
							children: [s.phase, (0, react_jsx_runtime.jsxs)("small", { children: [
								clock,
								" · 通话仍在继续",
								s.muted ? " · 麦克风已静音" : ""
							] })]
						}),
						(0, react_jsx_runtime.jsx)("button", {
							className: "bv-icon-btn",
							onClick: () => view.controller?.setMuted(!s.muted),
							"aria-label": s.muted ? "取消麦克风静音" : "静音麦克风",
							"aria-pressed": Boolean(s.muted),
							disabled: !s.ready,
							children: (0, react_jsx_runtime.jsx)(CallIcon, { kind: s.muted ? "muted" : "mic" })
						}),
						(0, react_jsx_runtime.jsx)("button", {
							className: "bv-call-control bv-call-end",
							style: {
								width: 34,
								height: 34
							},
							onClick: () => void view.end(),
							"aria-label": "结束语音对话",
							children: (0, react_jsx_runtime.jsx)(CallIcon, { kind: "end" })
						})
					]
				}) : (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
					(0, react_jsx_runtime.jsxs)("header", {
						className: "bv-call-head",
						children: [
							(0, react_jsx_runtime.jsx)("span", { className: "bv-call-dot" }),
							(0, react_jsx_runtime.jsx)("strong", { children: "语音对话" }),
							(0, react_jsx_runtime.jsx)("small", { children: s.active ? s.ready ? clock : "正在连接" : "未连接" }),
							(0, react_jsx_runtime.jsx)("button", {
								className: "bv-icon-btn",
								"aria-label": s.active ? "收起语音通话面板" : "关闭语音通话面板",
								title: s.active ? "收起面板，通话继续" : "关闭面板",
								onClick: () => view.dismiss(),
								children: (0, react_jsx_runtime.jsx)(CallIcon, { kind: s.active ? "collapse" : "close" })
							})
						]
					}),
					(0, react_jsx_runtime.jsxs)("div", {
						className: "bv-call-stage",
						children: [
							(0, react_jsx_runtime.jsx)("div", {
								className: "bv-call-wave",
								"aria-hidden": "true",
								children: [
									34,
									52,
									74,
									86,
									74,
									52,
									34
								].map((h, i) => (0, react_jsx_runtime.jsx)("i", { style: {
									"--h": `${h}px`,
									"--gain": String(.22 + Math.min(1, s.level * 10) * .78),
									"--delay": `${i * -.12}s`
								} }, i))
							}),
							(0, react_jsx_runtime.jsx)("p", {
								className: "bv-call-status",
								role: "status",
								"aria-live": "polite",
								children: s.error && !s.active ? "连接未完成" : s.phase
							}),
							(0, react_jsx_runtime.jsx)("p", {
								className: "bv-call-hint",
								children: !s.active ? "重新连接后即可继续当前聊天。" : !s.ready ? s.cold ? "首次加载模型需要稍等，准备好后开始收音。" : "正在准备语音服务与麦克风。" : s.reviewText !== void 0 ? "确认或修改识别结果后发送。" : s.muted ? "麦克风已静音，不会收取新语音。" : mode === "speaking" ? "正在为你朗读回复。" : mode === "thinking" ? "稍等，正在处理你的这句话。" : "自然地说，停顿后自动发送。"
							}),
							s.reviewText !== void 0 ? (0, react_jsx_runtime.jsxs)("div", {
								className: "bv-call-review",
								children: [(0, react_jsx_runtime.jsxs)("label", { children: ["识别内容", (0, react_jsx_runtime.jsx)("textarea", {
									"aria-label": "识别内容",
									value: s.reviewText,
									onChange: (e) => view.controller?.setReviewText(e.target.value)
								})] }), (0, react_jsx_runtime.jsxs)("div", {
									style: {
										display: "flex",
										gap: 8
									},
									children: [(0, react_jsx_runtime.jsx)("button", {
										className: "bv-call-text-btn",
										disabled: !s.reviewText.trim(),
										onClick: () => void view.controller?.sendReviewed(),
										children: "确认发送"
									}), (0, react_jsx_runtime.jsx)("button", {
										className: "bv-call-text-btn",
										onClick: () => view.controller?.discardReview(),
										children: "丢弃重说"
									})]
								})]
							}) : (s.transcript || s.replyText) && (0, react_jsx_runtime.jsxs)("div", {
								className: "bv-call-caption",
								"aria-label": "本轮语音文字",
								children: [s.transcript && (0, react_jsx_runtime.jsxs)("p", { children: [(0, react_jsx_runtime.jsx)("small", { children: "你说" }), s.transcript] }), s.replyText && (0, react_jsx_runtime.jsxs)("p", { children: [(0, react_jsx_runtime.jsx)("small", { children: mode === "speaking" ? "正在朗读" : "回复" }), s.replyText] })]
							}),
							s.error && (0, react_jsx_runtime.jsx)("p", {
								className: "bv-call-error",
								role: "alert",
								children: s.error
							})
						]
					}),
					s.active ? (0, react_jsx_runtime.jsxs)("div", {
						className: "bv-call-controls",
						children: [
							(0, react_jsx_runtime.jsxs)("div", {
								className: "bv-call-control-wrap",
								children: [(0, react_jsx_runtime.jsx)("button", {
									className: "bv-call-control",
									"aria-label": s.muted ? "取消麦克风静音" : "静音麦克风",
									"aria-pressed": Boolean(s.muted),
									disabled: !s.ready,
									onClick: () => view.controller?.setMuted(!s.muted),
									children: (0, react_jsx_runtime.jsx)(CallIcon, { kind: s.muted ? "muted" : "mic" })
								}), (0, react_jsx_runtime.jsx)("span", { children: s.muted ? "取消静音" : "静音" })]
							}),
							(0, react_jsx_runtime.jsxs)("div", {
								className: "bv-call-control-wrap",
								children: [(0, react_jsx_runtime.jsx)("button", {
									className: "bv-call-control",
									"aria-label": "打断当前回答",
									disabled: !s.ready,
									onClick: () => view.controller?.stopReply(),
									children: (0, react_jsx_runtime.jsx)(CallIcon, { kind: "stop" })
								}), (0, react_jsx_runtime.jsx)("span", { children: "打断" })]
							}),
							(0, react_jsx_runtime.jsxs)("div", {
								className: "bv-call-control-wrap",
								children: [(0, react_jsx_runtime.jsx)("button", {
									className: "bv-call-control bv-call-end",
									"aria-label": "结束语音对话",
									onClick: () => void view.end(),
									children: (0, react_jsx_runtime.jsx)(CallIcon, { kind: "end" })
								}), (0, react_jsx_runtime.jsx)("span", { children: "结束" })]
							})
						]
					}) : (0, react_jsx_runtime.jsx)("div", {
						className: "bv-call-controls",
						children: (0, react_jsx_runtime.jsx)("button", {
							className: "bv-call-text-btn",
							onClick: () => void view.start(),
							children: "重新连接"
						})
					}),
					(0, react_jsx_runtime.jsxs)("footer", {
						className: "bv-call-foot",
						children: [(0, react_jsx_runtime.jsx)("span", { children: s.active && s.ready ? prompt : "语音只连接当前聊天" }), s.active && s.ready && (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [(0, react_jsx_runtime.jsx)("span", { children: "语音提示词仅在通话期间生效" }), (0, react_jsx_runtime.jsx)("button", {
							disabled: s.muted || s.reviewText !== void 0,
							onClick: () => view.controller?.finishUtterance(),
							children: "说完了，立即发送"
						})] })]
					})
				] })]
			});
		}
		//#endregion
		//#region lib/types/client/index.js
		const inject = [
			"slots",
			"sessions",
			"conversation",
			"configForms"
		];
		function apply(ctx) {
			const slots = ctx.get("slots"), sessions = ctx.get("sessions");
			const views = /* @__PURE__ */ new Map();
			const injectView = (sessionId) => {
				let view = views.get(sessionId);
				if (!view) {
					view = new VoiceSessionView(sessions.binding(sessionId), sessions.scope(sessionId)?.get("conversation"), () => {
						if (views.get(sessionId) === view) views.delete(sessionId);
					});
					views.set(sessionId, view);
				}
				return { view };
			};
			slots.inject("conversation.input.right", () => slots.register({
				name: "conversation.input.right",
				id: "breeze-voice-microphone",
				order: 20,
				inject: injectView
			}, VoiceCallButton));
			slots.inject("conversation.input.dock", () => slots.register({
				name: "conversation.input.dock",
				id: "breeze-voice-call",
				order: 10,
				inject: injectView
			}, VoiceCallPanel));
			ctx.effect(() => () => {
				for (const view of views.values()) view.dispose();
				views.clear();
			}, "breeze-voice call views");
			const forms = ctx.get("configForms");
			slots.inject("plugins.bundle.config", () => slots.register({
				name: "plugins.bundle.config",
				key: "dsh-breeze-voice",
				inject: () => ({ scope: forms.get("breeze-voice") })
			}, VoiceSettings));
			slots.inject("main", () => slots.register({
				name: "main",
				key: "breeze-voice",
				inject: () => ({ scope: forms.get("breeze-voice") })
			}, VoiceWorkbench));
			slots.inject("sidebar.panellist", () => slots.register({
				name: "sidebar.panellist",
				id: "breeze-voice",
				order: 11,
				label: "语音"
			}, VoiceIcon));
		}
		function VoiceSettings({ scope }) {
			return (0, react_jsx_runtime.jsx)(VoiceWorkbench, {
				scope,
				compact: true
			});
		}
		//#endregion
		exports.VoiceSettings = VoiceSettings;
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

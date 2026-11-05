import { jsx as _jsx, Fragment as _Fragment, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect, useRef, useState } from 'react';
import { DEFAULT_INSTRUCTION, DEFAULT_VOICE_PROMPT, VOICE_PRESETS, PERSONA_PRESETS } from '../voice-defaults.js';
import { API, responseOrThrow } from './controller.js';
import { VoicePreview } from './preview.js';
import { WORKBENCH_STYLE } from './workbench-style.js';
const defaults = { sshHost: '', remotePort: 8870, localPort: 19889, apiKey: '', remoteTaskName: '', instruction: DEFAULT_INSTRUCTION, voiceId: '', asrHotwords: '', asrEngine: 'server', reviewBeforeSend: false, silenceMs: 1200, vadThreshold: .018, bargeIn: true, idleMinutes: 10, activeVoiceId: 'custom', voiceProfiles: [], voicePromptEnabled: true, voicePrompt: DEFAULT_VOICE_PROMPT, personaEnabled: false, personaName: '', personaPrompt: '' };
const labels = [{ id: 'voice', label: '音色', icon: 'voice' }, { id: 'persona', label: '对话角色', icon: 'person' }, { id: 'interaction', label: '交互与资源', icon: 'sliders' }, { id: 'connection', label: '服务连接', icon: 'server' }];
export function VoiceIcon({ size = 16 }) { return _jsx(Icon, { name: "voice", size: size }); }
function Icon({ name, size = 16 }) {
    return _jsx("svg", { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.6", strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true", children: name === 'voice' ? _jsx(_Fragment, { children: _jsx("path", { d: "M5 9v6m4-10v14m3-17v20m3-17v14m4-10v6" }) }) : name === 'person' ? _jsxs(_Fragment, { children: [_jsx("circle", { cx: "12", cy: "8", r: "4" }), _jsx("path", { d: "M5 21v-2a7 7 0 0 1 14 0v2" })] }) : name === 'sliders' ? _jsxs(_Fragment, { children: [_jsx("path", { d: "M4 7h16M4 17h16" }), _jsx("circle", { cx: "9", cy: "7", r: "3", fill: "var(--bv-surface,#fff)" }), _jsx("circle", { cx: "16", cy: "17", r: "3", fill: "var(--bv-surface,#fff)" })] }) : name === 'play' ? _jsx("path", { d: "m8 4 12 8-12 8Z" }) : name === 'stop' ? _jsx("rect", { x: "5", y: "5", width: "14", height: "14", rx: "2" }) : name === 'refresh' ? _jsx(_Fragment, { children: _jsx("path", { d: "M20 8a8 8 0 1 0 0 8M20 3v5h-5" }) }) : _jsxs(_Fragment, { children: [_jsx("rect", { x: "4", y: "3", width: "16", height: "7", rx: "2" }), _jsx("rect", { x: "4", y: "14", width: "16", height: "7", rx: "2" }), _jsx("path", { d: "M8 6.5h.01M8 17.5h.01M13 6.5h4M13 17.5h4" })] }) });
}
function modelLabel(value) { return value === 'ready' ? '已加载' : value === 'loading' ? '加载中' : value === 'failed' ? '加载失败' : value === 'unloaded' ? '未加载' : '尚未检测'; }
function minutesLabel(seconds) { return seconds === undefined ? '尚未同步' : seconds === 0 ? '不自动卸载' : `${seconds / 60} 分钟`; }
export function validateDraft(value) {
    if (!Number.isInteger(value.idleMinutes) || value.idleMinutes < 0 || value.idleMinutes > 120)
        throw Error('空闲卸载时间请输入 0–120 分钟的整数');
    if (!Number.isFinite(value.silenceMs) || value.silenceMs < 400 || value.silenceMs > 3000)
        throw Error('自动发送停顿请输入 400–3000 毫秒');
    if (!Number.isFinite(value.vadThreshold) || value.vadThreshold < .005 || value.vadThreshold > .2)
        throw Error('音量阈值请输入 0.005–0.2');
    if (value.instruction.length > 1000 || value.voicePrompt.length > 6000 || value.personaPrompt.length > 6000)
        throw Error('描述或提示词超过允许长度');
    if (value.voiceProfiles.length > 40)
        throw Error('最多保存 40 个音色');
}
export function VoiceWorkbench({ scope, compact = false }) {
    const [tab, setTab] = useState('voice');
    const [value, setValue] = useState(() => ({ ...defaults, ...scope?.getSnapshot().value }));
    const [dirty, setDirty] = useState({});
    const dirtyRef = useRef(dirty);
    dirtyRef.current = dirty;
    const revision = useRef();
    const [busy, setBusy] = useState(false), [notice, setNotice] = useState(''), [error, setError] = useState(false);
    const [health, setHealth] = useState(), [checking, setChecking] = useState(false), [connectionError, setConnectionError] = useState('');
    const [nativeAsr, setNativeAsr] = useState(), [nativeChecking, setNativeChecking] = useState(false);
    const [serverVoices, setServerVoices] = useState([]), [serverDefault, setServerDefault] = useState(''), [voicesBusy, setVoicesBusy] = useState(false);
    const [voiceName, setVoiceName] = useState(''), [sample, setSample] = useState('你好，我在听。今天想一起完成什么？我们可以慢慢聊，也可以直接开始。');
    const [previewing, setPreviewing] = useState(false), [previewPhase, setPreviewPhase] = useState(''), [previewError, setPreviewError] = useState('');
    const preview = useRef(new VoicePreview());
    const previewGeneration = useRef(0);
    useEffect(() => scope?.subscribe(() => { const next = scope.getSnapshot(); setValue(old => ({ ...defaults, ...next.value, ...Object.fromEntries(Object.keys(dirtyRef.current).map(k => [k, old[k]])) })); }), [scope]);
    useEffect(() => () => { previewGeneration.current++; void preview.current.stop(); }, []);
    const change = (key, v) => {
        if (!Object.keys(dirtyRef.current).length)
            revision.current = scope?.getSnapshot().revision;
        setValue(s => ({ ...s, [key]: v }));
        setDirty(s => ({ ...s, [key]: v }));
        setNotice('');
    };
    const changes = (patch) => {
        if (!Object.keys(dirtyRef.current).length)
            revision.current = scope?.getSnapshot().revision;
        setValue(s => ({ ...s, ...patch }));
        setDirty(s => ({ ...s, ...patch }));
        setNotice('');
    };
    async function healthCheck() {
        setChecking(true);
        setConnectionError('');
        try {
            const response = await fetch(`${API}/health`, { signal: AbortSignal.timeout(30000) }).then(responseOrThrow);
            const result = await response.json();
            setHealth(result);
            return result;
        }
        catch (e) {
            setConnectionError(e instanceof Error ? e.message : String(e));
            return undefined;
        }
        finally {
            setChecking(false);
        }
    }
    async function syncService() { const response = await fetch(`${API}/service-settings`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(30000) }).then(responseOrThrow); return response.json(); }
    async function save() {
        setBusy(true);
        setNotice('');
        setError(false);
        let localSaved = false;
        try {
            if (!scope)
                throw Error('DSH 配置服务尚未就绪，请重新打开语音页面');
            validateDraft(value);
            const updates = Object.entries(dirty);
            if (updates.length) {
                const ok = await scope.mutate(updates.map(([key, v]) => ({ op: 'set', path: [key], value: v })), revision.current);
                if (!ok)
                    throw Error('设置已被其他窗口修改，请重新打开页面核对后保存');
            }
            localSaved = true;
            setDirty({});
            revision.current = undefined;
            setValue({ ...defaults, ...scope.getSnapshot().value });
            const synced = await syncService();
            setHealth(old => old ? { ...old, ...synced } : old);
            setNotice('已保存，服务器空闲设置已同步。音色与角色从下一次回复生效；麦克风参数在下次开启语音时生效。');
        }
        catch (e) {
            setError(true);
            setNotice(`${localSaved ? '本机已保存，服务器同步失败：' : ''}${e instanceof Error ? e.message : String(e)}`);
        }
        finally {
            setBusy(false);
        }
    }
    async function audition() {
        if (previewing) {
            previewGeneration.current++;
            await preview.current.stop();
            setPreviewing(false);
            setPreviewPhase('已停止');
            return;
        }
        if (!sample.trim() || sample.length > 140) {
            setPreviewError('试听文字请输入 1–140 字');
            return;
        }
        const generation = ++previewGeneration.current;
        setPreviewing(true);
        setPreviewError('');
        try {
            let voiceId = value.voiceId || serverDefault;
            if (!voiceId) {
                setPreviewPhase('正在读取默认音色…');
                const r = await fetch(`${API}/voices`, { signal: AbortSignal.timeout(30000) }).then(responseOrThrow);
                const data = await r.json();
                setServerVoices(data.voices ?? []);
                setServerDefault(data.default_voice_id ?? '');
                voiceId = data.default_voice_id ?? '';
            }
            if (generation !== previewGeneration.current)
                return;
            if (!voiceId)
                throw Error('服务器还没有固定音色，请先生成并保存一个声音。');
            await preview.current.play(sample.trim(), value.instruction.trim(), phase => { if (generation === previewGeneration.current)
                setPreviewPhase(phase); }, voiceId);
        }
        catch (e) {
            if (generation === previewGeneration.current)
                setPreviewError(e instanceof Error ? e.message : String(e));
        }
        finally {
            if (generation === previewGeneration.current)
                setPreviewing(false);
        }
    }
    async function checkNativeAsr() {
        setNativeChecking(true);
        try {
            const r = await fetch(`${API}/native-asr`, { signal: AbortSignal.timeout(10000) }).then(responseOrThrow);
            setNativeAsr(await r.json());
        }
        catch (e) {
            setNativeAsr({ available: false, ready: false, phase: 'error', message: e instanceof Error ? e.message : String(e) });
        }
        finally {
            setNativeChecking(false);
        }
    }
    async function loadVoices() {
        setVoicesBusy(true);
        setNotice('');
        setError(false);
        try {
            const r = await fetch(`${API}/voices`, { signal: AbortSignal.timeout(30000) }).then(responseOrThrow);
            const data = await r.json();
            if (!Array.isArray(data.voices))
                throw Error('服务器没有返回音色列表');
            setServerVoices(data.voices);
            setServerDefault(data.default_voice_id ?? '');
        }
        catch (e) {
            setError(true);
            setNotice(e instanceof Error ? e.message : String(e));
        }
        finally {
            setVoicesBusy(false);
        }
    }
    async function createFixedVoice() {
        if (!voiceName.trim() || !value.instruction.trim()) {
            setNotice('请先填写音色描述与名称');
            setError(true);
            return;
        }
        setVoicesBusy(true);
        setNotice('正在生成固定音色参考片段，首次可能需要加载模型…');
        setError(false);
        try {
            const r = await fetch(`${API}/voices`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: voiceName.trim(), instruction: value.instruction.trim() }), signal: AbortSignal.timeout(180000) }).then(responseOrThrow);
            const data = await r.json();
            const voice = data.voice ?? data;
            if (!voice.id)
                throw Error('服务器没有返回新音色标识');
            setServerVoices(old => [...old.filter(v => v.id !== voice.id), voice]);
            change('voiceId', voice.id);
            setNotice('固定音色已在服务器生成。可先试听，点击「保存设置」后用于会话。');
        }
        catch (e) {
            setError(true);
            setNotice(e instanceof Error ? e.message : String(e));
        }
        finally {
            setVoicesBusy(false);
        }
    }
    function saveVoice(update = false) {
        const name = voiceName.trim();
        if (!name || name.length > 80) {
            setNotice('请填写 1–80 字的音色名称');
            setError(true);
            return;
        }
        if (!value.instruction.trim()) {
            setNotice('请先填写音色描述');
            setError(true);
            return;
        }
        const id = update ? value.activeVoiceId : `voice_${crypto.randomUUID().replaceAll('-', '')}`;
        const voice = { id, name, instruction: value.instruction.trim() };
        const profiles = update ? value.voiceProfiles.map(v => v.id === id ? voice : v) : [...value.voiceProfiles, voice];
        if (profiles.length > 40) {
            setNotice('最多保存 40 个音色');
            setError(true);
            return;
        }
        changes({ voiceProfiles: profiles, activeVoiceId: id });
        setNotice('描述已加入草稿，点击「保存设置」后保留。');
        setError(false);
    }
    function selectVoice(voice) { changes({ activeVoiceId: voice.id, instruction: voice.instruction }); setVoiceName(value.voiceProfiles.some(v => v.id === voice.id) ? voice.name : ''); }
    async function release() {
        setChecking(true);
        setNotice('');
        setError(false);
        try {
            await fetch(`${API}/release`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(30000) }).then(responseOrThrow);
            setHealth(old => ({ ...old, ready: false, tts: 'unloaded', asr: 'unloaded', busy: false, idle_remaining_seconds: null }));
            setNotice('语音模型已卸载并释放显存，下次使用会重新加载。');
        }
        catch (e) {
            setError(true);
            setNotice(e instanceof Error ? e.message : String(e));
        }
        finally {
            setChecking(false);
        }
    }
    const selectedName = serverVoices.find(v => v.id === (value.voiceId || serverDefault))?.name ?? [...VOICE_PRESETS, ...value.voiceProfiles].find(v => v.id === value.activeVoiceId)?.name ?? (value.voiceId ? '已选固定音色' : '服务器默认音色');
    const savedSelected = value.voiceProfiles.some(v => v.id === value.activeVoiceId);
    const effectivePrompt = [value.voicePromptEnabled && value.voicePrompt.trim() ? `【语音交流方式】\n${value.voicePrompt.trim()}` : '', value.personaEnabled && value.personaPrompt.trim() ? `【对话角色${value.personaName ? `：${value.personaName}` : ''}】\n${value.personaPrompt.trim()}` : ''].filter(Boolean).join('\n\n');
    const VoiceCard = (voice) => _jsxs("button", { type: "button", className: "bv-voice-card", role: "radio", "aria-checked": value.activeVoiceId === voice.id, onClick: () => selectVoice(voice), children: [_jsx("span", { className: "bv-voice-name", children: voice.name }), _jsx("span", { className: "bv-voice-tag", children: voice.tag ?? '描述草稿' })] }, voice.id);
    return _jsxs("div", { className: `bv-page${compact ? ' bv-compact' : ''}`, children: [_jsx("style", { children: WORKBENCH_STYLE }), _jsxs("div", { className: "bv-inner", children: [_jsxs("header", { className: "bv-header", children: [_jsxs("div", { children: [_jsx("h1", { children: "\u8BED\u97F3" }), _jsx("p", { children: "\u8BBE\u7F6E\u97F3\u8272\u3001\u5BF9\u8BDD\u65B9\u5F0F\u548C\u8BED\u97F3\u670D\u52A1\u3002" })] }), _jsxs("div", { className: "bv-save-group", children: [_jsx("span", { className: "bv-dirty", children: Object.keys(dirty).length ? '有未保存的更改' : '' }), _jsx("button", { className: "bv-button bv-button-primary", disabled: busy || !scope, onClick: () => void save(), children: busy ? '保存中…' : '保存设置' })] })] }), _jsxs("div", { className: "bv-statusbar", children: [_jsx("span", { className: `bv-statusdot${health?.busy ? ' busy' : health ? ' ready' : ''}` }), _jsx("strong", { children: checking ? '正在连接…' : connectionError ? '连接失败' : health ? health.busy ? '语音服务使用中' : health.ready ? '语音服务已就绪' : '服务已连接，模型按需加载' : '私有语音服务' }), _jsx("span", { className: "bv-muted", children: health ? `TTS ${modelLabel(health.tts)} · 识别 ${modelLabel(health.asr)}` : '尚未检测，不会自动加载模型' }), _jsxs("button", { className: "bv-button", "aria-label": "\u68C0\u6D4B\u8BED\u97F3\u670D\u52A1\u8FDE\u63A5", disabled: checking, onClick: () => void healthCheck(), children: [_jsx(Icon, { name: "refresh" }), health ? '刷新' : '检测连接'] })] }), connectionError && _jsx("div", { role: "alert", className: "bv-notice error", children: connectionError }), _jsx("nav", { className: "bv-tabs", role: "tablist", "aria-label": "\u8BED\u97F3\u8BBE\u7F6E\u5206\u7C7B", children: labels.map(t => _jsxs("button", { className: "bv-tab", type: "button", role: "tab", id: `bv-tab-${t.id}`, "aria-selected": tab === t.id, "aria-controls": `bv-panel-${t.id}`, onClick: () => setTab(t.id), children: [_jsx(Icon, { name: t.icon }), t.label] }, t.id)) }), notice && _jsx("div", { role: error ? 'alert' : 'status', className: `bv-notice${error ? ' error' : ''}`, children: notice }), _jsxs("section", { role: "tabpanel", id: `bv-panel-${tab}`, "aria-labelledby": `bv-tab-${tab}`, children: [tab === 'voice' && _jsxs(_Fragment, { children: [_jsxs("section", { className: "bv-card", children: [_jsxs("div", { className: "bv-section-head", children: [_jsxs("div", { children: [_jsx("h2", { children: "\u4F1A\u8BDD\u97F3\u8272" }), _jsx("p", { className: "bv-muted", children: "\u9009\u5B9A\u540E\u4FDD\u5B58\uFF0C\u540E\u7EED\u56DE\u590D\u4F1A\u4F7F\u7528\u540C\u4E00\u4E2A\u58F0\u97F3\u3002" })] }), _jsxs("button", { className: "bv-button", disabled: voicesBusy, onClick: () => void loadVoices(), children: [_jsx(Icon, { name: "refresh" }), voicesBusy ? '读取中…' : '刷新音色库'] })] }), _jsxs("div", { className: "bv-form-body", children: [_jsxs("label", { className: "bv-field", children: ["\u4F1A\u8BDD\u4F7F\u7528\u7684\u56FA\u5B9A\u97F3\u8272", _jsxs("select", { value: value.voiceId, onChange: e => change('voiceId', e.target.value), children: [_jsxs("option", { value: "", children: ["\u670D\u52A1\u5668\u9ED8\u8BA4\u97F3\u8272", serverVoices.find(v => v.id === serverDefault)?.name ? ` · ${serverVoices.find(v => v.id === serverDefault).name}` : ''] }), value.voiceId && !serverVoices.some(v => v.id === value.voiceId) && _jsxs("option", { value: value.voiceId, children: ["\u5DF2\u914D\u7F6E\u7684\u97F3\u8272 \u00B7 ", value.voiceId] }), serverVoices.map(v => _jsx("option", { value: v.id, children: v.name }, v.id))] })] }), _jsxs("div", { className: "bv-preview", children: [_jsxs("label", { className: "bv-field", children: ["\u8BD5\u542C\u6587\u5B57", _jsx("textarea", { value: sample, maxLength: 140, onChange: e => setSample(e.target.value) }), _jsxs("span", { className: "bv-help", children: [sample.length, " / 140 \u5B57 \u00B7 \u5F53\u524D\u97F3\u8272\uFF1A", selectedName] })] }), _jsxs("div", { className: "bv-preview-toolbar", children: [_jsxs("button", { className: "bv-button", onClick: () => void audition(), children: [_jsx(Icon, { name: previewing ? 'stop' : 'play' }), previewing ? '停止试听' : '生成并试听'] }), _jsx("p", { className: "bv-muted", role: "status", children: previewPhase || '首次试听需要等待模型加载。' })] }), previewError && _jsx("div", { role: "alert", className: "bv-notice error", children: previewError })] })] })] }), _jsxs("details", { className: "bv-fold", children: [_jsx("summary", { children: _jsxs("span", { children: ["\u521B\u5EFA\u97F3\u8272", _jsx("small", { children: "\u901A\u8FC7\u63CF\u8FF0\u751F\u6210\u4E00\u4E2A\u65B0\u58F0\u97F3\uFF0C\u8BD5\u542C\u540E\u518D\u7528\u4E8E\u5BF9\u8BDD\u3002" })] }) }), _jsxs("div", { className: "bv-fold-body", children: [_jsx("div", { className: "bv-voice-grid", role: "radiogroup", "aria-label": "\u9884\u8BBE\u97F3\u8272", children: VOICE_PRESETS.map(VoiceCard) }), _jsxs("div", { className: "bv-form-body", children: [_jsxs("label", { className: "bv-field", children: ["\u97F3\u8272\u63CF\u8FF0", _jsx("textarea", { maxLength: 1000, value: value.instruction, onChange: e => changes({ instruction: e.target.value, activeVoiceId: savedSelected ? value.activeVoiceId : 'custom' }) }), _jsx("span", { className: "bv-help", children: "\u4F8B\u5982\uFF1A\u6E29\u6696\u7684\u6210\u5E74\u7537\u58F0\uFF0C\u666E\u901A\u8BDD\u6E05\u6670\uFF0C\u8BED\u901F\u8212\u7F13\u3002\u4FEE\u6539\u63CF\u8FF0\u540E\u9700\u91CD\u65B0\u751F\u6210\u97F3\u8272\u3002" })] }), _jsxs("label", { className: "bv-field", children: ["\u65B0\u97F3\u8272\u540D\u79F0", _jsx("input", { maxLength: 80, value: voiceName, onChange: e => setVoiceName(e.target.value), placeholder: "\u4F8B\u5982\uFF1A\u6211\u7684\u65E5\u5E38\u642D\u6863" })] }), _jsxs("div", { className: "bv-actions", children: [_jsx("button", { className: "bv-button bv-button-primary", disabled: voicesBusy, onClick: () => void createFixedVoice(), children: "\u751F\u6210\u5E76\u4FDD\u5B58\u56FA\u5B9A\u97F3\u8272" }), _jsx("button", { className: "bv-button", onClick: () => saveVoice(false), children: "\u4FDD\u5B58\u63CF\u8FF0\u8349\u7A3F" }), savedSelected && _jsx("button", { className: "bv-button", onClick: () => saveVoice(true), children: "\u66F4\u65B0\u63CF\u8FF0\u8349\u7A3F" })] })] }), value.voiceProfiles.length > 0 && _jsxs(_Fragment, { children: [_jsx("div", { className: "bv-divider" }), _jsx("h3", { className: "bv-section-title", children: "\u63CF\u8FF0\u8349\u7A3F" }), _jsx("div", { className: "bv-voice-grid", role: "radiogroup", "aria-label": "\u4FDD\u5B58\u7684\u63CF\u8FF0", children: value.voiceProfiles.map(VoiceCard) }), savedSelected && _jsx("button", { className: "bv-button bv-button-danger", onClick: () => changes({ voiceProfiles: value.voiceProfiles.filter(v => v.id !== value.activeVoiceId), activeVoiceId: 'custom' }), children: "\u79FB\u9664\u63CF\u8FF0\u8349\u7A3F" })] })] })] })] }), tab === 'persona' && _jsxs("div", { className: "bv-grid", children: [_jsxs("div", { children: [_jsxs("section", { className: "bv-card", children: [_jsx("h2", { children: "\u8BED\u97F3\u6A21\u5F0F\u9ED8\u8BA4\u63D0\u793A\u8BCD" }), _jsx("p", { className: "bv-muted", children: "\u51B3\u5B9A\u56DE\u7B54\u5982\u4F55\u7EC4\u7EC7\uFF0C\u9002\u5408\u542C\u800C\u4E0D\u662F\u53EA\u9002\u5408\u8BFB\u3002" }), _jsxs("label", { className: "bv-switchline", children: [_jsx("input", { type: "checkbox", checked: value.voicePromptEnabled, onChange: e => change('voicePromptEnabled', e.target.checked) }), _jsxs("span", { children: ["\u4F7F\u7528\u8BED\u97F3\u4EA4\u6D41\u63D0\u793A\u8BCD", _jsx("small", { children: "\u4EC5\u5728\u6253\u5F00\u8BED\u97F3\u7684\u804A\u5929\u4E2D\u751F\u6548\uFF1B\u9759\u97F3\u6216\u6536\u8D77\u9762\u677F\u4ECD\u7B97\u901A\u8BDD\u4E2D\u3002" })] })] }), _jsxs("label", { className: "bv-field", children: ["\u9ED8\u8BA4\u63D0\u793A\u8BCD", _jsx("textarea", { style: { minHeight: 180 }, maxLength: 6000, value: value.voicePrompt, onChange: e => change('voicePrompt', e.target.value) })] }), _jsx("button", { className: "bv-button", style: { marginTop: 12 }, onClick: () => change('voicePrompt', DEFAULT_VOICE_PROMPT), children: "\u6062\u590D\u9ED8\u8BA4\u63D0\u793A\u8BCD" })] }), _jsxs("section", { className: "bv-card", children: [_jsx("h2", { children: "\u5BF9\u8BDD\u89D2\u8272" }), _jsx("p", { className: "bv-muted", children: "\u5B9A\u4E49\u4EA4\u6D41\u98CE\u683C\u4E0E\u5173\u6CE8\u91CD\u70B9\u3002\u539F\u6709\u4F1A\u8BDD\u7684\u5DE5\u5177\u548C\u5BA1\u6279\u4FDD\u6301\u6709\u6548\u3002" }), _jsxs("label", { className: "bv-switchline", children: [_jsx("input", { type: "checkbox", checked: value.personaEnabled, onChange: e => change('personaEnabled', e.target.checked) }), _jsxs("span", { children: ["\u542F\u7528\u8BED\u97F3\u89D2\u8272", _jsx("small", { children: "\u7ED3\u675F\u901A\u8BDD\u540E\u505C\u6B62\u6DFB\u52A0\u89D2\u8272\u63D0\u793A\u8BCD\uFF1B\u5DF2\u4EA7\u751F\u7684\u804A\u5929\u8BB0\u5F55\u4ECD\u4FDD\u7559\u3002" })] })] }), _jsx("div", { className: "bv-chiprow", children: PERSONA_PRESETS.map(p => _jsx("button", { className: "bv-chip", onClick: () => changes({ personaEnabled: true, personaName: p.name, personaPrompt: p.prompt }), children: p.name }, p.name)) }), _jsxs("label", { className: "bv-field", children: ["\u89D2\u8272\u540D\u79F0", _jsx("input", { maxLength: 80, value: value.personaName, onChange: e => change('personaName', e.target.value), placeholder: "\u4F8B\u5982\uFF1A\u5DE5\u4F5C\u642D\u6863" })] }), _jsxs("label", { className: "bv-field", children: ["\u89D2\u8272\u63D0\u793A\u8BCD", _jsx("textarea", { style: { minHeight: 140 }, maxLength: 6000, value: value.personaPrompt, onChange: e => change('personaPrompt', e.target.value), placeholder: "\u4F60\u5E0C\u671B\u5B83\u4EE5\u4EC0\u4E48\u65B9\u5F0F\u4E0E\u4F60\u4EA4\u6D41\uFF1F" })] })] })] }), _jsxs("details", { className: "bv-fold", children: [_jsx("summary", { children: "\u9884\u89C8\u5F53\u524D\u63D0\u793A\u8BCD" }), _jsxs("div", { className: "bv-fold-body", children: [_jsx("p", { className: "bv-muted", children: "\u4FDD\u5B58\u540E\u7528\u4E8E\u540E\u7EED\u8BED\u97F3\u56DE\u590D\u3002" }), _jsx("div", { className: "bv-divider" }), _jsx("div", { className: "bv-prompt-preview", children: effectivePrompt || '两个开关都关闭时，沿用 DSH 原有会话提示词。' }), _jsx("div", { className: "bv-divider" }), _jsx("p", { className: "bv-muted", children: "\u8FD9\u4E9B\u63D0\u793A\u8BCD\u53EA\u5728\u8BED\u97F3\u901A\u8BDD\u671F\u95F4\u751F\u6548\u3002" })] })] })] }), tab === 'interaction' && _jsxs("div", { className: "bv-grid", children: [_jsxs("div", { children: [_jsxs("section", { className: "bv-card", children: [_jsx("h2", { children: "\u8BED\u97F3\u8BC6\u522B" }), _jsxs("label", { className: "bv-field", children: ["\u8BC6\u522B\u5F15\u64CE", _jsxs("select", { value: value.asrEngine, onChange: e => change('asrEngine', e.target.value), children: [_jsx("option", { value: "server", children: "\u79C1\u6709\u670D\u52A1\u5668\u8BC6\u522B" }), _jsx("option", { value: "dsh", disabled: !nativeAsr?.ready && value.asrEngine !== 'dsh', children: "DSH \u81EA\u5E26 SenseVoice\uFF08\u672C\u673A\uFF09" })] }), _jsx("span", { className: "bv-help", children: "\u672C\u673A\u8BC6\u522B\u590D\u7528 DSH \u5DF2\u51C6\u5907\u7684\u6A21\u578B\uFF1B\u53EA\u66FF\u6362\u8BC6\u522B\u73AF\u8282\uFF0C\u5F55\u97F3\u3001\u6253\u65AD\u548C\u8BED\u97F3\u56DE\u7B54\u7EE7\u7EED\u7531\u672C\u63D2\u4EF6\u5904\u7406\u3002" })] }), _jsx("button", { className: "bv-button", style: { marginTop: 12 }, disabled: nativeChecking, onClick: () => void checkNativeAsr(), children: nativeChecking ? '检测中…' : '检测 DSH 原生识别' }), _jsx("p", { className: "bv-muted", role: "status", children: nativeAsr?.message ?? '先在 DSH 插件中启用「语音输入」，在原生语音输入设置完成 SenseVoice 准备，再检测并选择。不会自动下载或修改原生设置。' }), _jsx("div", { className: "bv-divider" }), _jsx("h2", { children: "\u8BF4\u8BDD\u4E0E\u6253\u65AD" }), _jsx("p", { className: "bv-muted", children: "\u6839\u636E\u505C\u987F\u4E60\u60EF\u8C03\u6574\u3002\u5916\u653E\u65F6\u53EF\u5173\u95ED\u81EA\u52A8\u6253\u65AD\uFF0C\u4F7F\u7528\u300C\u6253\u65AD\u56DE\u7B54\u300D\u6309\u94AE\u3002" }), _jsxs("div", { className: "bv-field-row", children: [_jsxs("label", { className: "bv-field", children: ["\u505C\u987F\u591A\u4E45\u81EA\u52A8\u53D1\u9001", _jsx("input", { type: "number", min: 400, max: 3000, step: 100, value: value.silenceMs, onChange: e => change('silenceMs', Number(e.target.value)) }), _jsx("span", { className: "bv-help", children: "\u6BEB\u79D2 \u00B7 \u9ED8\u8BA4 1200\uFF0C\u8F83\u5927\u6570\u503C\u53EF\u4EE5\u7559\u51FA\u601D\u8003\u65F6\u95F4\u3002" })] }), _jsxs("div", { className: "bv-field", children: ["\u672C\u673A\u8BED\u97F3\u68C0\u6D4B", _jsx("p", { className: "bv-muted", children: "\u81EA\u52A8\u533A\u5206\u4EBA\u58F0\u4E0E\u73AF\u5883\u58F0\u97F3\uFF0C\u786E\u8BA4\u4F60\u5728\u8BF4\u8BDD\u540E\u624D\u89E6\u53D1\u6253\u65AD\u3002" })] })] }), _jsxs("label", { className: "bv-switchline", children: [_jsx("input", { type: "checkbox", checked: value.bargeIn, onChange: e => change('bargeIn', e.target.checked) }), _jsxs("span", { children: ["\u5141\u8BB8\u5F00\u53E3\u6253\u65AD\u56DE\u7B54", _jsx("small", { children: "\u4F60\u518D\u6B21\u5F00\u53E3\u65F6\u505C\u6B62\u64AD\u62A5\u5E76\u53D6\u6D88\u5F53\u524D\u8BED\u97F3\u56DE\u590D\u3002\u5EFA\u8BAE\u4F69\u6234\u8033\u673A\u3002" })] })] }), _jsxs("label", { className: "bv-switchline", children: [_jsx("input", { type: "checkbox", checked: value.reviewBeforeSend, onChange: e => change('reviewBeforeSend', e.target.checked) }), _jsxs("span", { children: ["\u53D1\u9001\u524D\u786E\u8BA4\u8BC6\u522B\u5185\u5BB9", _jsx("small", { children: "\u8BC6\u522B\u540E\u6682\u505C\u6536\u97F3\uFF0C\u53EF\u4EE5\u4FEE\u6539\u6587\u5B57\u518D\u53D1\u9001\uFF0C\u9002\u5408\u4E13\u6709\u540D\u8BCD\u8F83\u591A\u7684\u5BF9\u8BDD\u3002" })] })] }), _jsxs("label", { className: "bv-field", children: ["\u4E2D\u6587\u8BC6\u522B\u70ED\u8BCD", _jsx("textarea", { maxLength: 2000, value: value.asrHotwords, onChange: e => change('asrHotwords', e.target.value), placeholder: "\u4F8B\u5982\uFF1A\u661F\u6CB3\u8BED\u97F3\uFF0CBreeze\uFF0CDSH\uFF0CQwen\uFF0C\u4F4F\u9662\u533B\u5E08" }), _jsx("span", { className: "bv-help", children: "\u586B\u5199\u5E38\u89C1\u4EBA\u540D\u3001\u9879\u76EE\u540D\u548C\u672F\u8BED\uFF0C\u7528\u9017\u53F7\u5206\u9694\u3002\u4EC5\u7528\u4E8E\u670D\u52A1\u5668\u8BC6\u522B\uFF1BDSH \u539F\u751F\u8BC6\u522B\u6682\u4E0D\u652F\u6301\u4F20\u5165\u70ED\u8BCD\u3002" })] }), _jsx("p", { className: "bv-muted", children: "\u9EA6\u514B\u98CE\u53C2\u6570\u5728\u4E0B\u4E00\u6B21\u5F00\u542F\u8BED\u97F3\u65F6\u751F\u6548\u3002\u6BCF\u6BB5\u5F55\u97F3\u6700\u957F 24 \u79D2\u3002" })] }), _jsxs("section", { className: "bv-card", children: [_jsx("h2", { children: "\u7A7A\u95F2\u91CA\u653E\u663E\u5B58" }), _jsx("p", { className: "bv-muted", children: "\u8BED\u97F3\u6682\u65F6\u4E0D\u7528\u65F6\uFF0C\u8BA9 GPU \u817E\u51FA\u7A7A\u95F4\u505A\u5176\u4ED6\u5DE5\u4F5C\u3002" }), _jsxs("label", { className: "bv-field", children: ["\u7A7A\u95F2\u81EA\u52A8\u5378\u8F7D\u95F4\u9694", _jsx("input", { type: "number", min: 0, max: 120, step: 1, value: value.idleMinutes, onChange: e => change('idleMinutes', Number(e.target.value)) }), _jsx("span", { className: "bv-help", children: "\u5206\u949F \u00B7 \u9ED8\u8BA4 10\uFF1B\u586B\u5199 0 \u8868\u793A\u4E0D\u81EA\u52A8\u5378\u8F7D\u3002\u4FDD\u5B58\u4F1A\u540C\u6B65\u5230\u670D\u52A1\u5668\u3002" })] }), _jsx("div", { className: "bv-chiprow", children: [1, 5, 10, 30, 0].map(n => _jsx("button", { className: "bv-chip", onClick: () => change('idleMinutes', n), children: n ? `${n} 分钟` : '不自动卸载' }, n)) })] })] }), _jsxs("aside", { className: "bv-card", children: [_jsx("h2", { children: "\u670D\u52A1\u5668\u8D44\u6E90" }), _jsx("p", { className: "bv-muted", children: "\u8BFB\u53D6\u771F\u5B9E\u7F51\u5173\u72B6\u6001\uFF0C\u4E0D\u4F1A\u4E3A\u4E86\u67E5\u770B\u800C\u52A0\u8F7D\u6A21\u578B\u3002" }), _jsxs("div", { className: "bv-kv", children: [_jsx("span", { children: "\u8BED\u97F3\u5408\u6210" }), _jsx("strong", { children: modelLabel(health?.tts) })] }), _jsxs("div", { className: "bv-kv", children: [_jsx("span", { children: "\u8BED\u97F3\u8BC6\u522B" }), _jsx("strong", { children: modelLabel(health?.asr) })] }), _jsxs("div", { className: "bv-kv", children: [_jsx("span", { children: "\u670D\u52A1\u5668\u5378\u8F7D\u95F4\u9694" }), _jsx("strong", { children: minutesLabel(health?.idle_seconds) })] }), _jsxs("div", { className: "bv-kv", children: [_jsx("span", { children: "\u9884\u8BA1\u7A7A\u95F2\u5378\u8F7D" }), _jsx("strong", { children: health?.idle_remaining_seconds != null ? `${Math.ceil(health.idle_remaining_seconds / 60)} 分钟内` : '—' })] }), _jsxs("div", { className: "bv-actions", children: [_jsx("button", { className: "bv-button", disabled: checking, onClick: () => void healthCheck(), children: "\u5237\u65B0\u72B6\u6001" }), _jsx("button", { className: "bv-button", disabled: checking || health?.busy, onClick: () => void release(), children: "\u7ACB\u5373\u91CA\u653E\u663E\u5B58" })] }), _jsx("p", { className: "bv-muted", style: { marginTop: 14 }, children: "\u53EA\u5378\u8F7D\u8BED\u97F3\u6A21\u578B\uFF1B\u670D\u52A1\u4FDD\u6301\u53EF\u8FDE\u63A5\u3002\u6B63\u5728\u8BC6\u522B\u6216\u5408\u6210\u65F6\u4E0D\u4F1A\u5F3A\u5236\u4E2D\u65AD\u3002" })] })] }), tab === 'connection' && _jsxs("div", { className: "bv-grid", children: [_jsxs("section", { className: "bv-card", children: [_jsx("h2", { children: "\u8BED\u97F3\u670D\u52A1\u5668" }), _jsx("p", { className: "bv-muted", children: "\u8BBE\u7F6E\u4F1A\u7EE7\u7EED\u4F7F\u7528\u5DF2\u6709\u503C\u3002SSH \u96A7\u9053\u4EC5\u5728\u8BED\u97F3\u9700\u8981\u670D\u52A1\u65F6\u5EFA\u7ACB\u3002" }), _jsxs("label", { className: "bv-field", children: ["SSH \u4E3B\u673A\u522B\u540D", _jsx("input", { value: value.sshHost, onChange: e => change('sshHost', e.target.value), placeholder: "\u7559\u7A7A\u4F7F\u7528\u5DF2\u5EFA\u7ACB\u7684\u672C\u673A\u8F6C\u53D1" })] }), _jsxs("label", { className: "bv-field", children: ["Windows \u7F51\u5173\u4EFB\u52A1\u540D", _jsx("input", { value: value.remoteTaskName, onChange: e => change('remoteTaskName', e.target.value), placeholder: "\u53EF\u9009\uFF1B\u8FDE\u63A5\u65F6\u542F\u52A8\u5DF2\u90E8\u7F72\u7684\u8BA1\u5212\u4EFB\u52A1" })] }), _jsxs("div", { className: "bv-field-row", children: [_jsxs("label", { className: "bv-field", children: ["\u670D\u52A1\u5668\u7AEF\u53E3", _jsx("input", { type: "number", min: 1024, max: 65535, value: value.remotePort, onChange: e => change('remotePort', Number(e.target.value)) })] }), _jsxs("label", { className: "bv-field", children: ["\u672C\u673A\u8F6C\u53D1\u7AEF\u53E3", _jsx("input", { type: "number", min: 1024, max: 65535, value: value.localPort, onChange: e => change('localPort', Number(e.target.value)) })] })] }), _jsxs("label", { className: "bv-field", children: ["\u8BED\u97F3\u670D\u52A1\u5BC6\u94A5", _jsx("input", { type: "password", autoComplete: "new-password", value: value.apiKey, onChange: e => change('apiKey', e.target.value) }), _jsx("span", { className: "bv-help", children: "\u5BC6\u94A5\u4FDD\u5B58\u5728\u672C\u673A DSH \u914D\u7F6E\u4E2D\uFF0C\u4E0D\u4F1A\u5199\u5165\u5206\u4EAB\u7684\u97F3\u8272\u63CF\u8FF0\u3002" })] }), _jsxs("div", { className: "bv-actions", children: [_jsx("button", { className: "bv-button", disabled: busy, onClick: () => void save(), children: "\u4FDD\u5B58\u5E76\u540C\u6B65\u670D\u52A1\u5668" }), _jsx("button", { className: "bv-button", disabled: checking, onClick: () => void healthCheck(), children: "\u6D4B\u8BD5\u5DF2\u4FDD\u5B58\u7684\u8FDE\u63A5" })] })] }), _jsxs("aside", { className: "bv-card", children: [_jsx("h2", { children: "\u5982\u4F55\u5F00\u59CB" }), _jsxs("div", { className: "bv-kv", children: [_jsx("span", { children: "01" }), _jsx("strong", { children: "\u4FDD\u5B58\u8BBE\u7F6E\u5E76\u786E\u8BA4\u8FDE\u63A5" })] }), _jsxs("div", { className: "bv-kv", children: [_jsx("span", { children: "02" }), _jsx("strong", { children: "\u56DE\u5230\u4F60\u6B63\u5728\u4F7F\u7528\u7684\u4F1A\u8BDD" })] }), _jsxs("div", { className: "bv-kv", children: [_jsx("span", { children: "03" }), _jsx("strong", { children: "\u70B9\u51FB\u8F93\u5165\u6846\u65C1\u7684\u300C\u8BED\u97F3\u300D" })] }), _jsx("div", { className: "bv-divider" }), _jsx("p", { className: "bv-muted", children: "\u9996\u6B21\u5F00\u542F\u4F1A\u9884\u70ED\u8BED\u97F3\u6A21\u578B\uFF0C\u7136\u540E\u8BF7\u6C42\u9EA6\u514B\u98CE\u8BBF\u95EE\u3002\u8BC6\u522B\u6587\u672C\u4E0E\u56DE\u7B54\u7EE7\u7EED\u4FDD\u5B58\u5728\u539F\u6765\u7684\u4F1A\u8BDD\u91CC\u3002" }), _jsx("p", { className: "bv-muted", children: "\u8BED\u97F3\u5728\u4F60\u7684\u670D\u52A1\u5668\u5904\u7406\uFF1BDSH \u7684\u8BED\u8A00\u6A21\u578B\u8BF7\u6C42\u7EE7\u7EED\u4F7F\u7528\u5F53\u524D\u4F1A\u8BDD\u914D\u7F6E\u3002" })] })] })] })] })] });
}

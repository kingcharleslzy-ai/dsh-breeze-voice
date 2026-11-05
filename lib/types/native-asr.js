export const NATIVE_PROVIDER = 'sensevoice-local';
function serviceOf(source) {
    const value = source && 'get' in source ? source.get('speechToText') : source;
    return value && typeof value.snapshot === 'function' && typeof value.resolve === 'function' && typeof value.transcribe === 'function' ? value : undefined;
}
export function lookupNativeAsr(source) {
    const service = serviceOf(source);
    if (!service)
        return { available: false, ready: false, phase: 'unavailable', providerId: NATIVE_PROVIDER, name: 'DSH SenseVoice', message: '先在 DSH 插件中启用「语音输入」，再到语音输入设置准备本机 SenseVoice。' };
    try {
        const provider = service.snapshot().providers.find(p => p.id === NATIVE_PROVIDER);
        if (!provider)
            return { available: false, ready: false, phase: 'unavailable', providerId: NATIVE_PROVIDER, name: 'DSH SenseVoice', message: 'DSH 语音服务已启用，但未注册本机 SenseVoice。请启用原生语音输入插件。' };
        const phase = provider.preparation?.phase ?? 'ready';
        const ready = ['ready', 'standby'].includes(phase) && (!provider.languages || provider.languages.includes('zh'));
        return { available: true, ready, phase, providerId: NATIVE_PROVIDER, name: provider.name ?? 'DSH SenseVoice', message: ready ? phase === 'standby' ? '本机模型已准备，首次识别会按需加载。' : '本机识别已就绪。' : `原生识别尚未就绪（${phase}）。请在 DSH 语音输入设置中完成准备；本插件不会自动下载模型。` };
    }
    catch {
        return { available: false, ready: false, phase: 'error', providerId: NATIVE_PROVIDER, name: 'DSH SenseVoice', message: '无法读取 DSH 原生语音服务状态，请检查原生插件。' };
    }
}
function validateWav(bytes) {
    const a = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (a.length < 46 || a.length > 44 + 32000 * 24.2 || a.toString('ascii', 0, 4) !== 'RIFF' || a.toString('ascii', 8, 12) !== 'WAVE' || a.toString('ascii', 12, 16) !== 'fmt ' || a.readUInt32LE(16) !== 16 || a.readUInt16LE(20) !== 1 || a.readUInt16LE(22) !== 1 || a.readUInt32LE(24) !== 16000 || a.readUInt32LE(28) !== 32000 || a.readUInt16LE(32) !== 2 || a.readUInt16LE(34) !== 16 || a.toString('ascii', 36, 40) !== 'data' || a.readUInt32LE(4) !== a.length - 8 || a.readUInt32LE(40) !== a.length - 44 || (a.length - 44) % 2)
        throw Error('原生识别只接受 24 秒以内的 16 kHz 单声道 PCM16 WAV');
    return { audio: a, duration: (a.length - 44) / 32000 };
}
export async function recognizeNativeAsr(source, bytes, signal) {
    signal.throwIfAborted();
    const status = lookupNativeAsr(source);
    if (!status.ready)
        throw Error(status.message);
    const service = serviceOf(source);
    const { audio, duration } = validateWav(bytes);
    const spec = service.resolve({ audio, providerId: NATIVE_PROVIDER, language: 'zh' });
    const result = await service.transcribe(spec, signal);
    signal.throwIfAborted();
    if (!result || typeof result !== 'object' || typeof result.text !== 'string')
        throw Error('DSH 原生识别未返回有效文本');
    return { text: result.text.trim(), language: 'zh', duration };
}

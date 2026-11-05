/** Local-only Silero v5 inference. No remote model, script, worker or telemetry. */
export const VAD_ASSETS = '/api/breeze-voice/assets/';
let runtime;
function loadRuntime() {
    return runtime ??= new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = VAD_ASSETS + 'ort.wasm.min.js';
        script.onload = () => {
            const ort = window.ort;
            if (!ort) {
                script.remove();
                reject(Error('本机语音检测运行库未加载'));
                return;
            }
            ort.env.wasm.numThreads = 1;
            ort.env.wasm.proxy = false;
            ort.env.wasm.wasmPaths = new URL(VAD_ASSETS, location.href).href;
            ort.env.logLevel = 'error';
            resolve(ort);
        };
        script.onerror = () => { script.remove(); reject(Error('无法加载本机语音检测资源，请检查插件安装')); };
        document.head.append(script);
    }).catch(error => { runtime = undefined; throw error; });
}
export async function loadVadModel() {
    const ort = await loadRuntime();
    const session = await ort.InferenceSession.create(VAD_ASSETS + 'silero_vad_v5.onnx', { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
    const sr = new ort.Tensor('int64', new BigInt64Array([16000n]));
    const state = () => new ort.Tensor('float32', new Float32Array(256), [2, 1, 128]);
    let hidden = state(), context = new Float32Array(64);
    return {
        async process(frame) {
            const data = new Float32Array(576);
            data.set(context);
            data.set(frame, 64);
            const input = new ort.Tensor('float32', data, [1, 576]);
            let output;
            try {
                output = await session.run({ input, state: hidden, sr });
                if (!output.stateN || !output.output)
                    throw Error('语音检测模型返回不完整');
                const probability = Number(output.output.data[0]);
                if (!Number.isFinite(probability))
                    throw Error('语音检测模型返回无效概率');
                hidden.dispose();
                hidden = output.stateN;
                context = frame.slice(-64);
                return probability;
            }
            finally {
                input.dispose();
                output?.output?.dispose();
            }
        },
        reset() { hidden.dispose(); hidden = state(); context.fill(0); },
        async dispose() { await session.release(); hidden.dispose(); sr.dispose(); },
    };
}

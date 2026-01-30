
import { GoogleGenAI, Modality, Type, FunctionDeclaration, LiveServerMessage } from "@google/genai";

// 游戏数据
const GESTURES = [
    { emoji: '✌️', name: '剪刀手', desc: '伸出食指和中指' },
    { emoji: '👍', name: '点赞', desc: '竖起大拇指' },
    { emoji: '👌', name: 'OK', desc: '食指和大拇指成圈' },
    { emoji: '🖐️', name: '击掌', desc: '张开五指' },
    { emoji: '🫶', name: '比心', desc: '双手或单手组成爱心' },
    { emoji: '✊', name: '加油', desc: '握紧拳头' }
];

// 状态变量
let currentGestureIndex = 0;
let score = 0;
let session: any = null;
let audioContext: AudioContext | null = null;
let outputAudioContext: AudioContext | null = null;
let nextStartTime = 0;
const sources = new Set<AudioBufferSourceNode>();
let frameInterval: any = null;

// 获取 DOM 元素 (由于是 ES 模块，会在 HTML 解析后执行)
const getEl = (id: string) => document.getElementById(id) as HTMLElement;

const bgVideo = document.getElementById('bgVideo') as HTMLVideoElement;
const viewIdle = getEl('view-idle');
const viewConnecting = getEl('view-connecting');
const viewPlaying = getEl('view-playing');
const viewFinished = getEl('view-finished');
const scoreContainer = getEl('scoreContainer');
const scoreValue = getEl('scoreValue');
const gestureEmoji = getEl('gestureEmoji');
const gestureName = getEl('gestureName');
const gestureDesc = getEl('gestureDesc');
const progressBar = getEl('progressBar');
const aiTranscription = getEl('aiTranscription');
const startBtn = getEl('startBtn');

// 音频辅助函数
// Manually implement encode function as per Google GenAI SDK guidelines
function encode(bytes: Uint8Array): string {
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
}

// Manually implement decode function as per Google GenAI SDK guidelines
function decode(base64: string): Uint8Array {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
}

// Manually implement audio decoding for raw PCM data from Live API
async function decodeAudioData(data: Uint8Array, ctx: AudioContext, sampleRate: number, numChannels: number): Promise<AudioBuffer> {
    const dataInt16 = new Int16Array(data.buffer);
    const frameCount = dataInt16.length / numChannels;
    const buffer = ctx.createBuffer(numChannels, frameCount, sampleRate);
    for (let channel = 0; channel < numChannels; channel++) {
        const channelData = buffer.getChannelData(channel);
        for (let i = 0; i < frameCount; i++) {
            channelData[i] = dataInt16[i * numChannels + channel] / 32768.0;
        }
    }
    return buffer;
}

// 游戏逻辑函数
function updateUI() {
    const g = GESTURES[currentGestureIndex];
    gestureEmoji.innerText = g.emoji;
    gestureName.innerText = g.name;
    gestureDesc.innerText = g.desc;
    scoreValue.innerText = score.toString();
    progressBar.style.width = `${((currentGestureIndex + 1) / GESTURES.length) * 100}%`;
}

function nextStep() {
    if (currentGestureIndex < GESTURES.length - 1) {
        currentGestureIndex++;
        updateUI();
    } else {
        finishGame();
    }
}

function finishGame() {
    if (frameInterval) clearInterval(frameInterval);
    if (session) session.close();
    viewPlaying.classList.add('hidden');
    viewFinished.classList.remove('hidden');
    getEl('finalScore').innerText = score.toString();
    bgVideo.style.opacity = "0.2";
}

// 核心挑战逻辑
async function startChallenge() {
    try {
        viewIdle.classList.add('hidden');
        viewConnecting.classList.remove('hidden');

        const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: { facingMode: 'user' } });
        bgVideo.srcObject = stream;
        bgVideo.style.opacity = "0.8";

        audioContext = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
        outputAudioContext = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });

        // Initialize GoogleGenAI with API key from environment
        const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
        
        // Define function declaration using proper Type enum values to fix Type mismatch error
        const updateTool: FunctionDeclaration = {
            name: 'update_game_progress',
            parameters: {
                type: Type.OBJECT,
                description: '当用户成功做出指定手势时调用此函数。',
                properties: {
                    success: { type: Type.BOOLEAN, description: '是否成功做出手势' },
                    pointsAwarded: { type: Type.NUMBER, description: '奖励的分数' }
                },
                required: ['success', 'pointsAwarded']
            }
        };

        const sessionPromise = ai.live.connect({
            model: 'gemini-2.5-flash-native-audio-preview-12-2025',
            callbacks: {
                onopen: () => {
                    viewConnecting.classList.add('hidden');
                    viewPlaying.classList.remove('hidden');
                    scoreContainer.classList.remove('hidden');
                    updateUI();

                    const source = audioContext!.createMediaStreamSource(stream);
                    const processor = audioContext!.createScriptProcessor(4096, 1, 1);
                    processor.onaudioprocess = (e) => {
                        const input = e.inputBuffer.getChannelData(0);
                        const int16 = new Int16Array(input.length);
                        for (let i = 0; i < input.length; i++) int16[i] = input[i] * 32768;
                        // Use sessionPromise to ensure connection is established before sending data
                        sessionPromise.then(s => s.sendRealtimeInput({
                            media: { data: encode(new Uint8Array(int16.buffer)), mimeType: 'audio/pcm;rate=16000' }
                        }));
                    };
                    source.connect(processor);
                    processor.connect(audioContext!.destination);

                    const canvas = document.getElementById('frameCanvas') as HTMLCanvasElement;
                    const ctx = canvas.getContext('2d')!;
                    frameInterval = setInterval(() => {
                        ctx.drawImage(bgVideo, 0, 0, canvas.width, canvas.height);
                        canvas.toBlob(blob => {
                            if (!blob) return;
                            const reader = new FileReader();
                            reader.onloadend = () => {
                                const base64 = (reader.result as string).split(',')[1];
                                sessionPromise.then(s => s.sendRealtimeInput({
                                    media: { data: base64, mimeType: 'image/jpeg' }
                                }));
                            };
                            reader.readAsDataURL(blob);
                        }, 'image/jpeg', 0.6);
                    }, 500);
                },
                onmessage: async (msg: LiveServerMessage) => {
                    // Extract audio from server response
                    const audioBase64 = msg.serverContent?.modelTurn?.parts?.[0]?.inlineData?.data;
                    if (audioBase64 && outputAudioContext) {
                        nextStartTime = Math.max(nextStartTime, outputAudioContext.currentTime);
                        const buffer = await decodeAudioData(decode(audioBase64), outputAudioContext, 24000, 1);
                        const source = outputAudioContext.createBufferSource();
                        source.buffer = buffer;
                        source.connect(outputAudioContext.destination);
                        // Schedule playback using nextStartTime to ensure gapless audio
                        source.start(nextStartTime);
                        nextStartTime += buffer.duration;
                        sources.add(source);
                    }

                    // Handle transcriptions
                    if (msg.serverContent?.outputTranscription) {
                        aiTranscription.innerText = msg.serverContent.outputTranscription.text;
                    }

                    // Handle tool calls from the model
                    if (msg.toolCall) {
                        for (const fc of msg.toolCall.functionCalls) {
                            if (fc.name === 'update_game_progress') {
                                score += (fc.args as any).pointsAwarded;
                                nextStep();
                                // Send tool response back to model, functionResponses is an object in Live API
                                sessionPromise.then(s => s.sendToolResponse({
                                    functionResponses: { id: fc.id, name: fc.name, response: { result: "ok, score updated" } }
                                }));
                            }
                        }
                    }

                    // Handle interruptions by stopping all playing audio nodes
                    if (msg.serverContent?.interrupted) {
                        sources.forEach(s => { try { s.stop(); } catch(e) {} });
                        sources.clear();
                        nextStartTime = 0;
                    }
                }
            },
            config: {
                responseModalities: [Modality.AUDIO],
                outputAudioTranscription: {},
                tools: [{ functionDeclarations: [updateTool] }],
                systemInstruction: `
                    你是一个疯狂的手势挑战赛主持人。你的名字叫“灵动小G”。
                    当前游戏手势列表：${GESTURES.map(g => g.name).join(', ')}。
                    你的任务：
                    1. 实时观看视频，引导用户一个接一个地完成手势。
                    2. 语气必须极其亢奋、幽默、像电视综艺主持人。
                    3. 当你看到用户成功做出当前手势（目前需要完成的是：${GESTURES[currentGestureIndex]?.name}）时，
                       必须立刻调用 update_game_progress 函数来给用户加分，并兴奋地宣布下一个挑战。
                    4. 每次成功加 100 分。
                    5. 只能使用中文。
                `
            }
        });
        session = await sessionPromise;

    } catch (err) {
        console.error(err);
        alert('无法启动挑战，请确保已授予摄像头和麦克风权限。');
    }
}

// 绑定事件
if (startBtn) {
    startBtn.addEventListener('click', startChallenge);
}

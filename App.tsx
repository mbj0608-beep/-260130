
import React, { useState, useRef, useEffect, useCallback } from 'react';
import { GoogleGenAI, Modality, LiveServerMessage } from '@google/genai';
import { GameState, GESTURES, GestureChallenge } from './types';
import { decode, encode, decodeAudioData } from './utils/audioHelpers';
import { Camera, Play, RotateCcw, Trophy, BrainCircuit, Mic, MicOff } from 'lucide-react';

const FRAME_RATE = 2; // Capture 2 frames per second for vision recognition
const JPEG_QUALITY = 0.6;

const App: React.FC = () => {
  const [gameState, setGameState] = useState<GameState>(GameState.IDLE);
  const [currentGestureIndex, setCurrentGestureIndex] = useState(0);
  const [score, setScore] = useState(0);
  const [hostTranscription, setHostTranscription] = useState('');
  const [isMuted, setIsMuted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Refs for persistent values
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const outputAudioContextRef = useRef<AudioContext | null>(null);
  const nextStartTimeRef = useRef<number>(0);
  const sourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const sessionRef = useRef<any>(null);
  const frameIntervalRef = useRef<number | null>(null);

  const currentGesture = GESTURES[currentGestureIndex];

  // Initialize and clean up session
  const stopGame = useCallback(() => {
    if (frameIntervalRef.current) window.clearInterval(frameIntervalRef.current);
    if (sessionRef.current) sessionRef.current.close();
    sourcesRef.current.forEach(s => s.stop());
    sourcesRef.current.clear();
    setGameState(GameState.IDLE);
  }, []);

  const startGame = async () => {
    try {
      setError(null);
      setGameState(GameState.CONNECTING);
      setScore(0);
      setCurrentGestureIndex(0);

      // 1. Get User Media
      const stream = await navigator.mediaDevices.getUserMedia({ 
        audio: true, 
        video: { facingMode: 'user', width: 640, height: 480 } 
      });

      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }

      // 2. Initialize Audio
      if (!audioContextRef.current) audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
      if (!outputAudioContextRef.current) outputAudioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
      
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      
      // 3. Connect to Live API
      const sessionPromise = ai.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-12-2025',
        callbacks: {
          onopen: () => {
            console.log('Connected to Gemini Live API');
            setGameState(GameState.PLAYING);
            
            // Start Audio Streaming
            const source = audioContextRef.current!.createMediaStreamSource(stream);
            const scriptProcessor = audioContextRef.current!.createScriptProcessor(4096, 1, 1);
            scriptProcessor.onaudioprocess = (e) => {
              if (isMuted) return;
              const inputData = e.inputBuffer.getChannelData(0);
              const int16 = new Int16Array(inputData.length);
              for (let i = 0; i < inputData.length; i++) int16[i] = inputData[i] * 32768;
              const pcmBlob = {
                data: encode(new Uint8Array(int16.buffer)),
                mimeType: 'audio/pcm;rate=16000',
              };
              sessionPromise.then(session => session.sendRealtimeInput({ media: pcmBlob }));
            };
            source.connect(scriptProcessor);
            scriptProcessor.connect(audioContextRef.current!.destination);

            // Start Video Frame Streaming
            frameIntervalRef.current = window.setInterval(() => {
              if (!videoRef.current || !canvasRef.current) return;
              const ctx = canvasRef.current.getContext('2d');
              if (!ctx) return;
              ctx.drawImage(videoRef.current, 0, 0, canvasRef.current.width, canvasRef.current.height);
              canvasRef.current.toBlob(async (blob) => {
                if (blob) {
                  const reader = new FileReader();
                  reader.onloadend = () => {
                    const base64Data = (reader.result as string).split(',')[1];
                    sessionPromise.then(session => session.sendRealtimeInput({
                      media: { data: base64Data, mimeType: 'image/jpeg' }
                    }));
                  };
                  reader.readAsDataURL(blob);
                }
              }, 'image/jpeg', JPEG_QUALITY);
            }, 1000 / FRAME_RATE);
          },
          onmessage: async (message: LiveServerMessage) => {
            // Handle Audio Output
            const base64Audio = message.serverContent?.modelTurn?.parts[0]?.inlineData?.data;
            if (base64Audio && outputAudioContextRef.current) {
              nextStartTimeRef.current = Math.max(nextStartTimeRef.current, outputAudioContextRef.current.currentTime);
              const audioBuffer = await decodeAudioData(decode(base64Audio), outputAudioContextRef.current, 24000, 1);
              const source = outputAudioContextRef.current.createBufferSource();
              source.buffer = audioBuffer;
              source.connect(outputAudioContextRef.current.destination);
              source.addEventListener('ended', () => sourcesRef.current.delete(source));
              source.start(nextStartTimeRef.current);
              nextStartTimeRef.current += audioBuffer.duration;
              sourcesRef.current.add(source);
            }

            // Handle Interruptions
            if (message.serverContent?.interrupted) {
              sourcesRef.current.forEach(s => s.stop());
              sourcesRef.current.clear();
              nextStartTimeRef.current = 0;
            }

            // Handle Transcriptions & Game Logic Detection
            if (message.serverContent?.outputTranscription) {
              const text = message.serverContent.outputTranscription.text;
              setHostTranscription(prev => (prev + ' ' + text).slice(-150));
              
              // Simple heuristic: If the AI mentions the success or current gesture emoji/name
              // In a real production app, you might use function calling for structured state changes
              // but here we interpret AI feedback as the "Game Master" voice.
            }
          },
          onerror: (e) => {
            console.error('API Error:', e);
            setError('连接中断，请重试');
            stopGame();
          },
          onclose: () => {
            console.log('Session Closed');
            setGameState(GameState.IDLE);
          }
        },
        config: {
          responseModalities: [Modality.AUDIO],
          outputAudioTranscription: {},
          systemInstruction: `
            你是一个充满活力的“手势挑战赛”主持人。你的任务是引导用户完成手势挑战。
            当前挑战列表：${GESTURES.map(g => `${g.name}(${g.emoji})`).join(', ')}。
            
            逻辑流程：
            1. 欢迎用户，宣布第一个挑战。
            2. 实时观察用户的视频流。当你看到用户做出了正确的手势时，立即热情地祝贺，并增加分数（口头宣布），然后提示下一个手势。
            3. 如果用户很久没做出来，给出一点幽默的提示。
            4. 语气要像游戏主播，幽默、积极、互动性强。
            5. 使用中文交流。
          `,
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } }
          }
        }
      });

      sessionRef.current = await sessionPromise;
    } catch (err: any) {
      console.error(err);
      setError('无法访问摄像头或麦克风，请检查权限。');
      setGameState(GameState.IDLE);
    }
  };

  // Simple local increment for demonstration if AI detects it
  // In this simplified logic, we let the AI "talk" the player through it
  // and user can manually skip if they want to simulate progress for the UI
  const handleNext = () => {
    if (currentGestureIndex < GESTURES.length - 1) {
      setCurrentGestureIndex(prev => prev + 1);
      setScore(prev => prev + 100);
    } else {
      setGameState(GameState.FINISHED);
      stopGame();
    }
  };

  useEffect(() => {
    return () => stopGame();
  }, [stopGame]);

  return (
    <div className="relative w-full h-screen bg-black overflow-hidden flex flex-col items-center justify-center font-sans">
      
      {/* Background Camera Feed */}
      <div className="absolute inset-0 z-0">
        <video 
          ref={videoRef} 
          autoPlay 
          playsInline 
          muted 
          className={`w-full h-full object-cover transition-opacity duration-1000 ${gameState === GameState.PLAYING ? 'opacity-80' : 'opacity-30'}`}
        />
        <canvas ref={canvasRef} className="hidden" width="320" height="240" />
      </div>

      {/* Decorative Overlays */}
      <div className="absolute inset-0 bg-gradient-to-b from-black/60 via-transparent to-black/80 pointer-events-none z-10" />

      {/* Top HUD */}
      <div className="absolute top-0 left-0 right-0 p-6 z-20 flex justify-between items-start">
        <div className="flex flex-col">
          <h1 className="text-2xl font-black italic tracking-tighter text-white drop-shadow-lg flex items-center gap-2">
            <BrainCircuit className="text-pink-500 w-8 h-8" />
            灵动指尖
          </h1>
          <p className="text-xs text-gray-300 font-medium">AI GESTURE CHALLENGE</p>
        </div>
        
        <div className="flex flex-col items-end gap-2">
          <div className="bg-white/10 backdrop-blur-md px-4 py-2 rounded-2xl border border-white/20 flex items-center gap-3">
            <Trophy className="text-yellow-400 w-5 h-5" />
            <span className="text-xl font-bold tabular-nums">{score}</span>
          </div>
          {gameState === GameState.PLAYING && (
            <button 
              onClick={() => setIsMuted(!isMuted)}
              className="p-2 bg-white/10 backdrop-blur-md rounded-full border border-white/20 text-white"
            >
              {isMuted ? <MicOff size={20} className="text-red-400" /> : <Mic size={20} className="text-green-400" />}
            </button>
          )}
        </div>
      </div>

      {/* Main Content Area */}
      <main className="relative z-20 flex-1 w-full flex flex-col items-center justify-center px-6">
        
        {gameState === GameState.IDLE && (
          <div className="text-center space-y-8 max-w-xs">
            <div className="relative inline-block">
              <div className="absolute -inset-4 bg-pink-500/30 blur-2xl rounded-full" />
              <div className="bg-gradient-to-tr from-pink-500 to-violet-500 p-8 rounded-full relative">
                <Camera className="w-16 h-16 text-white" />
              </div>
            </div>
            <div className="space-y-4">
              <h2 className="text-3xl font-bold">准备好挑战了吗？</h2>
              <p className="text-gray-300">打开摄像头，跟随 Gemini AI 的指令完成手势挑战，赢取积分！</p>
            </div>
            {error && <p className="text-red-400 text-sm font-medium">{error}</p>}
            <button 
              onClick={startGame}
              className="group relative w-full py-4 bg-white text-black font-bold rounded-2xl overflow-hidden active:scale-95 transition-all shadow-xl shadow-pink-500/20"
            >
              <div className="absolute inset-0 bg-gradient-to-r from-pink-500 to-violet-500 opacity-0 group-hover:opacity-10 transition-opacity" />
              <span className="flex items-center justify-center gap-2">
                <Play className="fill-current" /> 开始挑战
              </span>
            </button>
          </div>
        )}

        {gameState === GameState.CONNECTING && (
          <div className="text-center space-y-6">
            <div className="relative w-20 h-20 mx-auto">
              <div className="absolute inset-0 border-4 border-pink-500/20 rounded-full" />
              <div className="absolute inset-0 border-4 border-t-pink-500 rounded-full animate-spin" />
            </div>
            <p className="text-xl font-medium animate-pulse">正在唤醒 AI 裁判...</p>
          </div>
        )}

        {gameState === GameState.PLAYING && (
          <div className="w-full h-full flex flex-col items-center justify-between pb-12">
            {/* Target Gesture Card */}
            <div className="mt-24 bg-white/10 backdrop-blur-xl p-6 rounded-[2.5rem] border border-white/20 shadow-2xl flex flex-col items-center gap-4 w-full max-w-sm animate-in fade-in zoom-in duration-500">
              <span className="text-8xl animate-bounce">{currentGesture.emoji}</span>
              <div className="text-center">
                <h3 className="text-2xl font-bold">{currentGesture.name}</h3>
                <p className="text-gray-400 text-sm">{currentGesture.description}</p>
              </div>
              <div className="w-full bg-white/5 h-1 rounded-full overflow-hidden mt-2">
                <div 
                  className="h-full bg-pink-500 transition-all duration-500" 
                  style={{ width: `${((currentGestureIndex + 1) / GESTURES.length) * 100}%` }}
                />
              </div>
            </div>

            {/* AI Host Dialogue */}
            <div className="w-full max-w-sm">
              <div className="bg-black/40 backdrop-blur-lg border border-white/10 p-4 rounded-2xl min-h-[80px] flex items-center justify-center text-center">
                <p className="text-lg font-medium leading-relaxed italic text-pink-200">
                  {hostTranscription || "正在观察你的动作..."}
                </p>
              </div>
              
              {/* Manual Skip (For interaction testing) */}
              <button 
                onClick={handleNext}
                className="mt-4 w-full text-xs text-white/40 hover:text-white/80 transition-colors"
              >
                点此手动进入下一关 (如果AI没听清)
              </button>
            </div>
          </div>
        )}

        {gameState === GameState.FINISHED && (
          <div className="text-center space-y-8 max-w-xs animate-in slide-in-from-bottom duration-700">
            <div className="space-y-2">
              <div className="text-6xl mb-4">👑</div>
              <h2 className="text-4xl font-black italic">挑战完成!</h2>
              <p className="text-gray-400">你展现了惊人的灵活性！</p>
            </div>
            
            <div className="bg-white/10 backdrop-blur-md p-6 rounded-3xl border border-white/20">
              <p className="text-sm uppercase tracking-widest text-pink-400 font-bold mb-1">最终得分</p>
              <p className="text-6xl font-black">{score}</p>
            </div>

            <button 
              onClick={() => setGameState(GameState.IDLE)}
              className="w-full py-4 bg-white text-black font-bold rounded-2xl flex items-center justify-center gap-2 active:scale-95 transition-transform"
            >
              <RotateCcw size={20} /> 再玩一次
            </button>
          </div>
        )}
      </main>

      {/* Footer Instructions */}
      <footer className="absolute bottom-6 left-0 right-0 px-8 z-20 text-center pointer-events-none">
        {gameState === GameState.IDLE && (
          <p className="text-white/30 text-[10px] uppercase tracking-[0.2em]">
            Powered by Gemini 2.5 Flash Live API
          </p>
        )}
        {gameState === GameState.PLAYING && (
          <div className="flex justify-center gap-4">
             <div className="px-3 py-1 bg-white/5 rounded-full text-[10px] text-white/50 border border-white/10 backdrop-blur-sm">
               💡 提示：确保光线充足
             </div>
             <div className="px-3 py-1 bg-white/5 rounded-full text-[10px] text-white/50 border border-white/10 backdrop-blur-sm">
               🎤 AI 裁判正在实时倾听
             </div>
          </div>
        )}
      </footer>
    </div>
  );
};

export default App;

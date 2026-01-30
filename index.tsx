
// 离线手势感应游戏逻辑
const GESTURE_THRESHOLD = 40; // 感应灵敏度（越小越灵敏）
const MOTION_RATIO_TRIGGER = 0.1; // 触发捕获的局部运动比例

interface Star {
    id: number;
    x: number;
    y: number;
    size: number;
    hue: number;
    active: boolean;
    collected: boolean;
    scale: number;
}

class GameEngine {
    private video: HTMLVideoElement;
    private gameCanvas: HTMLCanvasElement;
    private gameCtx: CanvasRenderingContext2D;
    private motionCanvas: HTMLCanvasElement;
    private motionCtx: CanvasRenderingContext2D;
    
    private prevFrame: Uint8ClampedArray | null = null;
    private score: number = 0;
    private stars: Star[] = [];
    private lastStarTime: number = 0;
    private isPlaying: boolean = false;
    private audioCtx: AudioContext | null = null;

    constructor() {
        this.video = document.getElementById('bgVideo') as HTMLVideoElement;
        this.gameCanvas = document.getElementById('gameCanvas') as HTMLCanvasElement;
        this.gameCtx = this.gameCanvas.getContext('2d')!;
        this.motionCanvas = document.getElementById('motionCanvas') as HTMLCanvasElement;
        this.motionCtx = this.motionCanvas.getContext('2d', { willReadFrequently: true })!;

        window.addEventListener('resize', () => this.resize());
        this.resize();
    }

    private resize() {
        this.gameCanvas.width = window.innerWidth;
        this.gameCanvas.height = window.innerHeight;
    }

    async init() {
        try {
            // 改进的媒体约束，增强兼容性
            const constraints = {
                video: {
                    facingMode: 'user',
                    width: { ideal: 640 },
                    height: { ideal: 480 }
                },
                audio: false
            };
            
            const stream = await navigator.mediaDevices.getUserMedia(constraints);
            this.video.srcObject = stream;
            
            document.getElementById('startBtn')?.addEventListener('click', () => this.start());
        } catch (err: any) {
            console.error("Camera Error: ", err);
            if (err.name === 'NotFoundError' || err.name === 'DevicesNotFoundError') {
                alert("未找到摄像头设备，请检查连接或权限设置。");
            } else {
                alert(`摄像头开启失败: ${err.message}`);
            }
        }
    }

    private start() {
        this.isPlaying = true;
        this.score = 0;
        this.stars = [];
        this.updateScoreUI();
        document.getElementById('startScreen')?.classList.add('hidden');
        document.getElementById('gameHint')?.classList.remove('hidden');
        
        // 初始化音频上下文
        this.audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
        
        this.gameLoop();
    }

    private playCollectSound() {
        if (!this.audioCtx) return;
        const osc = this.audioCtx.createOscillator();
        const gain = this.audioCtx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(440 + Math.random() * 440, this.audioCtx.currentTime);
        osc.frequency.exponentialRampToValueAtTime(880, this.audioCtx.currentTime + 0.1);
        gain.gain.setValueAtTime(0.2, this.audioCtx.currentTime);
        gain.gain.linearRampToValueAtTime(0, this.audioCtx.currentTime + 0.2);
        osc.connect(gain);
        gain.connect(this.audioCtx.destination);
        osc.start();
        osc.stop(this.audioCtx.currentTime + 0.2);
    }

    private detectMotion() {
        const { width, height } = this.motionCanvas;
        // 绘制视频帧到微型画布 (镜像处理以匹配视觉)
        this.motionCtx.save();
        this.motionCtx.scale(-1, 1);
        this.motionCtx.drawImage(this.video, -width, 0, width, height);
        this.motionCtx.restore();

        const currentFrame = this.motionCtx.getImageData(0, 0, width, height).data;
        const motionMap = new Uint8Array(width * height);

        if (this.prevFrame) {
            for (let i = 0; i < currentFrame.length; i += 4) {
                const rDiff = Math.abs(currentFrame[i] - this.prevFrame[i]);
                const gDiff = Math.abs(currentFrame[i + 1] - this.prevFrame[i + 1]);
                const bDiff = Math.abs(currentFrame[i + 2] - this.prevFrame[i + 2]);
                
                if (rDiff + gDiff + bDiff > GESTURE_THRESHOLD) {
                    motionMap[i / 4] = 1;
                }
            }
        }

        this.prevFrame = new Uint8ClampedArray(currentFrame);
        return { motionMap, width, height };
    }

    private updateScoreUI() {
        const el = document.getElementById('scoreValue');
        if (el) el.innerText = this.score.toString().padStart(3, '0');
    }

    private spawnStar() {
        const now = Date.now();
        if (now - this.lastStarTime > 1500 && this.stars.filter(s => s.active).length < 5) {
            this.stars.push({
                id: now,
                x: 0.15 + Math.random() * 0.7, // 屏幕比例
                y: 0.2 + Math.random() * 0.6,
                size: 40 + Math.random() * 30,
                hue: Math.random() * 360,
                active: true,
                collected: false,
                scale: 0
            });
            this.lastStarTime = now;
        }
    }

    private gameLoop() {
        if (!this.isPlaying) return;

        // 1. 获取运动数据
        const { motionMap, width: mw, height: mh } = this.detectMotion();

        // 2. 更新星星
        this.spawnStar();
        
        this.gameCtx.clearRect(0, 0, this.gameCanvas.width, this.gameCanvas.height);

        this.stars = this.stars.filter(star => {
            if (!star.active) return false;

            // 渐入效果
            if (!star.collected && star.scale < 1) star.scale += 0.05;

            // 碰撞检测：检查星星位置在运动地图中的变化
            const gridX = Math.floor(star.x * mw);
            const gridY = Math.floor(star.y * mh);
            const radius = 3; // 检查范围
            
            let motionHits = 0;
            for (let dy = -radius; dy <= radius; dy++) {
                for (let dx = -radius; dx <= radius; dx++) {
                    const gx = gridX + dx;
                    const gy = gridY + dy;
                    if (gx >= 0 && gx < mw && gy >= 0 && gy < mh) {
                        if (motionMap[gy * mw + gx]) motionHits++;
                    }
                }
            }

            if (motionHits > (radius * 2 + 1) * 2 && !star.collected) {
                star.collected = true;
                this.score += 10;
                this.updateScoreUI();
                this.playCollectSound();
            }

            // 绘制星星
            if (star.collected) {
                star.scale += 0.2;
                star.size += 5;
                if (star.scale > 3) star.active = false;
            }

            const screenX = star.x * this.gameCanvas.width;
            const screenY = star.y * this.gameCanvas.height;

            this.gameCtx.save();
            this.gameCtx.translate(screenX, screenY);
            this.gameCtx.scale(star.scale, star.scale);
            
            // 绘制霓虹光晕
            const gradient = this.gameCtx.createRadialGradient(0, 0, 0, 0, 0, star.size);
            const color = `hsla(${star.hue}, 80%, 60%, ${star.collected ? 1 - (star.scale / 3) : 0.8})`;
            gradient.addColorStop(0, color);
            gradient.addColorStop(1, 'transparent');
            
            this.gameCtx.fillStyle = gradient;
            this.gameCtx.beginPath();
            this.gameCtx.arc(0, 0, star.size, 0, Math.PI * 2);
            this.gameCtx.fill();

            // 绘制核心
            this.gameCtx.fillStyle = 'white';
            this.gameCtx.beginPath();
            this.gameCtx.arc(0, 0, star.size / 4, 0, Math.PI * 2);
            this.gameCtx.fill();

            this.gameCtx.restore();

            return star.active;
        });

        requestAnimationFrame(() => this.gameLoop());
    }
}

// 启动
const engine = new GameEngine();
engine.init();

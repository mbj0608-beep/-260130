
// 离线手势感应/触控游戏逻辑
const GESTURE_THRESHOLD = 35; 

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
    
    // 状态标识
    private cameraActive: boolean = false;
    private lastTouchX: number = -1;
    private lastTouchY: number = -1;

    constructor() {
        this.video = document.getElementById('bgVideo') as HTMLVideoElement;
        this.gameCanvas = document.getElementById('gameCanvas') as HTMLCanvasElement;
        this.gameCtx = this.gameCanvas.getContext('2d')!;
        this.motionCanvas = document.getElementById('motionCanvas') as HTMLCanvasElement;
        this.motionCtx = this.motionCanvas.getContext('2d', { willReadFrequently: true })!;

        window.addEventListener('resize', () => this.resize());
        this.setupInteractionListeners();
        this.resize();
    }

    private setupInteractionListeners() {
        const handleInteraction = (e: TouchEvent | MouseEvent) => {
            if (!this.isPlaying) return;
            const clientX = 'touches' in e ? e.touches[0].clientX : (e as MouseEvent).clientX;
            const clientY = 'touches' in e ? e.touches[0].clientY : (e as MouseEvent).clientY;
            // 将坐标转换为 0~1 的比例
            this.lastTouchX = clientX / window.innerWidth;
            this.lastTouchY = clientY / window.innerHeight;
        };

        window.addEventListener('touchstart', handleInteraction, { passive: false });
        window.addEventListener('touchmove', handleInteraction, { passive: false });
        window.addEventListener('mousedown', handleInteraction);
        window.addEventListener('mousemove', (e) => {
            // 只有按下鼠标或移动时才记录
            if (e.buttons > 0) handleInteraction(e);
        });
    }

    private resize() {
        this.gameCanvas.width = window.innerWidth;
        this.gameCanvas.height = window.innerHeight;
    }

    /**
     * 初始化环境
     */
    async init() {
        const startBtn = document.getElementById('startBtn');
        const hint = document.getElementById('gameHint');
        const badge = document.getElementById('modeBadge');
        
        // 1. 检查浏览器支持
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            this.setFallbackMode("浏览器不支持摄像头");
            startBtn?.addEventListener('click', () => this.start());
            return;
        }

        try {
            // 2. 尝试获取摄像头
            const stream = await navigator.mediaDevices.getUserMedia({ 
                video: { facingMode: 'user' },
                audio: false 
            }).catch(async () => {
                // 再次尝试不带特定约束的请求
                return await navigator.mediaDevices.getUserMedia({ video: true });
            });

            if (stream) {
                this.video.srcObject = stream;
                await this.video.play();
                this.cameraActive = true;
                if (badge) badge.innerText = "感应模式开启";
            }
        } catch (err: any) {
            // 3. 静默处理“未找到设备”错误
            console.log("进入触控补偿模式:", err.name);
            this.setFallbackMode(err.name === 'NotFoundError' ? "未检测到摄像头" : "权限受限");
        }

        startBtn?.addEventListener('click', () => this.start());
    }

    private setFallbackMode(reason: string) {
        this.cameraActive = false;
        this.video.style.display = 'none'; // 隐藏视频元素，避免黑屏
        const badge = document.getElementById('modeBadge');
        const desc = document.getElementById('gameDesc');
        if (badge) badge.innerText = "触控模式 (离线)";
        if (desc) desc.innerText = `[${reason}] 别担心，您依然可以通过点击或滑动屏幕来捕捉星星！`;
    }

    private start() {
        if (this.isPlaying) return;
        this.isPlaying = true;
        this.score = 0;
        this.stars = [];
        this.updateScoreUI();
        document.getElementById('startScreen')?.classList.add('hidden');
        document.getElementById('gameHint')?.classList.remove('hidden');
        
        // 初始化音效引擎
        try {
            this.audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
        } catch(e) {}
        
        this.gameLoop();
    }

    private playCollectSound() {
        if (!this.audioCtx) return;
        try {
            if (this.audioCtx.state === 'suspended') this.audioCtx.resume();
            const osc = this.audioCtx.createOscillator();
            const gain = this.audioCtx.createGain();
            osc.type = 'sine';
            osc.frequency.setValueAtTime(500 + Math.random() * 300, this.audioCtx.currentTime);
            osc.frequency.exponentialRampToValueAtTime(1000, this.audioCtx.currentTime + 0.1);
            gain.gain.setValueAtTime(0.1, this.audioCtx.currentTime);
            gain.gain.linearRampToValueAtTime(0, this.audioCtx.currentTime + 0.15);
            osc.connect(gain);
            gain.connect(this.audioCtx.destination);
            osc.start();
            osc.stop(this.audioCtx.currentTime + 0.15);
        } catch(e) {}
    }

    private detectMotion() {
        if (!this.cameraActive || this.video.readyState < 2) {
            return { motionMap: new Uint8Array(0), width: 0, height: 0 };
        }

        const { width, height } = this.motionCanvas;
        this.motionCtx.save();
        this.motionCtx.scale(-1, 1);
        this.motionCtx.drawImage(this.video, -width, 0, width, height);
        this.motionCtx.restore();

        const currentFrame = this.motionCtx.getImageData(0, 0, width, height).data;
        const motionMap = new Uint8Array(width * height);

        if (this.prevFrame) {
            for (let i = 0; i < currentFrame.length; i += 4) {
                const diff = Math.abs(currentFrame[i] - this.prevFrame[i]) +
                             Math.abs(currentFrame[i + 1] - this.prevFrame[i + 1]) +
                             Math.abs(currentFrame[i + 2] - this.prevFrame[i + 2]);
                if (diff > GESTURE_THRESHOLD) motionMap[i / 4] = 1;
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
        if (now - this.lastStarTime > 1000 && this.stars.filter(s => s.active).length < 6) {
            this.stars.push({
                id: now,
                x: 0.15 + Math.random() * 0.7,
                y: 0.2 + Math.random() * 0.6,
                size: 30 + Math.random() * 30,
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

        const { motionMap, width: mw, height: mh } = this.detectMotion();
        this.spawnStar();
        this.gameCtx.clearRect(0, 0, this.gameCanvas.width, this.gameCanvas.height);

        this.stars = this.stars.filter(star => {
            if (!star.active) return false;
            if (!star.collected && star.scale < 1) star.scale += 0.1;

            let isHit = false;

            // 1. 触控/光标检测
            if (this.lastTouchX !== -1) {
                const dx = star.x - this.lastTouchX;
                const dy = star.y - this.lastTouchY;
                const dist = Math.sqrt(dx*dx + dy*dy);
                if (dist < 0.15) isHit = true;
            } 
            
            // 2. 摄像头动作检测
            if (!isHit && this.cameraActive && mw > 0) {
                const gridX = Math.floor(star.x * mw);
                const gridY = Math.floor(star.y * mh);
                const r = 2;
                let hits = 0;
                for (let dy = -r; dy <= r; dy++) {
                    for (let dx = -r; dx <= r; dx++) {
                        const gx = gridX + dx;
                        const gy = gridY + dy;
                        if (gx >= 0 && gx < mw && gy >= 0 && gy < mh && motionMap[gy * mw + gx]) hits++;
                    }
                }
                if (hits > 4) isHit = true;
            }

            if (isHit && !star.collected) {
                star.collected = true;
                this.score += 10;
                this.updateScoreUI();
                this.playCollectSound();
                this.lastTouchX = -1; // 触发后重置，防止同一帧重复触发
                this.lastTouchY = -1;
            }

            if (star.collected) {
                star.scale += 0.2;
                if (star.scale > 4) star.active = false;
            }

            // 绘制逻辑
            const screenX = star.x * this.gameCanvas.width;
            const screenY = star.y * this.gameCanvas.height;
            this.gameCtx.save();
            this.gameCtx.translate(screenX, screenY);
            this.gameCtx.scale(star.scale, star.scale);
            
            const color = `hsla(${star.hue}, 90%, 65%, ${star.collected ? 1 - (star.scale / 4) : 0.8})`;
            const grad = this.gameCtx.createRadialGradient(0, 0, 0, 0, 0, star.size);
            grad.addColorStop(0, color);
            grad.addColorStop(1, 'transparent');
            
            this.gameCtx.fillStyle = grad;
            this.gameCtx.beginPath();
            this.gameCtx.arc(0, 0, star.size, 0, Math.PI * 2);
            this.gameCtx.fill();

            this.gameCtx.fillStyle = 'white';
            this.gameCtx.beginPath();
            this.gameCtx.arc(0, 0, star.size/4, 0, Math.PI * 2);
            this.gameCtx.fill();
            this.gameCtx.restore();

            return star.active;
        });

        requestAnimationFrame(() => this.gameLoop());
    }
}

const engine = new GameEngine();
engine.init();

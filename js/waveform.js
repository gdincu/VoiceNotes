// waveform.js — real-time waveform rendering from a live MediaStream using
// AudioContext + AnalyserNode + canvas. Isolated so recorder.js and app.js
// never touch the Web Audio graph directly.

export class WaveformVisualizer {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {{lineColor?:string, idleColor?:string}} [opts]
   */
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.ctx2d = canvas.getContext('2d');
    this.lineColor = opts.lineColor || '#c43e2e';
    this.idleColor = opts.idleColor || 'rgba(150,150,150,0.3)';

    this.audioCtx = null;
    this.analyser = null;
    this.sourceNode = null;
    this.dataArray = null;
    this.rafId = null;
    this._dpr = Math.max(1, window.devicePixelRatio || 1);

    this._resizeCanvas();
    this._onResize = () => this._resizeCanvas();
    window.addEventListener('resize', this._onResize);
  }

  _resizeCanvas() {
    const rect = this.canvas.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width * this._dpr));
    const h = Math.max(1, Math.round(rect.height * this._dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
  }

  /**
   * Begin visualizing a live microphone stream.
   * @param {MediaStream} stream
   */
  start(stream) {
    this.stop(); // defensive: clean up any previous graph first

    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    this.audioCtx = new AudioContextClass();
    this.analyser = this.audioCtx.createAnalyser();
    // A moderate FFT size keeps CPU/battery use low while still looking smooth.
    this.analyser.fftSize = 1024;
    this.analyser.smoothingTimeConstant = 0.85;

    this.sourceNode = this.audioCtx.createMediaStreamSource(stream);
    this.sourceNode.connect(this.analyser);
    // Intentionally not connected to audioCtx.destination — we only read
    // data from the analyser, we never want to play the mic back out loud.

    this.dataArray = new Uint8Array(this.analyser.fftSize);
    this._draw();
  }

  _draw = () => {
    this.rafId = requestAnimationFrame(this._draw);
    if (!this.analyser) return;

    this.analyser.getByteTimeDomainData(this.dataArray);

    const { width, height } = this.canvas;
    const ctx = this.ctx2d;
    ctx.clearRect(0, 0, width, height);

    ctx.lineWidth = Math.max(2, height * 0.02);
    ctx.strokeStyle = this.lineColor;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();

    const sliceWidth = width / this.dataArray.length;
    let x = 0;
    for (let i = 0; i < this.dataArray.length; i++) {
      const v = this.dataArray[i] / 128.0; // 0..2, 1 == silence
      const y = (v * height) / 2;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
      x += sliceWidth;
    }
    ctx.lineTo(width, height / 2);
    ctx.stroke();
  };

  /** Draws a flat idle line — used before recording starts / after it ends. */
  drawIdle() {
    const { width, height } = this.canvas;
    const ctx = this.ctx2d;
    ctx.clearRect(0, 0, width, height);
    ctx.strokeStyle = this.idleColor;
    ctx.lineWidth = Math.max(2, height * 0.015);
    ctx.beginPath();
    ctx.moveTo(0, height / 2);
    ctx.lineTo(width, height / 2);
    ctx.stroke();
  }

  /** Stops the render loop and tears down the audio graph. Safe to call repeatedly. */
  stop() {
    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    if (this.sourceNode) {
      try { this.sourceNode.disconnect(); } catch { /* already disconnected */ }
      this.sourceNode = null;
    }
    if (this.analyser) {
      try { this.analyser.disconnect(); } catch { /* already disconnected */ }
      this.analyser = null;
    }
    if (this.audioCtx) {
      // Closing releases the audio hardware/battery resources promptly
      // rather than waiting on garbage collection.
      this.audioCtx.close().catch(() => {});
      this.audioCtx = null;
    }
    this.dataArray = null;
  }

  destroy() {
    this.stop();
    window.removeEventListener('resize', this._onResize);
  }
}

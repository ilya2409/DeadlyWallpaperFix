// The scene camera (orthographic projection with Wallpaper Engine's eye/center/up), parallax,
// shake and fade, the viewport mapping that fits the scene to the window, and the pointer.
// Ports Render/Camera.cpp, CScene::renderFrame's parallax, CScene::updateMouse and
// WallpaperState::updateTextureUVs.
(() => {
  'use strict';
  const G = typeof window !== 'undefined' ? window : globalThis;
  const M = G.WEM;

  const FADE_SECONDS = 1;

  /**
   * The scene camera. Orthographic scenes project their pixel extents with the eye/center/up of
   * scene.json; 3D scenes look from eye to center with the general section's field of view.
   */
  class Camera {
    constructor(data) {
      this.center = data.center;
      this.eye = data.eye;
      this.up = data.up;
      this.fov = data.fov;
      this.nearz = data.nearz;
      this.farz = data.farz;
      this.zoom = data.zoom || null;
      this.perspectiveOverrideFov = data.perspectiveOverrideFov || null;
      this.perspective = false;
      this.width = 0;
      this.height = 0;
      this.projection = M.identity();
      this.lookAt = M.lookAt(this.eye, this.center, this.up);
      this.view = this.lookAt;
      this.viewProjection = M.identity();
      this.inverseViewProjection = M.identity();
      this.perspectiveViewProjection = M.identity();
      this.eyePosition = new Float32Array(3);
      this.right = new Float32Array([1, 0, 0]);
      this.upVector = new Float32Array([0, 1, 0]);
      this.forward = new Float32Array([0, 0, -1]);
    }

    zoomFactor() { const z = this.zoom ? this.zoom.getNumber() : 1; return z > 0 ? z : 1; }

    // Camera::setOrthogonalProjection
    setOrthogonalProjection(width, height) {
      this.perspective = false;
      this.width = width;
      this.height = height;
      const projection = M.ortho(-width / 2, width / 2, -height / 2, height / 2, this.nearz.getNumber(), this.farz.getNumber());
      this.projection = M.translate(projection, this.eye[0], this.eye[1], this.eye[2]);
      this.updateFrame([0, 0]);
    }

    // A 3D scene: perspective over the viewport's aspect, zoomed by narrowing the view
    setPerspectiveProjection(width, height) {
      this.perspective = true;
      this.width = width;
      this.height = height;
      this.updateFrame([0, 0]);
    }

    // Per-frame view-projection matrices: the orthographic one with the camera shake offset,
    // and the perspective one layers with "perspective" use. The perspective eye sits at the
    // distance where the z=0 plane spans exactly the orthographic extents, so flat layers match.
    updateFrame(shake) {
      this.lookAt = M.lookAt(this.eye, this.center, this.up);
      const shakeMatrix = M.translation(shake[0], shake[1], 0);
      if (this.perspective) {
        const fov = this.fov.getNumber() * Math.PI / 180;
        const aspect = this.width / Math.max(1, this.height);
        const near = Math.max(this.nearz.getNumber(), 1e-4);
        const far = Math.max(this.farz.getNumber(), near + 1);
        const zoom = this.zoomFactor();
        const projection = M.perspective(fov, aspect, near, far);
        projection[0] *= zoom;
        projection[5] *= zoom;
        this.projection = projection;
        this.view = M.multiply(this.lookAt, shakeMatrix);
        this.viewProjection = M.multiply(this.projection, this.view);
        this.perspectiveViewProjection = this.viewProjection;
        this.eyePosition.set(this.eye);
      } else {
        this.view = M.multiply(this.lookAt, shakeMatrix);
        this.viewProjection = M.multiply(this.projection, this.view);
        const override = this.perspectiveOverrideFov ? this.perspectiveOverrideFov.getNumber() : 0;
        const fov = (override > 0 ? override : this.fov.getNumber()) * Math.PI / 180;
        const distance = (this.height / 2) / Math.tan(fov / 2);
        const near = Math.max(this.nearz.getNumber(), 1);
        const far = Math.max(this.farz.getNumber(), distance * 2 + 1);
        const projection = M.perspective(fov, this.width / this.height, near, far);
        const view = M.lookAt([0, 0, distance], [0, 0, 0], [0, 1, 0]);
        this.perspectiveViewProjection = M.multiply(M.multiply(projection, view), shakeMatrix);
        this.eyePosition.set([this.eye[0], this.eye[1], distance]);
      }
      this.inverseViewProjection = M.inverse(this.viewProjection);
      const v = this.view;
      this.right.set([v[0], v[4], v[8]]);
      this.upVector.set([v[1], v[5], v[9]]);
      this.forward.set([-v[2], -v[6], -v[10]]);
    }

    // Window depth along the view direction of a world point, for transparent sorting
    viewDepth(point) {
      const v = this.view;
      return -(v[2] * point[0] + v[6] * point[1] + v[10] * point[2] + v[14]);
    }
  }

  /** CScene::renderFrame's parallax displacement, driven by the pointer. */
  class Parallax {
    constructor(settings) {
      this.enabled = settings.enabled;
      this.amount = settings.amount;
      this.delay = settings.delay;
      this.mouseInfluence = settings.mouseInfluence;
      this.displacement = new Float32Array(2);
    }
    update(dt, mousePosition) {
      if (!this.enabled.getBool()) return;
      const influence = this.mouseInfluence.getNumber();
      const amount = this.amount.getNumber();
      const delay = Math.min(1, Math.max(0, this.delay.getNumber() * dt));
      const cx = mousePosition[0] - 0.5, cy = mousePosition[1] - 0.5;
      const tx = cx * amount * influence, ty = cy * amount * influence;
      this.displacement[0] += (tx - this.displacement[0]) * delay;
      this.displacement[1] += (ty - this.displacement[1]) * delay;
    }
  }

  // Smooth value noise in [-1, 1] for the camera shake.
  function hash(n) {
    const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
    return (x - Math.floor(x)) * 2 - 1;
  }
  function noise1(t) {
    const i = Math.floor(t), f = t - i;
    const u = f * f * (3 - 2 * f);
    return hash(i) * (1 - u) + hash(i + 1) * u;
  }

  /** Camera shake: "camerashake" with amplitude (scene units), roughness and speed. */
  class Shake {
    constructor(settings) {
      this.enabled = settings.enabled;
      this.amplitude = settings.amplitude;
      this.roughness = settings.roughness;
      this.speed = settings.speed;
      this.offset = new Float32Array(2);
    }
    update(time) {
      if (!this.enabled.getBool()) { this.offset[0] = 0; this.offset[1] = 0; return; }
      const amplitude = this.amplitude.getNumber();
      const roughness = Math.min(1, Math.max(0, this.roughness.getNumber()));
      const t = time * this.speed.getNumber();
      const smooth = 1 - roughness;
      this.offset[0] = amplitude * (noise1(t) * smooth + noise1(t * 4 + 17.3) * roughness);
      this.offset[1] = amplitude * (noise1(t + 101.7) * smooth + noise1(t * 4 + 59.1) * roughness);
    }
  }

  /** "camerafade": the wallpaper fades in from black when it starts. */
  class Fade {
    constructor(enabled) { this.enabled = enabled; }
    factor(time) {
      if (!this.enabled.getBool()) return 1;
      return Math.min(1, Math.max(0, time / FADE_SECONDS));
    }
  }

  // Scaling modes as the host names them, after the fits of media wallpapers
  const FITS = { uniformfill: 'uniformfill', uniform: 'uniform', fill: 'fill', none: 'none' };

  /**
   * WallpaperState: how the scene texture lands on the window. Uniform fill covers the viewport
   * keeping the aspect ratio and crops the overflow, uniform fits the whole scene inside it,
   * fill stretches it, none keeps scene pixels one to one. Also CScene::updateMouse's pointer
   * mapping into the visible part of the scene texture.
   */
  class Viewport {
    constructor() {
      this.width = 0;
      this.height = 0;
      this.projectionWidth = 0;
      this.projectionHeight = 0;
      this.fit = FITS.uniformfill;
      // Texture coordinates of the visible part, the scene's top row at vstart
      this.uvs = { ustart: 0, uend: 1, vstart: 0, vend: 1 };
      // Clip space rectangle the visible part is drawn into
      this.rect = { x0: -1, y0: -1, x1: 1, y1: 1 };
      // Scaled scene size and the part of it inside the viewport, in window pixels
      this.visible = { sw: 1, sh: 1, vw: 1, vh: 1 };
      this.mouse = { position: new Float32Array(2), positionLast: new Float32Array(2) };
      this.pointer = [0.5, 0.5];
    }

    setFit(name) {
      const fit = FITS[String(name).toLowerCase()];
      if (!fit) throw new Error('scene fit "' + name + '" is not uniformfill, uniform, fill or none');
      if (fit === this.fit) return;
      this.fit = fit;
      this.width = 0;
    }

    // WallpaperState::updateState + updateTextureUVs for the chosen fit
    update(width, height, projectionWidth, projectionHeight) {
      if (this.width === width && this.height === height && this.projectionWidth === projectionWidth && this.projectionHeight === projectionHeight) return;
      this.width = width;
      this.height = height;
      this.projectionWidth = projectionWidth;
      this.projectionHeight = projectionHeight;
      let mx, my;
      switch (this.fit) {
        case FITS.uniform: mx = my = Math.min(width / projectionWidth, height / projectionHeight); break;
        case FITS.fill: mx = width / projectionWidth; my = height / projectionHeight; break;
        case FITS.none: mx = my = 1; break;
        default: mx = my = Math.max(width / projectionWidth, height / projectionHeight); break;
      }
      const sw = projectionWidth * mx, sh = projectionHeight * my;
      const vw = Math.min(sw, width), vh = Math.min(sh, height);
      this.visible = { sw, sh, vw, vh };
      this.uvs = { ustart: (sw - vw) / 2 / sw, uend: (sw + vw) / 2 / sw, vstart: (sh - vh) / 2 / sh, vend: (sh + vh) / 2 / sh };
      this.rect = { x0: -vw / width, y0: -vh / height, x1: vw / width, y1: vh / height };
    }

    // Pointer in CSS pixels of the window (mousemove clientX/clientY, y down from the top, as
    // linux-wallpaperengine's input drivers report it).
    setPointer(x, y, cssWidth, cssHeight) {
      this.pointer = [cssWidth > 0 ? x / cssWidth : 0.5, cssHeight > 0 ? y / cssHeight : 0.5];
    }

    // CScene::updateMouse: window space -> the visible part of the scene texture, y down
    updateMouse() {
      const m = this.mouse;
      m.positionLast.set(m.position);
      const clamp = (v) => Math.min(1, Math.max(0, v));
      const { vw, vh } = this.visible;
      const uvs = this.uvs;
      const px = clamp(this.pointer[0]) * this.width, py = clamp(this.pointer[1]) * this.height;
      m.position[0] = clamp(uvs.ustart + (px - (this.width - vw) / 2) / vw * (uvs.uend - uvs.ustart));
      m.position[1] = clamp(uvs.vstart + (py - (this.height - vh) / 2) / vh * (uvs.vend - uvs.vstart));
    }
  }

  const api = { Camera, Parallax, Shake, Fade, Viewport, FITS, noise1, FADE_SECONDS };
  G.WECamera = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();

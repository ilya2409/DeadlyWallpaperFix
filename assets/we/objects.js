// Scene objects: the base object every layer type shares (id, parent chain, origin/scale/angles/
// visible bindings), sound layers, light layers and the type registry other modules extend.
// Ports Data/Parsers/ObjectParser.cpp (base and sound data), Render/CObject.cpp,
// CImage::localTransform/resolveTransform and Render/Objects/CSound.cpp.
(() => {
  'use strict';
  const G = typeof window !== 'undefined' ? window : globalThis;
  const M = G.WEM;
  const V = G.WEV;

  const MAX_PARENT_DEPTH = 32;
  const LIGHT_KINDS = { point: 'point', lpoint: 'point', spot: 'spot', lspot: 'spot', tube: 'tube', ltube: 'tube', directional: 'directional', ldirectional: 'directional' };
  const DEFAULT_CASCADES = [0.3, 0.4, 8];

  // ObjectParser::parseDependencies
  function parseDependencies(json) {
    if (!Array.isArray(json.dependencies)) return [];
    return json.dependencies.map((d) => {
      if (typeof d !== 'number') throw new Error('object ' + json.id + ': dependency ' + JSON.stringify(d) + ' is not an object id');
      return d;
    });
  }

  function rotateVec2(x, y, angle) {
    const c = Math.cos(angle), s = Math.sin(angle);
    return [x * c - y * s, x * s + y * c];
  }

  /** ObjectData + CObject: what every scene.json object carries. */
  class SceneObject {
    constructor(scene, json) {
      if (!json || typeof json !== 'object') throw new Error('scene object is not a JSON object');
      if (typeof json.id !== 'number') throw new Error('object must have an id (' + JSON.stringify(json).slice(0, 80) + ')');
      this.scene = scene;
      this.json = json;
      this.id = json.id;
      this.name = typeof json.name === 'string' ? json.name : (typeof json.name === 'number' ? String(json.name) : '');
      this.dependencies = parseDependencies(json);
      this.parent = typeof json.parent === 'number' ? json.parent : null;
      // Name of the parent's puppet attachment this object hangs on, from "attachment" or SceneScript setParent
      this.parentAttachment = typeof json.attachment === 'string' && json.attachment.length ? json.attachment : null;
      this.origin = this.setting('origin', 'vec3', [0, 0, 0]);
      this.scale = this.setting('scale', 'vec3', [1, 1, 1]);
      this.angles = this.setting('angles', 'vec3', [0, 0, 0]);
      this.visible = this.setting('visible', 'bool', true);
      this.initialized = false;
    }

    // A scene.json value of this object as a Dynamic (literal, {"user":...}, script, animation).
    setting(key, kind, dflt, expectColor) {
      return G.WEProps.setting(this.json[key], {
        kind, default: dflt, expectColor: !!expectColor,
        where: 'object ' + this.id + '.' + key,
        properties: this.scene.properties,
      });
    }

    async setup() { this.initialized = true; }
    update() {}
    render() {}
    setPaused() {}
    dispose() {}

    // Visible itself and under visible parents, unless "disablepropagation" cuts it loose
    shown() {
      if (!this.visible.getBool()) return false;
      if (this.parent === null || this.json.disablepropagation === true) return true;
      const parentObject = this.scene.getObject(this.parent);
      return !parentObject || parentObject.shown();
    }

    // Objects marked solid draw before the transparent ones a 3D scene sorts
    isSolid() { return this.json.solid === true; }

    // Rotation of the object's angles, z then y then x, in the scene's own handedness
    rotationMatrix(angles) {
      const flip = this.scene.is3D ? 1 : -1;
      let m = M.identity();
      if (angles[2] !== 0) m = M.rotate(m, flip * angles[2], 0, 0, 1);
      if (angles[1] !== 0) m = M.rotate(m, angles[1], 0, 1, 0);
      if (angles[0] !== 0) m = M.rotate(m, flip * angles[0], 1, 0, 0);
      return m;
    }

    // World transform of a 3D scene object, parents folded in
    worldMatrix() {
      const t = this.localTransform();
      let m = M.translation(t.origin[0], t.origin[1], t.origin[2]);
      m = M.multiply(m, this.rotationMatrix(t.angles));
      m = M.scale(m, t.scale[0], t.scale[1], t.scale[2]);
      if (this.parent !== null) {
        const parentObject = this.scene.getObject(this.parent);
        if (parentObject) m = M.multiply(parentObject.worldMatrix(), m);
      }
      return m;
    }

    // Where the object sits in the space lights and cameras use
    worldPosition() {
      if (this.scene.is3D) { const m = this.worldMatrix(); return [m[12], m[13], m[14]]; }
      const t = this.resolveTransform();
      return [t.origin[0] - this.scene.width / 2, this.scene.height / 2 - t.origin[1], t.origin[2]];
    }

    // World rotation with every parent's angles folded in
    worldRotation() {
      if (this.scene.is3D) {
        const m = this.worldMatrix();
        const r = M.clone(m);
        const sx = Math.hypot(m[0], m[1], m[2]) || 1, sy = Math.hypot(m[4], m[5], m[6]) || 1, sz = Math.hypot(m[8], m[9], m[10]) || 1;
        r[0] /= sx; r[1] /= sx; r[2] /= sx; r[4] /= sy; r[5] /= sy; r[6] /= sy; r[8] /= sz; r[9] /= sz; r[10] /= sz;
        r[12] = 0; r[13] = 0; r[14] = 0;
        return r;
      }
      return this.rotationMatrix(this.resolveTransform().angles);
    }

    viewDepth() { return this.scene.camera.viewDepth(this.worldPosition()); }

    // CImage::localTransform
    localTransform() {
      const angles = this.angles.getVec(3);
      return { origin: this.origin.getVec(3), scale: this.scale.getVec(3), angles, angle: angles[2] };
    }

    // CImage::resolveTransform: fold this object's transform onto its parents', root first.
    resolveTransform() {
      const chain = [this];
      let current = this;
      while (current.parent !== null) {
        if (chain.length > MAX_PARENT_DEPTH) throw new Error('parent chain of object ' + current.id + ' is deeper than ' + MAX_PARENT_DEPTH + ' levels; it loops');
        const parentObject = this.scene.getObject(current.parent);
        if (!parentObject) break;
        current = parentObject;
        chain.push(current);
      }
      let resolved = chain[chain.length - 1].localTransform();
      for (let i = chain.length - 2; i >= 0; i--) {
        const local = chain[i].localTransform();
        if (chain[i].parentAttachment !== null) {
          const parentObject = chain[i + 1];
          if (typeof parentObject.attachmentTransform !== 'function') throw new Error('object ' + chain[i].id + ' hangs on attachment ' + JSON.stringify(chain[i].parentAttachment) + ' of object ' + parentObject.id + ', which has no puppet attachments');
          // Attachment offsets are in the parent's layer space (y down from the image top); scene space runs y up
          const att = parentObject.attachmentTransform(chain[i].parentAttachment);
          local.origin = [local.origin[0] + att.origin[0], local.origin[1] - att.origin[1], local.origin[2] + att.origin[2]];
          local.angles = [local.angles[0], local.angles[1], local.angles[2] - att.angle];
          local.angle = local.angles[2];
        }
        const offset = rotateVec2(local.origin[0] * resolved.scale[0], local.origin[1] * resolved.scale[1], resolved.angle);
        const origin = [resolved.origin[0] + offset[0], resolved.origin[1] + offset[1], resolved.origin[2] + local.origin[2] * resolved.scale[2]];
        const angles = [local.angles[0] + resolved.angles[0], local.angles[1] + resolved.angles[1], local.angles[2] + resolved.angles[2]];
        resolved = {
          origin,
          scale: [local.scale[0] * resolved.scale[0], local.scale[1] * resolved.scale[1], local.scale[2] * resolved.scale[2]],
          angles,
          angle: angles[2],
        };
      }
      return resolved;
    }
  }

  /**
   * Sound layer (SoundData + CSound): "sound" lists the files, "playbackmode" is "loop",
   * "random" or absent (play once), "volume" scales the host's volume, "mintime"/"maxtime"
   * bound the pause between random plays in seconds.
   */
  class Sound extends SceneObject {
    constructor(scene, json) {
      super(scene, json);
      if (!Array.isArray(json.sound) || !json.sound.length) throw new Error('object ' + this.id + ': sound object must list its sound files');
      this.sounds = json.sound.map((s) => {
        if (typeof s !== 'string' || !s.length) throw new Error('object ' + this.id + ': sound entry ' + JSON.stringify(s) + ' is not a file name');
        return s;
      });
      this.playbackmode = typeof json.playbackmode === 'string' ? (json.playbackmode === 'single' ? 'once' : json.playbackmode) : null;
      if (this.playbackmode !== null && this.playbackmode !== 'loop' && this.playbackmode !== 'random' && this.playbackmode !== 'once') {
        throw new Error('object ' + this.id + ': playbackmode "' + this.playbackmode + '" is not loop, random, once or single');
      }
      this.volume = this.setting('volume', 'float', 1);
      this.mintime = this.setting('mintime', 'float', 0);
      this.maxtime = this.setting('maxtime', 'float', 0);
      this.elements = [];
      this.timer = 0;
      this.paused = false;
    }

    // The bridge sets element.volume/muted for the host; the layer volume multiplies it here.
    attachVolume(el) {
      const proto = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'volume');
      let host = 1;
      const apply = () => { proto.set.call(el, Math.max(0, Math.min(1, host * this.volume.getNumber()))); };
      Object.defineProperty(el, 'volume', {
        configurable: true,
        get: () => host,
        set: (v) => { host = Number(v); apply(); },
      });
      this.volume.listen(apply);
      apply();
    }

    async setup() {
      const container = this.scene.mediaContainer();
      for (const file of this.sounds) {
        const el = document.createElement('audio');
        el.preload = 'auto';
        el.src = this.scene.loader.url(file);
        el.loop = this.playbackmode === 'loop';
        this.attachVolume(el);
        container.appendChild(el);
        this.elements.push(el);
      }
      if (this.playbackmode === 'random') {
        for (const el of this.elements) el.addEventListener('ended', () => this.scheduleRandom());
        this.playRandom();
      } else {
        for (const el of this.elements) this.play(el);
      }
      this.initialized = true;
    }

    play(el) {
      const p = el.play();
      if (p && typeof p.catch === 'function') p.catch((e) => console.error('sound object ' + this.id + ' could not start ' + el.src, e));
    }

    playRandom() {
      if (this.paused || !this.elements.length) return;
      const el = this.elements[Math.floor(Math.random() * this.elements.length)];
      el.currentTime = 0;
      this.play(el);
    }

    scheduleRandom() {
      const min = this.mintime.getNumber(), max = Math.max(min, this.maxtime.getNumber());
      const delay = min + Math.random() * (max - min);
      clearTimeout(this.timer);
      this.timer = setTimeout(() => { this.timer = 0; this.playRandom(); }, delay * 1000);
    }

    setPaused(paused) {
      this.paused = paused;
      for (const el of this.elements) {
        if (paused) el.pause();
        else if (!el.ended || this.playbackmode === 'loop') this.play(el);
      }
      if (paused) { clearTimeout(this.timer); this.timer = 0; }
      else if (this.playbackmode === 'random' && this.elements.every((el) => el.paused)) this.scheduleRandom();
    }

    dispose() {
      clearTimeout(this.timer);
      for (const el of this.elements) { el.pause(); el.removeAttribute('src'); el.load(); el.remove(); }
      this.elements = [];
    }
  }

  /**
   * Light layer: "light" names the kind (point, spot, tube, directional, with or without the l
   * prefix the editor writes). Colour, intensity, radius and exponent feed the LightingV1 module,
   * castshadow reserves shadow atlas space, density turns on the light's volume, cone angles
   * shape spot lights, length tube lights and the cascade distances directional shadows.
   */
  class Light extends SceneObject {
    constructor(scene, json) {
      super(scene, json);
      const kind = LIGHT_KINDS[String(json.light === undefined || json.light === null ? 'point' : json.light).toLowerCase()];
      if (!kind) throw new Error('object ' + this.id + ': light kind "' + json.light + '" is not point, spot, tube or directional');
      this.kind = kind;
      this.color = this.setting('color', 'color', [1, 1, 1], true);
      this.intensity = this.setting('intensity', 'float', 1);
      this.radius = this.setting('radius', 'float', 100);
      this.exponent = this.setting('exponent', 'float', 1);
      this.castShadow = json.castshadow === true;
      this.density = this.setting('density', 'float', 0);
      this.volumetricsExponent = this.setting('volumetricsexponent', 'float', 1);
      this.cascades = [0, 1, 2].map((i) => this.setting('cascadedistance' + i, 'float', DEFAULT_CASCADES[i]));
      const first = (keys, dflt) => { for (const k of keys) if (json[k] !== undefined && json[k] !== null) return this.setting(k, 'float', dflt); return G.WEProps.setting(dflt, { kind: 'float', default: dflt, where: 'object ' + this.id + '.' + keys[0], properties: scene.properties }); };
      this.innerAngle = first(['innerangle', 'coneinnerangle', 'spotinnerangle'], 30);
      this.outerAngle = first(['outerangle', 'coneangle', 'spotangle', 'angle'], 45);
      this.length = first(['length', 'tubelength'], 100);
      this.shadowRegions = null;
    }

    // Lights shine along their local x axis
    forward() {
      const r = this.worldRotation();
      return V.normalize([r[0], r[1], r[2]]);
    }

    coneAngles() {
      const outer = Math.max(0.5, Math.min(89.5, this.outerAngle.getNumber())) * Math.PI / 180;
      const inner = Math.min(outer, Math.max(0, this.innerAngle.getNumber()) * Math.PI / 180);
      return { inner: Math.min(inner, outer - 1e-3), outer };
    }

    tubeEndpoints() {
      const o = this.worldPosition();
      const half = V.scale(this.forward(), this.length.getNumber() / 2);
      return [V.sub(o, half), V.add(o, half)];
    }

    // View depths where the three shadow cascades end, as fractions of the radius
    cascadeSplits() {
      const radius = this.radius.getNumber();
      const splits = this.cascades.map((c) => Math.max(1e-3, c.getNumber()) * radius);
      for (let i = 1; i < splits.length; i++) splits[i] = Math.max(splits[i], splits[i - 1] * 1.001);
      return splits;
    }

    premultipliedColor() {
      const c = this.color.getVec(3), i = this.intensity.getNumber();
      return [c[0] * i, c[1] * i, c[2] * i];
    }
  }

  // ---- registry ------------------------------------------------------------------------------
  const registry = [];

  /**
   * Register a constructor for objects carrying `key` in their scene.json entry; higher
   * priority wins when several keys are present. `ctor` is `new (scene, json)`, a SceneObject.
   */
  function register(key, ctor, priority) {
    registry.push({ key, ctor, priority: priority || 0 });
    registry.sort((a, b) => b.priority - a.priority);
  }

  // CScene::dispatchObjectType: the first registered key present picks the type; objects with no
  // known key (groups, "solid" placeholders) become plain SceneObjects.
  function create(scene, json) {
    for (const entry of registry) {
      if (json[entry.key] !== undefined && json[entry.key] !== null) return new entry.ctor(scene, json);
    }
    return new SceneObject(scene, json);
  }

  register('sound', Sound);
  register('light', Light);

  const api = { SceneObject, Sound, Light, register, create, registry, parseDependencies, rotateVec2 };
  G.WEObjects = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();

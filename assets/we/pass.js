// One material pass of an image or effect: its compiled shader, texture chains, built-in and
// material uniforms, render state and draw. Port of Render/Objects/Effects/CPass.cpp.
(() => {
  'use strict';
  const G = typeof window !== 'undefined' ? window : globalThis;
  const M = G.WEM;

  const TEXTURE_UNITS = 8;
  const IDENTITY4 = M.identity();
  const EMPTY_OVERRIDE = { combos: {}, constants: {}, textures: {}, usertextures: {}, textureUsers: {}, shaderOverride: null };

  function isFBOName(name) { return name.indexOf('_rt_') === 0 || name.indexOf('_alias_') === 0; }

  // Fill `out` (n floats) from a number, a vector, or a shorter vector (padded with 0, w = 1),
  // tiling a single vector over uniform arrays.
  function fill(out, value, comps) {
    const n = out.length;
    if (typeof value === 'number') { out.fill(value); return out; }
    if (typeof value === 'boolean') { out.fill(value ? 1 : 0); return out; }
    if (value === null || value === undefined || typeof value.length !== 'number') throw new Error('uniform value ' + String(value) + ' is neither a number nor a vector');
    const len = value.length;
    if (len >= n) { for (let i = 0; i < n; i++) out[i] = value[i]; return out; }
    if (comps > 1 && len <= comps) {
      for (let i = 0; i < n; i++) { const c = i % comps; out[i] = c < len ? value[c] : (c === 3 ? 1 : 0); }
      return out;
    }
    for (let i = 0; i < n; i++) out[i] = i < len ? value[i] : 0;
    return out;
  }

  function scalar(value) {
    if (typeof value === 'number') return value;
    if (typeof value === 'boolean') return value ? 1 : 0;
    if (value && typeof value.length === 'number') return value[0];
    throw new Error('uniform value ' + String(value) + ' is not a number');
  }

  // glUniform* by the type WebGL reported for the uniform.
  function setUniform(gl, u, value) {
    const loc = u.location;
    switch (u.type) {
      case gl.FLOAT:
        if (u.size > 1) gl.uniform1fv(loc, fill(u.scratch, value, 1)); else gl.uniform1f(loc, scalar(value));
        return;
      case gl.FLOAT_VEC2: gl.uniform2fv(loc, fill(u.scratch, value, 2)); return;
      case gl.FLOAT_VEC3: gl.uniform3fv(loc, fill(u.scratch, value, 3)); return;
      case gl.FLOAT_VEC4: gl.uniform4fv(loc, fill(u.scratch, value, 4)); return;
      case gl.INT: case gl.BOOL: case gl.SAMPLER_2D: case gl.SAMPLER_2D_SHADOW: case gl.UNSIGNED_INT:
        if (u.size > 1) gl.uniform1iv(loc, fill(u.iscratch, value, 1)); else gl.uniform1i(loc, Math.trunc(scalar(value)));
        return;
      case gl.INT_VEC2: case gl.BOOL_VEC2: gl.uniform2iv(loc, fill(u.iscratch, value, 2)); return;
      case gl.INT_VEC3: case gl.BOOL_VEC3: gl.uniform3iv(loc, fill(u.iscratch, value, 3)); return;
      case gl.INT_VEC4: case gl.BOOL_VEC4: gl.uniform4iv(loc, fill(u.iscratch, value, 4)); return;
      case gl.FLOAT_MAT2: gl.uniformMatrix2fv(loc, false, fill(u.scratch, value, 4)); return;
      case gl.FLOAT_MAT3: gl.uniformMatrix3fv(loc, false, fill(u.scratch, value, 9)); return;
      case gl.FLOAT_MAT4: gl.uniformMatrix4fv(loc, false, fill(u.scratch, value, 16)); return;
      case gl.FLOAT_MAT4x3: gl.uniformMatrix4x3fv(loc, false, fill(u.scratch, value, 12)); return;
      case gl.FLOAT_MAT3x4: gl.uniformMatrix3x4fv(loc, false, fill(u.scratch, value, 12)); return;
      default:
        throw new Error('uniform ' + u.name + ' has a type (0x' + u.type.toString(16) + ') this renderer cannot set');
    }
  }

  function componentsOf(gl, type) {
    switch (type) {
      case gl.FLOAT_VEC2: case gl.INT_VEC2: case gl.BOOL_VEC2: return 2;
      case gl.FLOAT_VEC3: case gl.INT_VEC3: case gl.BOOL_VEC3: return 3;
      case gl.FLOAT_VEC4: case gl.INT_VEC4: case gl.BOOL_VEC4: case gl.FLOAT_MAT2: return 4;
      case gl.FLOAT_MAT3: return 9;
      case gl.FLOAT_MAT4: return 16;
      case gl.FLOAT_MAT4x3: case gl.FLOAT_MAT3x4: return 12;
      default: return 1;
    }
  }

  // A shader parameter read from a Dynamic in the parameter's declared type.
  function dynamicGetter(parameter, dyn) {
    switch (parameter.type) {
      case 'float': return () => dyn.getNumber();
      case 'int': return () => Math.trunc(dyn.getNumber());
      case 'vec2': return () => dyn.getVec(2);
      case 'vec3': return () => dyn.getVec(3);
      case 'vec4': return () => dyn.getVec(4);
      default: throw new Error('shader parameter ' + parameter.name + ' has an unknown type ' + parameter.type);
    }
  }

  /**
   * CPass. `renderable` supplies: scene, id, texture (provider), getBrightness(), getUserAlpha(),
   * getAlpha(), getColor(), getColor4(), getCompositeColor(), animationTime.
   * `override` is a scene.json effect pass override, `binds` an effect pass's texture binds,
   * `target` the FBO name the pass writes to (null: the image's ping-pong buffers). A
   * renderable may also offer `passUniforms(pass)` returning extra uniform getters by name.
   */
  class Pass {
    constructor(renderable, fboProvider, materialPass, override, binds, target, previousTarget) {
      this.renderable = renderable;
      this.scene = renderable.scene;
      this.gl = this.scene.gl;
      this.fboProvider = fboProvider;
      this.pass = materialPass;
      this.override = override || EMPTY_OVERRIDE;
      this.binds = binds || {};
      this.target = target || null;
      this.previousTarget = previousTarget || null;
      this.blendingMode = materialPass.blending;
      this.combos = {};
      this.textures = {};
      this.uniforms = new Map();
      this.uniformList = [];
      this.attribs = [];
      this.slotResolutions = {};
      this.slotTexels = [];
      this.slotMipLevels = new Float32Array(TEXTURE_UNITS).fill(1);
      this.readsMipMappedFrame = false;
      for (let i = 0; i < TEXTURE_UNITS; i++) this.slotTexels.push(new Float32Array([1, 1, 1, 1]));
      this.borderMask = 0;
      this.extraUniforms = {};
      this.viewportRect = null;
      this.depthOnly = false;
      this.cullFront = false;
      this.normalMatrixCache = { source: null, matrix: new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]) };
      this.texture0Resolution = new Float32Array(4);
      this.mvp = IDENTITY4;
      this.mvpInverse = IDENTITY4;
      this.modelMatrix = IDENTITY4;
      this.viewProjectionMatrix = IDENTITY4;
      this.drawTo = null;
      this.input = null;
      this.previousInput = null;
      this.positionBuffer = null;
      this.texcoordBuffer = null;
      this.geometry = null;
      this.program = null;
      this.shader = null;
      this.vao = null;
    }

    // CPass::resolveFBO
    resolveFBO(name) {
      const fbo = this.fboProvider.find(name);
      if (!fbo) throw new Error('tried to resolve an FBO without any luck: ' + name + ' (object ' + this.renderable.id + ', shader ' + this.pass.shader + ')');
      return fbo;
    }

    resolveTextureName(name) {
      return isFBOName(name) ? Promise.resolve(this.resolveFBO(name)) : this.scene.textures.resolve(name);
    }

    async build() {
      await this.setupShaders();
      return this;
    }

    // CPass::setupShaders
    async setupShaders() {
      const gl = this.gl;
      const texture0 = this.renderable.texture;
      Object.assign(this.combos, this.scene.engineCombos(), this.pass.combos);
      const shaderName = this.override.shaderOverride || this.pass.shader;
      const passTextures = Object.assign({}, this.pass.textures, this.pass.usertextures);
      const constants = {};
      for (const [k, d] of Object.entries(this.pass.constants)) constants[k] = d.get();
      for (const [k, d] of Object.entries(this.override.constants)) constants[k] = d.get();
      this.shader = await G.WEShader.Shader.load(this.scene.loader, shaderName, {
        combos: this.combos,
        overrideCombos: this.override.combos,
        constants,
        passTextures,
        overrideTextures: this.override.textures,
      });
      await this.resolveFormatCombos(texture0);
      const built = G.WEShader.buildProgram(gl, this.shader);
      this.program = built.program;
      this.programUniforms = built.uniforms;
      this.programAttributes = built.attributes;
      this.vao = gl.createVertexArray();
      this.setupShaderVariables();
      await this.setupUniforms();
      this.setupAttributes();
      this.g_Texture0Rotation = this.programUniforms.g_Texture0Rotation ? this.programUniforms.g_Texture0Rotation.location : null;
      this.g_Texture0Translation = this.programUniforms.g_Texture0Translation ? this.programUniforms.g_Texture0Translation.location : null;
    }

    // CPass::addUniform: only uniforms the program actually has are tracked; a later
    // registration of the same name replaces the earlier one.
    addUniform(name, get) {
      const info = this.programUniforms[name];
      if (!info) return false;
      const gl = this.gl;
      const comps = componentsOf(gl, info.type);
      const entry = { name, location: info.location, type: info.type, size: info.size, get, scratch: new Float32Array(comps * info.size), iscratch: new Int32Array(comps * info.size) };
      this.uniforms.set(name, entry);
      return true;
    }

    hasUniform(name) { return this.uniforms.has(name); }

    // CPass::setupShaderVariables: shader defaults, then material constants, then overrides.
    setupShaderVariables() {
      for (const unit of [this.shader.vertex, this.shader.fragment]) {
        for (const p of unit.parameters) {
          if (!this.uniforms.has(p.name)) this.addUniform(p.name, () => p.value);
        }
      }
      for (const [identifier, dyn] of Object.entries(this.pass.constants)) {
        const found = this.shader.findParameter(identifier);
        const parameter = found.vertex || found.fragment;
        if (!parameter) continue;
        this.addUniform(parameter.name, dynamicGetter(parameter, dyn));
      }
      for (const [identifier, dyn] of Object.entries(this.override.constants)) {
        const found = this.shader.findParameter(identifier);
        const parameter = found.vertex || found.fragment;
        if (!parameter) continue;
        this.addUniform(parameter.name, dynamicGetter(parameter, dyn));
      }
    }

    // TEX<n>FORMAT tells shader code sampling a formatcombo slot which texture format it reads
    async resolveFormatCombos(texture0) {
      const slots = Object.assign({}, this.shader.vertex.formatCombos, this.shader.fragment.formatCombos);
      if (texture0) slots[0] = true;
      for (const key of Object.keys(slots)) {
        const index = parseInt(key, 10);
        const combo = 'TEX' + index + 'FORMAT';
        if (combo in this.combos) continue;
        const texture = index === 0 && texture0 ? texture0 : await this.slotTexture(index);
        // An unbound slot samples opaque black whatever format the shader is told
        const format = texture ? (texture.current ? texture.current.format : texture.format) : G.WETex.FORMAT.RGBA8888;
        this.combos[combo] = format;
      }
    }

    // The texture a slot ends up sampling, layered the way setupTextureUniforms layers them
    async slotTexture(index) {
      const sources = [this.binds, this.override.usertextures, this.override.textures, this.pass.usertextures, this.pass.textures, this.shader.fragment.defaultTextures, this.shader.vertex.defaultTextures];
      for (const map of sources) {
        const name = map ? map[index] : undefined;
        if (name === undefined || name === null) continue;
        if (name === 'previous') return this.previousTarget ? this.resolveFBO(this.previousTarget) : (this.renderable.mainFBO || null);
        return this.resolveTextureName(name);
      }
      return null;
    }

    // Prepend a chain entry for a slot (later registrations take precedence, CPass::setupTextureUniforms).
    async pushTexture(index, name) {
      const texture = await this.resolveTextureName(name);
      this.textures[index] = { texture, next: this.textures[index] || null };
    }

    // CPass::setupTextureUniforms
    async setupTextureUniforms() {
      const entries = (map) => Object.entries(map || {}).map(([k, v]) => [parseInt(k, 10), v]);
      for (const [index, name] of entries(this.shader.vertex.defaultTextures)) await this.pushTexture(index, name);
      for (const [index, name] of entries(this.shader.fragment.defaultTextures)) await this.pushTexture(index, name);
      for (const [index, name] of entries(this.pass.textures)) await this.pushTexture(index, name);
      for (const [index, name] of entries(this.pass.usertextures)) await this.pushTexture(index, name);
      for (const [index, name] of entries(this.override.textures)) await this.pushTexture(index, name);
      for (const [index, name] of entries(this.override.usertextures)) await this.pushTexture(index, name);
      const mipmapped = this.scene.fbos.find('_rt_MipMappedFrameBuffer');
      for (const chain of Object.values(this.textures)) for (let c = chain; c; c = c.next) if (c.texture === mipmapped) this.readsMipMappedFrame = true;
      // binds are set last as they're the most important
      for (const [index, bind] of entries(this.binds)) {
        const texture = bind === 'previous' ? null : this.resolveFBO(bind);
        this.textures[index] = { texture, next: this.textures[index] || null };
      }
      // texture user properties replace a slot's texture while the property names one
      const users = Object.assign({}, this.pass.textureUsers, this.override.textureUsers);
      for (const [index, property] of entries(users)) this.bindTextureProperty(index, property);
      for (let i = 0; i < TEXTURE_UNITS; i++) { const unit = i; this.addUniform('g_Texture' + i, () => unit); }
      this.addUniform('g_TextureReductionScale', () => 1);
      this.addUniform('g_WEBorderMask', () => this.borderMask);
      this.addUniform('g_Texture0Resolution', () => this.texture0Resolution);
      for (const index of Object.keys(this.textures)) {
        const slot = parseInt(index, 10);
        if (slot === 0) continue;
        this.addUniform('g_Texture' + slot + 'Resolution', () => this.slotResolutions[slot] || this.texture0Resolution);
      }
    }

    // A texture slot bound to a texture user property: the property's value names the texture
    // to use; an empty value restores the material's own chain.
    bindTextureProperty(index, property) {
      const original = this.textures[index] || null;
      const ref = new G.WETextures.TextureRef('user:' + property, original ? original.texture : null);
      const apply = (value) => {
        if (typeof value !== 'string' || !value.trim().length) { ref.current = original ? original.texture : null; return; }
        const name = value.trim().replace(/\.tex$/i, '');
        this.scene.textures.resolve(name).then((texture) => { ref.current = texture; }).catch((e) => this.scene.fail(e));
      };
      const dyn = G.WEProps.setting({ value: '', user: property }, { kind: 'string', where: 'texture property ' + property, properties: this.scene.properties });
      dyn.listen((value) => apply(value));
      if (dyn.get()) apply(dyn.get());
      this.textures[index] = { texture: ref, next: original };
    }

    // CPass::setupUniforms: the engine-provided values every shader may read.
    async setupUniforms() {
      await this.setupTextureUniforms();
      const scene = this.scene, r = this.renderable;
      this.addUniform('g_LightAmbientColor', () => scene.colors.ambient.getVec(3));
      this.addUniform('g_LightSkylightColor', () => scene.colors.skylight.getVec(3));
      this.addUniform('g_Brightness', () => r.getBrightness());
      this.addUniform('g_UserAlpha', () => r.getUserAlpha());
      this.addUniform('g_Alpha', () => r.getAlpha());
      this.addUniform('g_Color', () => r.getColor());
      this.addUniform('g_Color4', () => r.getColor4());
      if (!this.uniforms.has('g_CompositeColor')) this.addUniform('g_CompositeColor', () => r.getCompositeColor());
      this.addUniform('g_Time', () => scene.time);
      this.addUniform('g_Daytime', () => scene.daytime);
      this.addUniform('g_ModelViewProjectionMatrixInverse', () => this.mvpInverse);
      this.addUniform('g_ModelViewProjectionMatrix', () => this.mvp);
      this.addUniform('g_EffectModelViewProjectionMatrix', () => this.mvp);
      this.addUniform('g_ModelMatrix', () => this.modelMatrix);
      this.addUniform('g_EffectModelMatrix', () => this.modelMatrix);
      this.addUniform('g_NormalModelMatrix', () => this.normalMatrix());
      this.addUniform('g_AltNormalModelMatrix', () => this.normalMatrix());
      this.addUniform('g_ViewProjectionMatrix', () => this.viewProjectionMatrix);
      this.addUniform('g_AltModelMatrix', () => this.modelMatrix);
      this.addUniform('g_AltViewProjectionMatrix', () => this.viewProjectionMatrix);
      this.addUniform('g_EyePosition', () => scene.camera.eyePosition);
      for (let i = 0; i < TEXTURE_UNITS; i++) {
        const slot = i;
        this.addUniform('g_Texture' + i + 'Texel', () => this.slotTexels[slot]);
        this.addUniform('g_Texture' + i + 'MipMapInfo', () => this.slotMipLevels[slot]);
      }
      if (scene.lights) for (const [name, get] of Object.entries(scene.lights.uniforms())) this.addUniform(name, get);
      this.addUniform('g_PointerPosition', () => scene.mouse.position);
      this.addUniform('g_PointerPositionLast', () => scene.mouse.positionLast);
      this.addUniform('g_EffectTextureProjectionMatrix', () => IDENTITY4);
      this.addUniform('g_EffectTextureProjectionMatrixInverse', () => IDENTITY4);
      this.addUniform('g_TexelSize', () => scene.texelSize);
      this.addUniform('g_TexelSizeHalf', () => scene.texelSizeHalf);
      this.addUniform('g_ParallaxPosition', () => scene.parallaxDisplacement);
      this.addUniform('g_Screen', () => scene.screen);
      let audio = false;
      audio = this.addUniform('g_AudioSpectrum16Left', () => scene.audio.left16) || audio;
      audio = this.addUniform('g_AudioSpectrum16Right', () => scene.audio.right16) || audio;
      audio = this.addUniform('g_AudioSpectrum32Left', () => scene.audio.left32) || audio;
      audio = this.addUniform('g_AudioSpectrum32Right', () => scene.audio.right32) || audio;
      audio = this.addUniform('g_AudioSpectrum64Left', () => scene.audio.left64) || audio;
      audio = this.addUniform('g_AudioSpectrum64Right', () => scene.audio.right64) || audio;
      if (audio) scene.requireAudio();
      // Renderables with vertex streams of their own (particles, puppets) supply the uniforms
      // their shaders read beyond the engine set: `passUniforms(pass)` -> {name: getter}.
      if (typeof r.passUniforms === 'function') {
        for (const [name, get] of Object.entries(r.passUniforms(this))) this.addUniform(name, get);
      }
      for (const [name, get] of Object.entries(this.extraUniforms)) this.addUniform(name, get);
      for (const [name, info] of Object.entries(this.programUniforms)) {
        if (this.uniforms.has(name)) continue;
        if (info.type === this.gl.SAMPLER_2D || info.type === this.gl.SAMPLER_2D_SHADOW) continue;
        if (/^g_Texture\d+(Rotation|Translation|Resolution|Texel|MipMapInfo)$/.test(name)) continue;
        throw new Error('shader ' + this.pass.shader + ' reads uniform ' + name + ', which neither the engine nor the material provides');
      }
      this.uniformList = Array.from(this.uniforms.values());
    }

    // The inverse transpose of the model matrix's upper 3x3, which carries normals to world space
    normalMatrix() {
      const cache = this.normalMatrixCache;
      if (cache.source === this.modelMatrix && cache.stamp === this.scene.time) return cache.matrix;
      const t = M.transpose(M.inverse(this.modelMatrix));
      cache.matrix.set([t[0], t[1], t[2], t[4], t[5], t[6], t[8], t[9], t[10]]);
      cache.source = this.modelMatrix;
      cache.stamp = this.scene.time;
      return cache.matrix;
    }

    // CPass::setupAttributes / addAttribute
    setupAttributes() {
      this.addAttribute('a_TexCoord', 2, () => this.texcoordBuffer);
      this.addAttribute('a_Position', 3, () => this.positionBuffer);
    }

    addAttribute(name, elements, getBuffer) {
      const info = this.programAttributes[name];
      if (!info || info.location < 0) return;
      this.attribs.push({ name, location: info.location, elements, getBuffer });
    }

    // CPass::resolveTexture
    resolveTexture(expected, index, previous) {
      const bind = this.binds[index];
      if (bind === undefined) return expected;
      if (bind === 'previous') return this.previousInput || previous || expected;
      return this.resolveFBO(bind);
    }

    // CPass::resolveTexture0: walk the slot-0 chain to the first ready texture.
    resolveTexture0() {
      let texture0 = this.resolveTexture(this.input, 0, this.input);
      let chain = this.textures[0];
      if (!chain) return texture0;
      do {
        texture0 = chain.texture;
        if (!texture0) {
          if (this.previousInput && this.previousInput.isReady()) return this.previousInput;
          if (this.input && this.input.isReady()) return this.input;
        } else if (texture0.isReady()) {
          return texture0;
        }
        chain = chain.next;
      } while (chain);
      if (this.previousInput && this.previousInput.isReady()) return this.previousInput;
      return this.input;
    }

    // CPass::resolveTextureAnimationState: which frame of an animated texture is current.
    resolveTextureAnimationState(texture) {
      const state = { currentTexture: 0, translation: [0, 0], rotation: [0, 0, 0, 0] };
      if (!texture || !texture.animated) return state;
      const total = this.renderable.animationTime;
      if (!(total > 0)) return state;
      // Renderables with playback control (ITextureAnimation) supply their own clock.
      const clock = typeof this.renderable.animationClock === 'function' ? this.renderable.animationClock() : this.scene.time;
      let remaining = ((clock % total) + total) % total;
      for (const frame of texture.frames) {
        remaining -= frame.frametime;
        if (remaining > 0) continue;
        state.currentTexture = frame.imageId;
        const tw = texture.textureWidth(state.currentTexture), th = texture.textureHeight(state.currentTexture);
        state.translation[0] = frame.x / tw;
        state.translation[1] = frame.y / th;
        state.rotation[0] = frame.width1 / tw;
        state.rotation[1] = frame.width2 / tw;
        state.rotation[2] = frame.height2 / th;
        state.rotation[3] = frame.height1 / th;
        break;
      }
      return state;
    }

    bindTextureUnit(index, texture, frame) {
      if (!texture) return;
      const gl = this.gl;
      const scene = this.scene;
      // Reading the frame buffer while drawing into it is a feedback loop, so such reads see a copy
      if (texture === scene.fbo && this.drawTo === scene.fbo) {
        texture = scene.frameCopy();
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.drawTo.framebuffer);
      }
      gl.activeTexture(gl.TEXTURE0 + index);
      gl.bindTexture(gl.TEXTURE_2D, texture.textureId(frame));
      this.slotResolutions[index] = texture.resolution;
      const tw = texture.textureWidth(frame), th = texture.textureHeight(frame);
      if (index < TEXTURE_UNITS) {
        this.slotTexels[index].set([1 / tw, 1 / th, tw, th]);
        this.slotMipLevels[index] = texture.mipLevels || 1;
      }
      if (texture.flags & G.WETex.FLAG.CLAMP_UVS_BORDER) this.borderMask |= 1 << index;
    }

    // CPass::bindTextureOverrides
    bindTextureOverrides(currentTexture) {
      let texture0 = null;
      for (const [key, head] of Object.entries(this.textures)) {
        const index = parseInt(key, 10);
        let chain = head;
        let expected = chain.texture;
        do {
          if (!expected) {
            if (this.previousInput && this.previousInput.isReady()) { expected = this.previousInput; break; }
            if (this.input && this.input.isReady()) { expected = this.input; break; }
          } else if (expected.isReady()) {
            break;
          }
          chain = chain.next;
          expected = chain ? chain.texture : null;
        } while (chain);
        if (!expected && this.previousInput && this.previousInput.isReady()) expected = this.previousInput;
        if (!expected) expected = this.input;
        this.bindTextureUnit(index, expected, index === 0 ? currentTexture : 0);
        if (index === 0) texture0 = expected;
      }
      return texture0;
    }

    // CPass::setupRenderFramebuffer
    setupRenderFramebuffer() {
      const gl = this.gl;
      const Mat = G.WEMaterial;
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.drawTo.framebuffer);
      const rect = this.viewportRect;
      if (rect) gl.viewport(rect[0], rect[1], rect[2], rect[3]);
      else gl.viewport(0, 0, this.drawTo.realWidth, this.drawTo.realHeight);
      if (this.depthOnly) {
        // Shadow casters write depth only, every face, nudged back to keep receivers out of their own shadow
        gl.disable(gl.BLEND);
        gl.enable(gl.DEPTH_TEST);
        gl.depthFunc(gl.LEQUAL);
        gl.depthMask(true);
        gl.disable(gl.CULL_FACE);
        gl.enable(gl.POLYGON_OFFSET_FILL);
        gl.polygonOffset(1.1, 4);
        return;
      }
      gl.cullFace(this.cullFront ? gl.FRONT : gl.BACK);
      switch (this.blendingMode) {
        case Mat.BLENDING.TRANSLUCENT:
          gl.enable(gl.BLEND);
          gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
          break;
        case Mat.BLENDING.ADDITIVE:
          gl.enable(gl.BLEND);
          gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE, gl.SRC_ALPHA, gl.ONE);
          break;
        case Mat.BLENDING.NORMAL:
          gl.enable(gl.BLEND);
          gl.blendFuncSeparate(gl.ONE, gl.ZERO, gl.ONE, gl.ZERO);
          break;
        default:
          gl.disable(gl.BLEND);
          break;
      }
      if (this.pass.depthtest === Mat.DEPTHTEST.ENABLED) { gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL); } else gl.disable(gl.DEPTH_TEST);
      if (this.pass.cullmode === Mat.CULL.NORMAL) gl.enable(gl.CULL_FACE); else gl.disable(gl.CULL_FACE);
      gl.depthMask(this.pass.depthwrite === Mat.DEPTHWRITE.ENABLED);
    }

    // CPass::setupRenderTexture
    setupRenderTexture() {
      const gl = this.gl;
      gl.useProgram(this.program);
      this.borderMask = 0;
      let texture0 = this.resolveTexture0();
      const animation = this.resolveTextureAnimationState(texture0);
      this.bindTextureUnit(0, texture0, animation.currentTexture);
      const bound = this.bindTextureOverrides(animation.currentTexture);
      if (bound) texture0 = bound;
      if (texture0) this.texture0Resolution.set(texture0.resolution);
      if (this.g_Texture0Rotation !== null) gl.uniform4f(this.g_Texture0Rotation, animation.rotation[0], animation.rotation[1], animation.rotation[2], animation.rotation[3]);
      if (this.g_Texture0Translation !== null) gl.uniform2f(this.g_Texture0Translation, animation.translation[0], animation.translation[1]);
    }

    // CPass::setupRenderUniforms + setupRenderReferenceUniforms
    setupRenderUniforms() {
      const gl = this.gl;
      for (const u of this.uniformList) setUniform(gl, u, u.get());
    }

    // CPass::setupRenderAttributes
    setupRenderAttributes() {
      if (this.geometry) { this.geometry.setup(this); return; }
      const gl = this.gl;
      for (const a of this.attribs) {
        const buffer = a.getBuffer();
        if (!buffer) throw new Error('pass ' + this.pass.shader + ' of object ' + this.renderable.id + ' has no buffer for ' + a.name);
        gl.enableVertexAttribArray(a.location);
        gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
        gl.vertexAttribPointer(a.location, a.elements, gl.FLOAT, false, 0, 0);
      }
    }

    // Instanced materials such as fur draw INSTANCECOUNT copies told apart by gl_InstanceID
    instanceCount() {
      for (const combos of [this.combos, this.shader.fragment.discoveredCombos, this.shader.vertex.discoveredCombos]) {
        if (combos.INSTANCECOUNT !== undefined) return Math.max(1, combos.INSTANCECOUNT | 0);
      }
      return 1;
    }

    // CPass::renderGeometry
    renderGeometry() {
      const instances = this.instanceCount();
      if (this.geometry) { this.geometry.draw(this, instances); return; }
      if (instances > 1) this.gl.drawArraysInstanced(this.gl.TRIANGLES, 0, 6, instances);
      else this.gl.drawArrays(this.gl.TRIANGLES, 0, 6);
    }

    // CPass::cleanupRenderSetup
    cleanupRenderSetup() {
      const gl = this.gl;
      if (this.depthOnly) gl.disable(gl.POLYGON_OFFSET_FILL);
      if (this.cullFront) gl.cullFace(gl.BACK);
      if (this.geometry) this.geometry.cleanup(this);
      else for (const a of this.attribs) gl.disableVertexAttribArray(a.location);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, null);
      for (const key of Object.keys(this.textures)) {
        gl.activeTexture(gl.TEXTURE0 + parseInt(key, 10));
        gl.bindTexture(gl.TEXTURE_2D, null);
      }
    }

    // CPass::render
    render() {
      if (!this.drawTo) throw new Error('render pass ' + this.pass.shader + ' of object ' + this.renderable.id + ' has no destination FBO');
      if (!this.input) throw new Error('render pass ' + this.pass.shader + ' of object ' + this.renderable.id + ' has no input texture');
      if (this.readsMipMappedFrame) this.scene.refreshMipMappedFrameBuffer();
      this.gl.bindVertexArray(this.vao);
      this.setupRenderFramebuffer();
      this.setupRenderTexture();
      this.setupRenderUniforms();
      this.setupRenderAttributes();
      this.renderGeometry();
      this.cleanupRenderSetup();
    }

    setDestination(fbo) { this.drawTo = fbo; }
    setInput(texture) { this.input = texture; }
    setPreviousInput(texture) { this.previousInput = texture; }
    setModelViewProjectionMatrix(m) { this.mvp = m; }
    setModelViewProjectionMatrixInverse(m) { this.mvpInverse = m; }
    setModelMatrix(m) { this.modelMatrix = m; }
    setViewProjectionMatrix(m) { this.viewProjectionMatrix = m; }
    setBlendingMode(mode) { this.blendingMode = mode; }
    getBlendingMode() { return this.blendingMode; }
    setTexCoord(buffer) { this.texcoordBuffer = buffer; }
    setPosition(buffer) { this.positionBuffer = buffer; }
    // CPass::setGeometryCallback: custom vertex streams (puppet meshes, particles, text).
    setGeometryCallback(setup, draw, cleanup) { this.geometry = { setup, draw, cleanup }; }
    attributeLocation(name) { const a = this.programAttributes[name]; return a ? a.location : -1; }

    dispose() {
      const gl = this.gl;
      if (this.vao) gl.deleteVertexArray(this.vao);
      if (this.program) gl.deleteProgram(this.program);
      this.vao = null;
      this.program = null;
    }
  }

  const api = { Pass, setUniform, fill, isFBOName, TEXTURE_UNITS };
  G.WEPass = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();

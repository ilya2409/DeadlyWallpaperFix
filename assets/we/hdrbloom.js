// HDR bloom: Wallpaper Engine's hdr_downsample chain thresholds and shrinks the scene, the
// hdr_upsample chain scatters it back up, and combine_hdr lays the result over the frame.
(() => {
  'use strict';
  const G = typeof window !== 'undefined' ? window : globalThis;
  const M = G.WEM;

  const MAX_ITERATIONS = 10;
  const LEVEL_PREFIX = '_rt_HDRBloom';
  const COMBINED = '_rt_HDRCombined';

  class HdrBloom {
    constructor(scene) {
      this.scene = scene;
      this.gl = scene.gl;
      this.levels = [];
      this.down = [];
      this.up = [];
      this.combine = null;
      this.combined = null;
      this.buffers = null;
      this.vars = { blend: new Float32Array(4), texel: new Float32Array(2), one: new Float32Array([1, 0, 0, 0]) };
    }

    iterations() {
      const b = this.scene.bloom;
      const n = Math.trunc(b.hdrIterations.getNumber());
      return Math.max(1, Math.min(MAX_ITERATIONS, n > 0 ? n : 1));
    }

    // Soft threshold as hdr_downsample reads it: threshold, threshold minus knee, twice the knee, a quarter over the knee
    blendParams() {
      const b = this.scene.bloom;
      const threshold = Math.max(0, b.hdrThreshold.getNumber());
      const knee = threshold * Math.max(0, Math.min(1, b.hdrFeather.getNumber())) + 1e-5;
      this.vars.blend.set([threshold, threshold - knee, 2 * knee, 0.25 / knee]);
      return this.vars.blend;
    }

    async setup() {
      const scene = this.scene, gl = this.gl;
      const clamp = G.WEFBO.FLAG.CLAMP_UVS;
      const w = scene.fbo.realWidth, h = scene.fbo.realHeight;
      const n = this.iterations();
      for (let k = 0; k < n; k++) {
        const lw = Math.max(1, Math.floor(w / Math.pow(2, k + 1))), lh = Math.max(1, Math.floor(h / Math.pow(2, k + 1)));
        this.levels.push(scene.fbos.create(LEVEL_PREFIX + k, 'rgba16f', clamp, [lw, lh], [lw, lh]));
      }
      this.combined = scene.fbos.create(COMBINED, 'rgba8888', clamp, [w, h], [w, h]);
      const quad = gl.createBuffer(), quadUv = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, quad); gl.bufferData(gl.ARRAY_BUFFER, G.WEImage.PASS_SPACE_POSITION, gl.STATIC_DRAW);
      gl.bindBuffer(gl.ARRAY_BUFFER, quadUv); gl.bufferData(gl.ARRAY_BUFFER, G.WEImage.TEXCOORD_PASS, gl.STATIC_DRAW);
      gl.bindBuffer(gl.ARRAY_BUFFER, null);
      this.buffers = { quad, quadUv };
      const ctx = scene.ctx();
      const load = (name) => G.WEMaterial.loadMaterial(ctx, 'materials/util/' + name + '.json');
      const materials = {};
      for (const name of ['hdr_downsample_bloom', 'hdr_downsample', 'hdr_upsample', 'combine_hdr_upsample_linear']) materials[name] = await load(name);
      const white = await scene.textures.resolve('util/white');
      const b = scene.bloom;
      const common = {
        g_BloomStrength: () => b.hdrStrength.getNumber(),
        g_BloomBlendParams: () => this.blendParams(),
        g_BloomTint: () => scene.colors.bloomTint.getVec(3),
        g_BloomScatter: () => b.hdrScatter.getNumber(),
      };
      const halfTexel = (fbo) => new Float32Array([0.5 / fbo.realWidth, 0.5 / fbo.realHeight, -0.5 / fbo.realWidth, -0.5 / fbo.realHeight]);
      for (let k = 0; k < n; k++) {
        const source = k === 0 ? scene.fbo : this.levels[k - 1];
        const offsets = halfTexel(source);
        const owner = new G.WELighting.PassOwner(scene, 'hdr bloom down ' + k, white, Object.assign({ g_RenderVar0: () => offsets }, common));
        this.down.push(await this.quadPass(owner, k === 0 ? materials.hdr_downsample_bloom : materials.hdr_downsample, { 0: source.name }, this.levels[k]));
      }
      for (let k = n - 1; k >= 1; k--) {
        const offsets = halfTexel(this.levels[k]);
        const owner = new G.WELighting.PassOwner(scene, 'hdr bloom up ' + k, white, Object.assign({ g_RenderVar0: () => offsets }, common));
        this.up.push(await this.quadPass(owner, materials.hdr_upsample, { 0: this.levels[k].name }, this.levels[k - 1]));
      }
      this.vars.texel.set([1 / this.levels[0].realWidth, 1 / this.levels[0].realHeight]);
      const owner = new G.WELighting.PassOwner(scene, 'hdr bloom combine', white, { g_RenderVar0: () => this.vars.one, g_TexelSize: () => this.vars.texel });
      this.combine = await this.quadPass(owner, materials.combine_hdr_upsample_linear, { 0: scene.fbo.name, 1: this.levels[0].name }, this.combined);
    }

    async quadPass(owner, material, textures, target) {
      const first = material.passes[0];
      const data = Object.assign({}, first, { textures: Object.assign({}, first.textures, textures), usertextures: {}, textureUsers: {}, constants: {} });
      const pass = new G.WEPass.Pass(owner, new G.WEFBO.Provider(this.gl, this.scene.fbos), data, null, null, null);
      await pass.build();
      pass.setDestination(target);
      pass.setInput(owner.texture);
      pass.setPosition(this.buffers.quad);
      pass.setTexCoord(this.buffers.quadUv);
      pass.setModelViewProjectionMatrix(M.identity());
      pass.setModelViewProjectionMatrixInverse(M.identity());
      return pass;
    }

    render() {
      for (const pass of this.down) pass.render();
      for (const pass of this.up) pass.render();
      this.combine.render();
      return this.combined;
    }

    dispose() {
      for (const pass of this.down.concat(this.up)) pass.dispose();
      if (this.combine) this.combine.dispose();
      for (const level of this.levels) level.dispose();
      if (this.combined) this.combined.dispose();
      if (this.buffers) for (const b of Object.values(this.buffers)) this.gl.deleteBuffer(b);
    }
  }

  const api = { HdrBloom, MAX_ITERATIONS, LEVEL_PREFIX, COMBINED };
  G.WEHdrBloom = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();

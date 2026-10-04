// 3D model objects: scene.json entries naming a "model" .mdl draw its meshes with the materials the
// file names, in world space through the scene camera, skinned when the file carries bones, and
// cast shadows with Wallpaper Engine's shadowcaster shaders when castshadow is set.
(() => {
  'use strict';
  const G = typeof window !== 'undefined' ? window : globalThis;
  const M = G.WEM;

  const DEFAULT_TEXTURE = 'util/white';
  const ERROR_MATERIAL = 'materials/util/error.json';
  const CASTER_SHADERS = { fur4: 'shadowcasterfur4', foliage4: 'shadowcasterfoliage4' };
  const ATTRIBUTES = [['a_Position', 'positions', 3], ['a_Normal', 'normals', 3], ['a_Tangent4', 'tangents', 4], ['a_TexCoord', 'uvs', 2]];

  /** One mesh of a model as the renderable its passes read. */
  class MeshPart {
    constructor(model, index, mesh, material, texture) {
      this.model = model;
      this.scene = model.scene;
      this.id = model.id + ':' + index;
      this.mesh = mesh;
      this.material = material;
      this.texture = texture;
      this.buffers = {};
      this.elements = null;
      this.vaos = new WeakMap();
      this.pass = null;
      this.caster = null;
    }
    getBrightness() { return this.model.brightness.getNumber(); }
    getUserAlpha() { return this.model.alpha.getNumber(); }
    getAlpha() { return this.model.alpha.getNumber(); }
    getColor() { return this.model.color.getVec(3); }
    getColor4() { return this.model.color.getVec(4); }
    getCompositeColor() { return this.model.color.getVec(3); }
    get animationTime() { return 0; }
    passUniforms(pass) { return this.model.skinUniforms(pass); }

    upload(gl) {
      const mesh = this.mesh;
      for (const [, key] of ATTRIBUTES) {
        if (!mesh[key]) continue;
        const buffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
        gl.bufferData(gl.ARRAY_BUFFER, mesh[key], gl.STATIC_DRAW);
        this.buffers[key] = buffer;
      }
      if (mesh.blendIndices) {
        const indices = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, indices);
        gl.bufferData(gl.ARRAY_BUFFER, mesh.blendIndices, gl.STATIC_DRAW);
        this.buffers.blendIndices = indices;
        const weights = new Float32Array(mesh.count * 4);
        if (mesh.blendWeights) weights.set(mesh.blendWeights); else for (let i = 0; i < mesh.count; i++) weights[i * 4] = 1;
        const wb = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, wb);
        gl.bufferData(gl.ARRAY_BUFFER, weights, gl.STATIC_DRAW);
        this.buffers.blendWeights = wb;
      }
      this.elements = gl.createBuffer();
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.elements);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.indices, gl.STATIC_DRAW);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, null);
      gl.bindBuffer(gl.ARRAY_BUFFER, null);
    }

    // A vertex array per pass, binding whichever of the mesh streams the program reads
    vaoFor(gl, pass) {
      const cached = this.vaos.get(pass);
      if (cached) return cached;
      const vao = gl.createVertexArray();
      gl.bindVertexArray(vao);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.elements);
      let bound = 0;
      for (const [name, key, size] of ATTRIBUTES) {
        const info = pass.programAttributes[name];
        if (!info || info.location < 0) continue;
        if (!this.buffers[key]) throw new Error(this.model.file + ': shader ' + pass.pass.shader + ' reads ' + name + ', which the mesh does not carry');
        gl.enableVertexAttribArray(info.location);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers[key]);
        gl.vertexAttribPointer(info.location, size, gl.FLOAT, false, 0, 0);
        bound++;
      }
      const indices = pass.programAttributes.a_BlendIndices, weights = pass.programAttributes.a_BlendWeights;
      if (indices && indices.location >= 0) {
        if (!this.buffers.blendIndices) throw new Error(this.model.file + ': shader ' + pass.pass.shader + ' skins a mesh without bone indices');
        gl.enableVertexAttribArray(indices.location);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers.blendIndices);
        gl.vertexAttribIPointer(indices.location, 4, gl.UNSIGNED_INT, 0, 0);
      }
      if (weights && weights.location >= 0) {
        gl.enableVertexAttribArray(weights.location);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers.blendWeights);
        gl.vertexAttribPointer(weights.location, 4, gl.FLOAT, false, 0, 0);
      }
      gl.bindVertexArray(null);
      gl.bindBuffer(gl.ARRAY_BUFFER, null);
      if (!bound) throw new Error(this.model.file + ': shader ' + pass.pass.shader + ' reads none of the mesh attributes');
      this.vaos.set(pass, vao);
      return vao;
    }

    attachGeometry(gl, pass) {
      pass.setGeometryCallback(
        () => { gl.bindVertexArray(this.vaoFor(gl, pass)); },
        (p, instances) => {
          if (instances > 1) gl.drawElementsInstanced(gl.TRIANGLES, this.mesh.indices.length, gl.UNSIGNED_INT, 0, instances);
          else gl.drawElements(gl.TRIANGLES, this.mesh.indices.length, gl.UNSIGNED_INT, 0);
        },
        () => { gl.bindVertexArray(pass.vao); },
      );
    }

    dispose(gl) {
      for (const b of Object.values(this.buffers)) gl.deleteBuffer(b);
      if (this.elements) gl.deleteBuffer(this.elements);
      if (this.pass) this.pass.dispose();
      if (this.caster) this.caster.dispose();
    }
  }

  class Model extends G.WEObjects.SceneObject {
    constructor(scene, json) {
      super(scene, json);
      if (typeof json.model !== 'string' || !json.model.length) throw new Error('object ' + this.id + ': "model" must name a .mdl file');
      this.file = json.model;
      this.alpha = this.setting('alpha', 'float', 1);
      this.color = this.setting('color', 'color', [1, 1, 1], true);
      this.brightness = this.setting('brightness', 'float', 1);
      this.castShadow = json.castshadow === true;
      this.mdl = null;
      this.instance = null;
      this.parts = [];
      this.world = M.identity();
      this.boneCache = { stamp: null, b16: null };
      this.unsubscribe = null;
    }

    isSolid() { return this.json.solid !== false; }

    ctx() { return { loader: this.scene.loader, properties: this.scene.properties }; }

    async setup() {
      const scene = this.scene, gl = scene.gl;
      const bytes = await scene.loader.bytes(this.file);
      this.mdl = G.WEPuppet.parse(bytes, this.file);
      if (this.mdl.puppet && this.mdl.puppet.bones.length) {
        const specs = [];
        for (const key of ['animationlayers', 'puppetanimations']) {
          const list = this.json[key];
          if (list === undefined || list === null) continue;
          if (!Array.isArray(list)) throw new Error('object ' + this.id + ': "' + key + '" is not a list');
          list.forEach((entry, i) => specs.push(G.WEPuppetWarp.parseLayerSpec(entry, 'object ' + this.id + '.' + key + '[' + i + ']', scene.properties, { visible: true, nameIsAnimation: true })));
        }
        this.instance = new G.WEPuppet.Instance(this.mdl, specs);
        this.unsubscribe = scene.onUpdate((dt, time) => this.instance.update(time, dt));
        this.instance.update(scene.time, 0);
      }
      const combos = this.instance ? { SKINNING: 1, BONECOUNT: this.mdl.puppet.bones.length } : {};
      for (let i = 0; i < this.mdl.meshes.length; i++) {
        const mesh = this.mdl.meshes[i];
        if (!mesh.materials.length) throw new Error(this.file + ': mesh ' + i + ' names no material');
        let material;
        try {
          material = await G.WEMaterial.loadMaterial(this.ctx(), mesh.materials[0]);
        } catch (e) {
          // Wallpaper Engine draws meshes whose material file is absent with its error material
          console.error(this.file + ': material ' + mesh.materials[0] + ' could not be loaded, drawing the mesh with the error material: ' + e.message);
          material = await G.WEMaterial.loadMaterial(this.ctx(), ERROR_MATERIAL);
        }
        if (!material.passes.length) throw new Error(material.filename + ': the material has no passes');
        const first = material.passes[0];
        const keys = Object.keys(first.textures).map((k) => parseInt(k, 10)).sort((a, b) => a - b);
        const name = keys.length ? first.textures[keys[0]] : DEFAULT_TEXTURE;
        const provider = G.WEPass.isFBOName(name) ? scene.findFBO(name) : await scene.textures.resolve(name);
        const part = new MeshPart(this, i, mesh, material, new G.WETextures.TextureRef('object ' + this.id, provider));
        part.upload(gl);
        const passData = Object.assign({}, first, { combos: Object.assign({}, first.combos, combos) });
        part.pass = new G.WEPass.Pass(part, new G.WEFBO.Provider(gl, scene.fbos), passData, null, null, null);
        await part.pass.build();
        part.attachGeometry(gl, part.pass);
        if (this.castShadow && scene.lights.shadowed) {
          part.caster = new G.WEPass.Pass(part, new G.WEFBO.Provider(gl, scene.fbos), casterPassData(first, combos), null, null, null);
          part.caster.depthOnly = true;
          await part.caster.build();
          part.attachGeometry(gl, part.caster);
        }
        this.parts.push(part);
      }
      this.initialized = true;
    }

    // g_Bones in the type a program declares, in model space
    skinUniforms(pass) {
      if (!this.instance) return {};
      const info = pass.programUniforms.g_Bones;
      if (!info) return {};
      const gl = this.scene.gl;
      if (info.type === gl.FLOAT_MAT4x3) return { g_Bones: () => this.instance.bones };
      if (info.type === gl.FLOAT_MAT4) return { g_Bones: () => this.boneMatrices16() };
      throw new Error(this.file + ': shader ' + pass.pass.shader + ' declares g_Bones with a type (0x' + info.type.toString(16) + ') that is neither mat4 nor mat4x3');
    }

    boneMatrices16() {
      const cache = this.boneCache;
      if (cache.stamp === this.scene.time && cache.b16) return cache.b16;
      const skin = this.instance.skin;
      if (!cache.b16) cache.b16 = new Float32Array(skin.length * 16);
      for (let i = 0; i < skin.length; i++) cache.b16.set(skin[i], i * 16);
      cache.stamp = this.scene.time;
      return cache.b16;
    }

    render() {
      if (!this.initialized || !this.shown()) return;
      const scene = this.scene;
      this.world = this.worldMatrix();
      const vp = scene.camera.viewProjection;
      const mvp = M.multiply(vp, this.world);
      const inverse = M.inverse(mvp);
      for (const part of this.parts) {
        const pass = part.pass;
        pass.setDestination(scene.fbo);
        pass.setInput(part.texture);
        pass.setModelMatrix(this.world);
        pass.setViewProjectionMatrix(vp);
        pass.setModelViewProjectionMatrix(mvp);
        pass.setModelViewProjectionMatrixInverse(inverse);
        pass.render();
      }
    }

    castsShadow() { return this.initialized && this.castShadow && this.shown() && this.parts.some((p) => p.caster); }

    renderShadow(face) {
      const scene = this.scene;
      const world = this.worldMatrix();
      const mvp = M.multiply(face.viewProjection, world);
      for (const part of this.parts) {
        const pass = part.caster;
        if (!pass) continue;
        pass.viewportRect = face.viewport;
        pass.setDestination(scene.lights.atlas);
        pass.setInput(part.texture);
        pass.setModelMatrix(world);
        pass.setViewProjectionMatrix(face.viewProjection);
        pass.setModelViewProjectionMatrix(mvp);
        pass.setModelViewProjectionMatrixInverse(M.inverse(mvp));
        pass.render();
      }
    }

    setPaused(paused) { for (const part of this.parts) part.texture.setPaused(paused); }

    dispose() {
      if (this.unsubscribe) this.unsubscribe();
      for (const part of this.parts) part.dispose(this.scene.gl);
      this.parts = [];
    }
  }

  // The shadow caster pass a material pass maps to, keeping its skinning, cutout and foliage inputs
  function casterPassData(first, combos) {
    const Mat = G.WEMaterial;
    const keep = {};
    for (const key of ['ALPHATOCOVERAGE', 'LEAVESUVMODE', 'MORPHING', 'MORPHING_NORMALS']) if (first.combos[key] !== undefined) keep[key] = first.combos[key];
    return {
      blending: Mat.BLENDING.NORMAL, cullmode: Mat.CULL.DISABLE, depthtest: Mat.DEPTHTEST.ENABLED, depthwrite: Mat.DEPTHWRITE.ENABLED,
      shader: CASTER_SHADERS[first.shader] || 'shadowcaster',
      textures: first.textures[0] !== undefined ? { 0: first.textures[0] } : {},
      usertextures: {}, textureUsers: {},
      combos: Object.assign(keep, combos),
      constants: first.constants,
    };
  }

  G.WEObjects.register('model', Model, 12);

  const api = { Model, MeshPart, casterPassData, CASTER_SHADERS };
  G.WEModel = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();

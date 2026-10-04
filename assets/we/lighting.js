// Scene lighting: the LightingV1 module Wallpaper Engine shaders require, the per-light uniform
// arrays behind it, the shadow atlas every shadow casting light renders into, and volumetric light
// volumes. Lights follow the v3 image shaders' uniform layout with intensity in the colour's w.
(() => {
  'use strict';
  const G = typeof window !== 'undefined' ? window : globalThis;
  const M = G.WEM;
  const V = G.WEV;

  const ATLAS_SIZE = 2048;
  const MIN_REGION = 128;
  const SHADOW_QUALITY = 4;
  // CalculateProjectedCoordsPoint shrinks each cube face by this factor at quality 4
  const POINT_COMPENSATION = 0.49;
  const CASCADES = 3;
  const CASCADE_DEPTH_MARGIN = 8;
  const FACE_OFFSETS = [[0, 0], [1, 0], [0, 1], [1, 1], [0, 2], [1, 2]];
  const FACE_SCALE = [0.5, 0.3333];
  const KINDS = { point: 'point', lpoint: 'point', spot: 'spot', lspot: 'spot', tube: 'tube', ltube: 'tube', directional: 'directional', ldirectional: 'directional' };
  const REGION_SIZE = { point: 1024, spot: 512, tube: 1024, directional: 1024 };
  const SPHERE_RINGS = 24;
  const SPHERE_SEGMENTS = 32;
  const CONE_SEGMENTS = 48;

  const MODULE = `// begin of generated module LightingV1
#if LIGHTS_POINT
uniform vec4 g_LPoint_Origin[LIGHTS_POINT];
uniform vec4 g_LPoint_Color[LIGHTS_POINT];
uniform vec2 g_LPoint_Params[LIGHTS_POINT];
#if LIGHTS_SHADOW_MAPPING
uniform vec4 g_LPoint_ShadowAtlas[LIGHTS_POINT];
uniform vec4 g_LPoint_ShadowProjection[LIGHTS_POINT];
#endif
#endif
#if LIGHTS_SPOT
uniform vec4 g_LSpot_Origin[LIGHTS_SPOT];
uniform vec4 g_LSpot_Direction[LIGHTS_SPOT];
uniform vec4 g_LSpot_Color[LIGHTS_SPOT];
uniform vec4 g_LSpot_Params[LIGHTS_SPOT];
#if LIGHTS_SHADOW_MAPPING
uniform vec4 g_LSpot_ShadowAtlas[LIGHTS_SPOT];
uniform mat4 g_LSpot_ShadowMatrix[LIGHTS_SPOT];
#endif
#endif
#if LIGHTS_TUBE
uniform vec4 g_LTube_OriginA[LIGHTS_TUBE];
uniform vec4 g_LTube_OriginB[LIGHTS_TUBE];
uniform vec4 g_LTube_Color[LIGHTS_TUBE];
uniform vec2 g_LTube_Params[LIGHTS_TUBE];
#if LIGHTS_SHADOW_MAPPING
uniform vec4 g_LTube_ShadowAtlas[LIGHTS_TUBE];
uniform vec4 g_LTube_ShadowProjection[LIGHTS_TUBE];
#endif
#endif
#if LIGHTS_DIRECTIONAL
uniform vec4 g_LDirectional_Direction[LIGHTS_DIRECTIONAL];
uniform vec4 g_LDirectional_Color[LIGHTS_DIRECTIONAL];
#if LIGHTS_SHADOW_MAPPING
uniform vec4 g_LDirectional_ShadowAtlas[LIGHTS_DIRECTIONAL * 3];
uniform mat4 g_LDirectional_ShadowMatrix[LIGHTS_DIRECTIONAL * 3];
#endif
#endif
#if LIGHTS_SHADOW_MAPPING && defined(SHADOW_ATLAS_SAMPLER)
#define WE_SHADOWS 1
#else
#define WE_SHADOWS 0
#endif
vec3 PerformLighting_V1(vec3 worldPos, vec3 albedo, vec3 normal, vec3 viewVector, vec3 specularTint, vec3 baseReflectance, float roughness, float metallic)
{
	vec3 light = CAST3(0.0);
#if LIGHTS_POINT
	for (uint l = 0u; l < CASTU(LIGHTS_POINT); ++l)
	{
		vec3 lightDelta = g_LPoint_Origin[l].xyz - worldPos;
		float shadowFactor = 1.0;
#if WE_SHADOWS
		if (g_LPoint_Params[l].y > 0.5)
		{
			vec4 shadowCoords = CalculateProjectedCoordsPoint(worldPos, g_LPoint_Origin[l].xyz, g_LPoint_ShadowProjection[l], g_LPoint_ShadowAtlas[l]);
			shadowFactor = PerformPointShadowMapping(shadowCoords);
		}
#endif
		light += ComputePBRLightShadow(normal, lightDelta, viewVector, albedo, g_LPoint_Color[l].rgb * g_LPoint_Color[l].w,
			g_LPoint_Origin[l].w, g_LPoint_Params[l].x, specularTint, baseReflectance, roughness, metallic, shadowFactor);
	}
#endif
#if LIGHTS_SPOT
	for (uint l = 0u; l < CASTU(LIGHTS_SPOT); ++l)
	{
		vec3 lightDelta = g_LSpot_Origin[l].xyz - worldPos;
		float spotCookie = -dot(normalize(lightDelta), g_LSpot_Direction[l].xyz);
		spotCookie = smoothstep(g_LSpot_Direction[l].w, g_LSpot_Origin[l].w, spotCookie);
		float shadowFactor = 1.0;
#if WE_SHADOWS
		if (g_LSpot_Params[l].y > 0.5)
		{
			vec3 shadowCoords = CalculateProjectedCoords(worldPos, g_LSpot_ShadowMatrix[l]);
			shadowFactor = PerformShadowMapping(shadowCoords, g_LSpot_ShadowAtlas[l]);
		}
#endif
		light += ComputePBRLightShadow(normal, lightDelta, viewVector, albedo, g_LSpot_Color[l].rgb * spotCookie * g_LSpot_Color[l].w,
			g_LSpot_Params[l].z, g_LSpot_Params[l].x, specularTint, baseReflectance, roughness, metallic, shadowFactor);
	}
#endif
#if LIGHTS_TUBE
	for (uint l = 0u; l < CASTU(LIGHTS_TUBE); ++l)
	{
		vec3 lightDelta = PointSegmentDelta(worldPos, g_LTube_OriginA[l].xyz, g_LTube_OriginB[l].xyz);
		float shadowFactor = 1.0;
#if WE_SHADOWS
		if (g_LTube_Params[l].y > 0.5)
		{
			vec3 tubeCenter = (g_LTube_OriginA[l].xyz + g_LTube_OriginB[l].xyz) * 0.5;
			vec4 shadowCoords = CalculateProjectedCoordsPoint(worldPos, tubeCenter, g_LTube_ShadowProjection[l], g_LTube_ShadowAtlas[l]);
			shadowFactor = PerformPointShadowMapping(shadowCoords);
		}
#endif
		light += ComputePBRLightShadow(normal, lightDelta, viewVector, albedo, g_LTube_Color[l].rgb * g_LTube_Color[l].w,
			g_LTube_OriginA[l].w, g_LTube_OriginB[l].w, specularTint, baseReflectance, roughness, metallic, shadowFactor);
	}
#endif
#if LIGHTS_DIRECTIONAL
	for (uint l = 0u; l < CASTU(LIGHTS_DIRECTIONAL); ++l)
	{
		float shadowFactor = 1.0;
#if WE_SHADOWS
		if (g_LDirectional_Direction[l].w > 0.5)
		{
			for (uint c = 0u; c < 3u; ++c)
			{
				vec4 cascade = CalculateProjectedCoordsCascades(worldPos, g_LDirectional_ShadowMatrix[l * 3u + c]);
				if (cascade.w < 0.5)
				{
					shadowFactor = PerformShadowMapping(cascade.xyz, g_LDirectional_ShadowAtlas[l * 3u + c]);
					break;
				}
			}
		}
#endif
		light += ComputePBRLightShadowInfinite(normal, g_LDirectional_Direction[l].xyz, viewVector, albedo, g_LDirectional_Color[l].rgb * g_LDirectional_Color[l].w,
			specularTint, baseReflectance, roughness, metallic, shadowFactor);
	}
#endif
	return light;
}
// end of generated module LightingV1
`;

  function kindOf(value) {
    const kind = KINDS[String(value || 'point').toLowerCase()];
    if (!kind) throw new Error('light kind "' + value + '" is not point, spot, tube or directional');
    return kind;
  }

  // Clip z from [-1, 1] to the [0, 1] range Wallpaper Engine's shadow functions compare against
  const BIAS01 = (() => { const m = M.identity(); m[10] = 0.5; m[14] = 0.5; return m; })();
  // Atlas rows run upward in GL where the sampling functions count them downward
  const FLIP_Y = M.scaling(1, -1, 1);

  // The six cube face view matrices of CalculateProjectedCoordsPoint, column by column
  function pointFaceView(face, o) {
    switch (face) {
      case 0: return new Float32Array([0, 0, -1, 0, 0, 1, 0, 0, 1, 0, 0, 0, -o[2], -o[1], o[0], 1]);
      case 1: return new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, -1, 0, 0, 0, o[2], -o[1], -o[0], 1]);
      case 2: return new Float32Array([1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, -o[0], -o[2], o[1], 1]);
      case 3: return new Float32Array([1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, -o[0], o[2], -o[1], 1]);
      case 4: return new Float32Array([-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, -1, 0, o[0], -o[1], o[2], 1]);
      default: return new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -o[0], -o[1], -o[2], 1]);
    }
  }

  function pointNearFar(radius) {
    const far = Math.max(radius, 1e-3);
    return [Math.max(far * 1e-3, 1e-4), far];
  }

  function perpendicularUp(forward) {
    return Math.abs(forward[1]) > 0.99 ? [0, 0, 1] : [0, 1, 0];
  }

  /** Shelf packing of square shadow regions into the atlas, shrinking them until they fit. */
  function packRegions(requests) {
    let scale = 1;
    for (;;) {
      const sizes = requests.map((r) => Math.max(MIN_REGION, (r.size * scale) | 0));
      const placed = [];
      let x = 0, y = 0, rowHeight = 0, fits = true;
      for (let i = 0; i < sizes.length; i++) {
        const s = sizes[i];
        if (x + s > ATLAS_SIZE) { x = 0; y += rowHeight; rowHeight = 0; }
        if (y + s > ATLAS_SIZE) { fits = false; break; }
        placed.push({ x, y, size: s });
        x += s;
        rowHeight = Math.max(rowHeight, s);
      }
      if (fits) return placed;
      if (sizes.every((s) => s <= MIN_REGION)) throw new Error('the scene asks for more shadow maps than a ' + ATLAS_SIZE + ' atlas holds');
      scale /= 2;
    }
  }

  function sphereMesh() {
    const positions = [], indices = [];
    for (let r = 0; r <= SPHERE_RINGS; r++) {
      const phi = Math.PI * r / SPHERE_RINGS;
      for (let s = 0; s <= SPHERE_SEGMENTS; s++) {
        const theta = 2 * Math.PI * s / SPHERE_SEGMENTS;
        positions.push(Math.sin(phi) * Math.cos(theta), Math.cos(phi), Math.sin(phi) * Math.sin(theta));
      }
    }
    for (let r = 0; r < SPHERE_RINGS; r++) {
      for (let s = 0; s < SPHERE_SEGMENTS; s++) {
        const a = r * (SPHERE_SEGMENTS + 1) + s, b = a + SPHERE_SEGMENTS + 1;
        indices.push(a, b, a + 1, a + 1, b, b + 1);
      }
    }
    return { positions: new Float32Array(positions), indices: new Uint32Array(indices) };
  }

  // A cone with its apex at the origin opening along +X to a unit radius base at x = 1
  function coneMesh() {
    const positions = [0, 0, 0, 1, 0, 0], indices = [];
    for (let s = 0; s < CONE_SEGMENTS; s++) {
      const t = 2 * Math.PI * s / CONE_SEGMENTS;
      positions.push(1, Math.cos(t), Math.sin(t));
    }
    for (let s = 0; s < CONE_SEGMENTS; s++) {
      const a = 2 + s, b = 2 + (s + 1) % CONE_SEGMENTS;
      indices.push(0, a, b, 1, b, a);
    }
    return { positions: new Float32Array(positions), indices: new Uint32Array(indices) };
  }

  /** A pass's renderable stand-in for engine passes that are not scene objects. */
  class PassOwner {
    constructor(scene, id, texture, uniforms) {
      this.scene = scene;
      this.id = id;
      this.texture = texture;
      this.uniforms = uniforms;
    }
    getBrightness() { return 1; }
    getUserAlpha() { return 1; }
    getAlpha() { return 1; }
    getColor() { return [1, 1, 1]; }
    getColor4() { return [1, 1, 1, 1]; }
    getCompositeColor() { return [1, 1, 1]; }
    get animationTime() { return 0; }
    passUniforms() { return this.uniforms; }
  }

  /** Everything the renderer does for the scene's lights. */
  class Lights {
    constructor(scene) {
      this.scene = scene;
      this.lights = [];
      this.slots = { point: [], spot: [], tube: [], directional: [] };
      this.counts = { point: 0, spot: 0, tube: 0, directional: 0 };
      this.shadowed = false;
      this.atlas = null;
      this.faceMatrices = new Float32Array(16 * 6);
      this.faces = [];
      this.data = null;
      this.volumetrics = null;
      this.planned = { point: [], spot: [], tube: [], directional: [] };
    }

    // Light counts come from the scene's lightconfig, else from the lights scene.json lists, so
    // every material compiles with them before any object exists
    plan(general, objects) {
      const scene = this.scene;
      const config = general && general.lightconfig && typeof general.lightconfig === 'object' ? general.lightconfig : null;
      const byKind = { point: [], spot: [], tube: [], directional: [] };
      for (const json of objects) {
        if (!json || typeof json !== 'object' || json.light === undefined || json.light === null) continue;
        byKind[kindOf(json.light)].push(json);
      }
      const shadowSlots = { point: 0, spot: 0, tube: 0, directional: 0 };
      this.planned = { point: [], spot: [], tube: [], directional: [] };
      for (const kind of Object.keys(byKind)) {
        const want = config ? Math.max(0, Math.trunc(Number(config[kind]) || 0)) : byKind[kind].length;
        this.counts[kind] = Math.min(want, byKind[kind].length);
        shadowSlots[kind] = config ? Math.max(0, Math.trunc(Number(config[kind + 'shadow']) || 0)) : byKind[kind].filter((j) => j.castshadow === true).length;
        this.planned[kind] = byKind[kind].slice(0, this.counts[kind]).map((j) => ({ id: j.id, regions: null }));
      }
      const requests = [];
      for (const kind of Object.keys(this.planned)) {
        let remaining = shadowSlots[kind];
        for (const slot of this.planned[kind]) {
          const json = byKind[kind].find((j) => j.id === slot.id);
          if (json.castshadow !== true || remaining <= 0) continue;
          remaining--;
          const n = kind === 'directional' ? CASCADES : 1;
          for (let i = 0; i < n; i++) requests.push({ slot, index: i, size: REGION_SIZE[kind] });
        }
      }
      this.shadowed = requests.length > 0;
      if (this.shadowed) {
        const placed = packRegions(requests);
        requests.forEach((r, i) => {
          if (!r.slot.regions) r.slot.regions = [];
          const p = placed[i];
          r.slot.regions[r.index] = { x: p.x, y: p.y, size: p.size, transform: [p.x / ATLAS_SIZE, p.y / ATLAS_SIZE, p.size / ATLAS_SIZE, p.size / ATLAS_SIZE] };
        });
      }
      const atlasSize = this.shadowed ? ATLAS_SIZE : 1;
      this.atlas = scene.fbos.create('_rt_shadowAtlas', 'depth', G.WEFBO.FLAG.CLAMP_UVS, [atlasSize, atlasSize], [atlasSize, atlasSize], { compare: true });
      scene.fbos.alias('_alias_lightCookie', '_rt_shadowAtlas');
      this.allocate();
    }

    // The light objects behind the planned slots, then the volumes around them
    async attach() {
      const scene = this.scene;
      this.lights = scene.renderOrder.filter((o) => o instanceof G.WEObjects.Light);
      for (const kind of Object.keys(this.planned)) {
        this.slots[kind] = this.planned[kind].map((slot) => {
          const light = this.lights.find((l) => l.id === slot.id);
          if (!light) throw new Error('light ' + slot.id + ' was planned but never created');
          light.shadowRegions = slot.regions;
          return light;
        });
      }
      this.volumetrics = new Volumetrics(scene, this);
      await this.volumetrics.setup();
    }

    allocate() {
      const c = this.counts;
      const n = (k, per) => new Float32Array(Math.max(1, c[k]) * per);
      this.data = {
        pointOrigin: n('point', 4), pointColor: n('point', 4), pointParams: n('point', 2), pointAtlas: n('point', 4), pointProjection: n('point', 4),
        spotOrigin: n('spot', 4), spotDirection: n('spot', 4), spotColor: n('spot', 4), spotParams: n('spot', 4), spotAtlas: n('spot', 4), spotMatrix: n('spot', 16),
        tubeOriginA: n('tube', 4), tubeOriginB: n('tube', 4), tubeColor: n('tube', 4), tubeParams: n('tube', 2), tubeAtlas: n('tube', 4), tubeProjection: n('tube', 4),
        directionalDirection: n('directional', 4), directionalColor: n('directional', 4), directionalAtlas: n('directional', 4 * CASCADES), directionalMatrix: n('directional', 16 * CASCADES),
      };
    }

    // Engine combos every lit material compiles with
    combos() {
      return {
        LIGHTS_POINT: this.counts.point, LIGHTS_SPOT: this.counts.spot, LIGHTS_TUBE: this.counts.tube, LIGHTS_DIRECTIONAL: this.counts.directional,
        LIGHTS_SHADOW_MAPPING: this.shadowed ? 1 : 0, LIGHTS_SHADOW_MAPPING_QUALITY: SHADOW_QUALITY,
      };
    }

    uniforms() {
      const d = this.data;
      return {
        g_LPoint_Origin: () => d.pointOrigin, g_LPoint_Color: () => d.pointColor, g_LPoint_Params: () => d.pointParams, g_LPoint_ShadowAtlas: () => d.pointAtlas, g_LPoint_ShadowProjection: () => d.pointProjection,
        g_LSpot_Origin: () => d.spotOrigin, g_LSpot_Direction: () => d.spotDirection, g_LSpot_Color: () => d.spotColor, g_LSpot_Params: () => d.spotParams, g_LSpot_ShadowAtlas: () => d.spotAtlas, g_LSpot_ShadowMatrix: () => d.spotMatrix,
        g_LTube_OriginA: () => d.tubeOriginA, g_LTube_OriginB: () => d.tubeOriginB, g_LTube_Color: () => d.tubeColor, g_LTube_Params: () => d.tubeParams, g_LTube_ShadowAtlas: () => d.tubeAtlas, g_LTube_ShadowProjection: () => d.tubeProjection,
        g_LDirectional_Direction: () => d.directionalDirection, g_LDirectional_Color: () => d.directionalColor, g_LDirectional_ShadowAtlas: () => d.directionalAtlas, g_LDirectional_ShadowMatrix: () => d.directionalMatrix,
        g_ViewportViewProjectionMatrices: () => this.faceMatrices,
      };
    }

    // Per-frame light values and the shadow faces to render
    update() {
      const d = this.data;
      const camera = this.scene.camera;
      this.faces = [];
      const color4 = (light, out, i) => {
        const c = light.color.getVec(3);
        const visible = light.visible.getBool();
        out[i * 4] = c[0]; out[i * 4 + 1] = c[1]; out[i * 4 + 2] = c[2];
        out[i * 4 + 3] = visible ? light.intensity.getNumber() : 0;
      };
      const pointLike = (light, origin, i, originOut, atlasOut, projOut) => {
        const radius = light.radius.getNumber();
        originOut[i * 4] = origin[0]; originOut[i * 4 + 1] = origin[1]; originOut[i * 4 + 2] = origin[2]; originOut[i * 4 + 3] = radius;
        if (!light.shadowRegions) return 0;
        const region = light.shadowRegions[0];
        const [near, far] = pointNearFar(radius);
        atlasOut.set(region.transform, i * 4);
        projOut.set([-far / (far - near), -near * far / (far - near), -1, 0], i * 4);
        const projection = M.perspective(Math.PI / 2, 1, near, far);
        projection[0] *= POINT_COMPENSATION * 2;
        projection[5] *= -POINT_COMPENSATION * 2;
        const faceSize = [region.size * FACE_SCALE[0], region.size * FACE_SCALE[1]];
        for (let f = 0; f < 6; f++) {
          this.faces.push({
            light,
            viewProjection: M.multiply(projection, pointFaceView(f, origin)),
            viewport: [Math.round(region.x + FACE_OFFSETS[f][0] * faceSize[0]), Math.round(region.y + FACE_OFFSETS[f][1] * faceSize[1]), Math.round(faceSize[0]), Math.round(faceSize[1])],
          });
        }
        return 1;
      };
      this.slots.point.forEach((light, i) => {
        color4(light, d.pointColor, i);
        const shadow = pointLike(light, light.worldPosition(), i, d.pointOrigin, d.pointAtlas, d.pointProjection);
        d.pointParams[i * 2] = light.exponent.getNumber();
        d.pointParams[i * 2 + 1] = shadow;
      });
      this.slots.tube.forEach((light, i) => {
        color4(light, d.tubeColor, i);
        const [a, b] = light.tubeEndpoints();
        const center = V.scale(V.add(a, b), 0.5);
        const shadow = pointLike(light, center, i, d.tubeOriginA, d.tubeAtlas, d.tubeProjection);
        d.tubeOriginA.set(a, i * 4);
        d.tubeOriginB.set([b[0], b[1], b[2], light.exponent.getNumber()], i * 4);
        d.tubeParams[i * 2] = light.exponent.getNumber();
        d.tubeParams[i * 2 + 1] = shadow;
      });
      this.slots.spot.forEach((light, i) => {
        color4(light, d.spotColor, i);
        const origin = light.worldPosition();
        const forward = light.forward();
        const angles = light.coneAngles();
        d.spotOrigin.set([origin[0], origin[1], origin[2], Math.cos(angles.inner)], i * 4);
        d.spotDirection.set([forward[0], forward[1], forward[2], Math.cos(angles.outer)], i * 4);
        const radius = light.radius.getNumber();
        let shadow = 0;
        if (light.shadowRegions) {
          shadow = 1;
          const region = light.shadowRegions[0];
          const [near, far] = pointNearFar(radius);
          const view = M.lookAt(origin, V.add(origin, forward), perpendicularUp(forward));
          const projection = M.perspective(Math.min(Math.PI * 0.99, angles.outer * 2), 1, near, far);
          const pv = M.multiply(projection, view);
          d.spotAtlas.set(region.transform, i * 4);
          d.spotMatrix.set(M.multiply(BIAS01, pv), i * 16);
          this.faces.push({ light, viewProjection: M.multiply(FLIP_Y, pv), viewport: [region.x, region.y, region.size, region.size] });
        }
        d.spotParams.set([light.exponent.getNumber(), shadow, radius, 0], i * 4);
      });
      this.slots.directional.forEach((light, i) => {
        color4(light, d.directionalColor, i);
        const forward = light.forward();
        d.directionalDirection.set([-forward[0], -forward[1], -forward[2], light.shadowRegions ? 1 : 0], i * 4);
        if (!light.shadowRegions) return;
        const splits = light.cascadeSplits();
        for (let c = 0; c < CASCADES; c++) {
          const region = light.shadowRegions[c];
          const box = this.cascadeBox(camera, forward, c === 0 ? 0 : splits[c - 1], splits[c]);
          d.directionalAtlas.set(region.transform, (i * CASCADES + c) * 4);
          d.directionalMatrix.set(M.multiply(BIAS01, box), (i * CASCADES + c) * 16);
          this.faces.push({ light, viewProjection: M.multiply(FLIP_Y, box), viewport: [region.x, region.y, region.size, region.size] });
        }
      });
      if (this.volumetrics) this.volumetrics.update();
    }

    // An orthographic light projection around the slice of the view between two depths
    cascadeBox(camera, forward, nearDepth, farDepth) {
      const inverse = camera.inverseViewProjection;
      const near = camera.nearz.getNumber(), far = camera.farz.getNumber();
      const toNdcDepth = (depth) => {
        if (!camera.perspective) return 2 * (depth - near) / Math.max(far - near, 1e-6) - 1;
        const d = Math.max(depth, near + 1e-6);
        return ((far + near) * d - 2 * far * near) / ((far - near) * d);
      };
      const corners = [];
      for (const z of [toNdcDepth(nearDepth || near), toNdcDepth(farDepth)]) {
        for (const x of [-1, 1]) for (const y of [-1, 1]) corners.push(M.transformPoint(inverse, [x, y, Math.max(-1, Math.min(1, z))]));
      }
      const center = corners.reduce((acc, c) => V.add(acc, c), [0, 0, 0]).map((v) => v / corners.length);
      const view = M.lookAt(V.sub(center, forward), center, perpendicularUp(forward));
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
      for (const c of corners) {
        const p = M.transformPoint(view, c);
        minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]);
        minY = Math.min(minY, p[1]); maxY = Math.max(maxY, p[1]);
        minZ = Math.min(minZ, p[2]); maxZ = Math.max(maxZ, p[2]);
      }
      const span = Math.max(maxX - minX, maxY - minY, maxZ - minZ, 1e-3);
      const projection = M.ortho(minX, maxX, minY, maxY, -maxZ - span * CASCADE_DEPTH_MARGIN, -minZ + span);
      return M.multiply(projection, view);
    }

    // Everything that casts a shadow, drawn into the atlas from every shadow light's faces
    renderShadows() {
      if (!this.shadowed) return;
      const gl = this.scene.gl;
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.atlas.framebuffer);
      gl.viewport(0, 0, ATLAS_SIZE, ATLAS_SIZE);
      gl.disable(gl.SCISSOR_TEST);
      gl.depthMask(true);
      gl.clearDepth(1);
      gl.clear(gl.DEPTH_BUFFER_BIT);
      const casters = this.scene.renderOrder.filter((o) => typeof o.castsShadow === 'function' && o.castsShadow());
      if (!casters.length) return;
      for (const face of this.faces) {
        this.faceMatrices.set(face.viewProjection, 0);
        for (const caster of casters) caster.renderShadow(face);
      }
    }

    renderVolumetrics() {
      if (this.volumetrics) this.volumetrics.render();
    }
  }

  /** Light volumes: Wallpaper Engine's volumetrics materials around every light with density. */
  class Volumetrics {
    constructor(scene, lights) {
      this.scene = scene;
      this.lights = lights;
      this.gl = scene.gl;
      this.entries = [];
      this.passes = null;
      this.buffers = null;
      this.lightBuffer = null;
      this.lightBufferB = null;
      this.back = null;
      this.active = false;
    }

    volumetricLights() {
      const list = [];
      for (const kind of ['point', 'spot']) for (const light of this.lights.slots[kind]) if (light.density.getNumber() > 0) list.push(light);
      return list;
    }

    async setup() {
      const scene = this.scene, gl = this.gl;
      const lights = this.volumetricLights();
      this.active = lights.length > 0;
      if (!this.active) return;
      const w = scene.fbo.realWidth, h = scene.fbo.realHeight;
      const clamp = G.WEFBO.FLAG.CLAMP_UVS;
      this.back = scene.fbos.create('_rt_volumetricsBack', 'depth', clamp, [w, h], [w, h]);
      this.lightBuffer = scene.fbos.create('_rt_volumetricsLightBuffer', 'rgba16f', clamp, [w, h], [w, h]);
      this.lightBufferB = scene.fbos.create('_rt_volumetricsLightBufferB', 'rgba16f', clamp, [w, h], [w, h]);
      // volumetricsfront reads screen depth with rows counted from the top, so it gets the scene depth upside down
      this.single = scene.fbos.create('_rt_volumetricsSingle', 'depth', clamp, [w, h], [w, h]);
      const ctx = scene.ctx();
      const load = (name) => G.WEMaterial.loadMaterial(ctx, 'materials/util/' + name + '.json');
      const materials = {};
      for (const name of ['volumetrics_back', 'volumetrics_front', 'volumetrics_fullscreen', 'volumetrics_blur_h', 'volumetrics_blur_v', 'volumetrics_combine']) materials[name] = await load(name);
      const sphere = sphereMesh(), cone = coneMesh();
      const upload = (mesh) => {
        const vbo = gl.createBuffer(), ebo = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, vbo); gl.bufferData(gl.ARRAY_BUFFER, mesh.positions, gl.STATIC_DRAW);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ebo); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.indices, gl.STATIC_DRAW);
        gl.bindBuffer(gl.ARRAY_BUFFER, null); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, null);
        return { vbo, ebo, count: mesh.indices.length };
      };
      const quad = gl.createBuffer(), quadUv = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, quad); gl.bufferData(gl.ARRAY_BUFFER, G.WEImage.PASS_SPACE_POSITION, gl.STATIC_DRAW);
      gl.bindBuffer(gl.ARRAY_BUFFER, quadUv); gl.bufferData(gl.ARRAY_BUFFER, G.WEImage.TEXCOORD_PASS, gl.STATIC_DRAW);
      gl.bindBuffer(gl.ARRAY_BUFFER, null);
      this.buffers = { sphere: upload(sphere), cone: upload(cone), quad, quadUv };
      const white = await scene.textures.resolve('util/white');
      this.entries = [];
      for (const light of lights) {
        const entry = { light, vars: [new Float32Array(4), new Float32Array(4), new Float32Array(4), new Float32Array(4), new Float32Array(4)], volumeModel: M.identity(), shadowMatrix: M.identity(), effectModel: M.identity(), inside: false };
        const uniforms = {
          g_RenderVar0: () => entry.vars[0], g_RenderVar1: () => entry.vars[1], g_RenderVar2: () => entry.vars[2], g_RenderVar3: () => entry.vars[3], g_RenderVar4: () => entry.vars[4],
          g_AltViewProjectionMatrix: () => entry.volumeModel, g_AltModelMatrix: () => entry.shadowMatrix, g_EffectModelMatrix: () => entry.effectModel,
        };
        const owner = new PassOwner(scene, 'volumetrics ' + light.id, white, uniforms);
        const combos = { QUALITY: SHADOW_QUALITY, POINTLIGHT: light.kind === 'point' ? 1 : 0, SHADOW: light.shadowRegions ? 1 : 0 };
        const mesh = light.kind === 'point' ? this.buffers.sphere : this.buffers.cone;
        entry.back = await this.volumePass(owner, materials.volumetrics_back, {}, mesh, this.back, false);
        entry.front = await this.volumePass(owner, materials.volumetrics_front, combos, mesh, this.lightBuffer, false);
        entry.fullscreen = await this.quadPass(owner, materials.volumetrics_fullscreen, combos, this.lightBuffer, false);
        this.entries.push(entry);
      }
      const owner = new PassOwner(scene, 'volumetrics blur', white, {});
      this.passes = {
        blurH: await this.quadPass(owner, materials.volumetrics_blur_h, {}, this.lightBufferB, true),
        blurV: await this.quadPass(owner, materials.volumetrics_blur_v, {}, this.lightBuffer, true),
        combine: await this.quadPass(owner, materials.volumetrics_combine, {}, scene.fbo, true),
      };
    }

    passFor(owner, material, combos, target) {
      const pass = Object.assign({}, material.passes[0], { combos: Object.assign({}, material.passes[0].combos, combos), textures: Object.assign({}, material.passes[0].textures), usertextures: {}, textureUsers: {}, constants: {} });
      const p = new G.WEPass.Pass(owner, new G.WEFBO.Provider(this.gl, this.scene.fbos), pass, null, null, null);
      p.setDestination(target);
      p.setInput(owner.texture);
      p.setViewProjectionMatrix(this.scene.camera.viewProjection);
      return p;
    }

    async volumePass(owner, material, combos, mesh, target, backFaces) {
      const gl = this.gl;
      const pass = Object.assign({}, material.passes[0], { combos: Object.assign({}, material.passes[0].combos, combos), textures: Object.assign({}, material.passes[0].textures), usertextures: {}, textureUsers: {}, constants: {} });
      if (target === this.back) { pass.depthtest = G.WEMaterial.DEPTHTEST.ENABLED; pass.depthwrite = G.WEMaterial.DEPTHWRITE.ENABLED; }
      const p = new G.WEPass.Pass(owner, new G.WEFBO.Provider(gl, this.scene.fbos), pass, null, null, null);
      await p.build();
      p.setDestination(target);
      p.setInput(owner.texture);
      p.cullFront = backFaces;
      const location = p.attributeLocation('a_Position');
      p.setGeometryCallback(
        () => { gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, mesh.ebo); gl.enableVertexAttribArray(location); gl.bindBuffer(gl.ARRAY_BUFFER, mesh.vbo); gl.vertexAttribPointer(location, 3, gl.FLOAT, false, 0, 0); },
        () => { gl.drawElements(gl.TRIANGLES, mesh.count, gl.UNSIGNED_INT, 0); },
        () => { gl.disableVertexAttribArray(location); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, null); },
      );
      return p;
    }

    async quadPass(owner, material, combos, target, texcoords) {
      const p = this.passFor(owner, material, combos, target);
      await p.build();
      p.setDestination(target);
      p.setPosition(this.buffers.quad);
      p.setTexCoord(this.buffers.quadUv);
      p.setModelViewProjectionMatrix(M.identity());
      p.setModelViewProjectionMatrixInverse(M.identity());
      return p;
    }

    update() {
      if (!this.active) return;
      const camera = this.scene.camera;
      const eye = camera.eyePosition;
      const biased = M.multiply(BIAS01, camera.viewProjection);
      const effectModel = M.inverse(biased);
      for (const entry of this.entries) {
        const light = entry.light;
        const origin = light.worldPosition();
        const radius = light.radius.getNumber();
        const intensity = light.visible.getBool() ? light.intensity.getNumber() : 0;
        const color = light.color.getVec(3);
        entry.effectModel = effectModel;
        entry.vars[2].set([origin[0], origin[1], origin[2], light.density.getNumber()]);
        entry.vars[4].set([color[0], color[1], color[2], light.volumetricsExponent.getNumber()]);
        if (light.kind === 'point') {
          entry.vars[1].set([radius, 1, 0, intensity]);
          entry.volumeModel = M.scale(M.translation(origin[0], origin[1], origin[2]), radius, radius, radius);
          entry.inside = V.length(V.sub(eye, origin)) < radius * 1.01;
          if (light.shadowRegions) {
            const [near, far] = pointNearFar(radius);
            entry.vars[0].set(light.shadowRegions[0].transform);
            entry.vars[3].set([-far / (far - near), -near * far / (far - near), -1, 0]);
          }
        } else {
          const forward = light.forward();
          const angles = light.coneAngles();
          const spread = Math.tan(Math.min(angles.outer, Math.PI * 0.49));
          entry.vars[1].set([radius, Math.cos(angles.inner), Math.cos(angles.outer), intensity]);
          entry.vars[3].set([forward[0], forward[1], forward[2], 0]);
          const up = perpendicularUp(forward);
          const side = V.normalize(V.cross(up, forward));
          const realUp = V.cross(forward, side);
          const basis = new Float32Array([forward[0], forward[1], forward[2], 0, side[0], side[1], side[2], 0, realUp[0], realUp[1], realUp[2], 0, origin[0], origin[1], origin[2], 1]);
          entry.volumeModel = M.scale(basis, radius, radius * spread, radius * spread);
          const toLight = V.sub(eye, origin);
          const along = V.dot(toLight, forward);
          const across = V.length(V.sub(toLight, V.scale(forward, along)));
          entry.inside = along > 0 && along < radius * 1.01 && across < along * spread * 1.01;
          if (light.shadowRegions) {
            entry.vars[0].set(light.shadowRegions[0].transform);
            const index = this.lights.slots.spot.indexOf(light);
            entry.shadowMatrix = this.lights.data.spotMatrix.subarray(index * 16, index * 16 + 16);
          }
        }
      }
    }

    render() {
      if (!this.active) return;
      const scene = this.scene, gl = this.gl;
      this.lightBuffer.clear();
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, scene.fbo.framebuffer);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.single.framebuffer);
      gl.blitFramebuffer(0, 0, scene.fbo.realWidth, scene.fbo.realHeight, 0, this.single.realHeight, this.single.realWidth, 0, gl.DEPTH_BUFFER_BIT, gl.NEAREST);
      // The back faces are drawn upside down too, with the flipped winding culled the ordinary way
      const flipped = M.multiply(FLIP_Y, scene.camera.viewProjection);
      for (const entry of this.entries) {
        if (!entry.light.visible.getBool()) continue;
        this.back.clear();
        entry.back.setViewProjectionMatrix(flipped);
        entry.back.setModelMatrix(entry.volumeModel);
        entry.back.setModelViewProjectionMatrix(M.multiply(flipped, entry.volumeModel));
        entry.back.render();
        const front = entry.inside ? entry.fullscreen : entry.front;
        front.setViewProjectionMatrix(M.multiply(BIAS01, scene.camera.viewProjection));
        front.setModelMatrix(entry.volumeModel);
        front.render();
      }
      this.passes.blurH.render();
      this.passes.blurV.render();
      this.passes.combine.render();
      gl.bindFramebuffer(gl.FRAMEBUFFER, scene.fbo.framebuffer);
    }
  }

  const api = { Lights, Volumetrics, MODULE, kindOf, KINDS, ATLAS_SIZE, SHADOW_QUALITY, packRegions, pointFaceView, sphereMesh, coneMesh, PassOwner, BIAS01, FLIP_Y };
  G.WELighting = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();

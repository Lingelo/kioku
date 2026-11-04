// Scanned PBR materials (Poly Haven sets: diff / nor_gl / arm) applied by world-space triplanar projection.
// The procedural objects of the video (lanterns, statues, shrine, pagoda, pines) and the steep ground have no
// usable UVs; a triplanar projection textures any shape at a constant scale, without stretching, seams or
// per-box UV distortion. Static objects only: the texture is pinned to the world, not to the object.
import * as THREE from 'three';

/** GLSL: triplanar colour / packed (arm) / normal (whiteout blend, world space). */
export const TRIPLANAR_GLSL = `
vec3 triW(vec3 n) { vec3 w = pow(abs(n), vec3(4.0)); return w / (w.x + w.y + w.z); }
vec4 triTex(sampler2D t, vec3 p, vec3 n, float s) {
  vec3 w = triW(n);
  return texture2D(t, p.zy * s) * w.x + texture2D(t, p.xz * s) * w.y + texture2D(t, p.xy * s) * w.z;
}
vec3 triNor(sampler2D t, vec3 p, vec3 n, float s, float strength) {
  vec3 w = triW(n);
  vec3 tx = texture2D(t, p.zy * s).xyz * 2.0 - 1.0, ty = texture2D(t, p.xz * s).xyz * 2.0 - 1.0, tz = texture2D(t, p.xy * s).xyz * 2.0 - 1.0;
  tx.xy *= strength; ty.xy *= strength; tz.xy *= strength;
  vec3 sg = sign(n);
  tx = vec3(tx.xy + n.zy, abs(tx.z) * n.x); tx.x *= sg.x;
  ty = vec3(ty.xy + n.xz, abs(ty.z) * n.y); ty.x *= sg.y;
  tz = vec3(tz.xy + n.xy, abs(tz.z) * n.z); tz.x *= sg.z;
  return normalize(tx.zyx * w.x + ty.xzy * w.y + tz.xyz * w.z);
}`;

/** Load a Poly Haven set from assets/<dir>/: { diff, nor, arm }. loadAsync only (virtual clock safe). */
export async function loadSet(loader, dir) {
  const [diff, nor, arm] = await Promise.all(['diff', 'nor_gl', 'arm'].map((m) => loader.loadAsync(`assets/${dir}/${m}.jpg`)));
  for (const t of [diff, nor, arm]) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 8; }
  diff.colorSpace = THREE.SRGBColorSpace;
  return { diff, nor, arm };
}

/**
 * MeshStandardMaterial textured by triplanar projection of a scanned set.
 * @param {{diff, nor, arm}} set
 * @param {object} o  scale = texture repeats per metre · tint = colour multiplier · normal = normal strength
 *                    rough = roughness multiplier · ao = ambient occlusion strength · gray = desaturation 0..1
 *                    moss = { set, amount }: moss on up-facing surfaces and in the crevices (scan AO), patchy
 *                    clearcoat = 0..1: a varnish over the scan (lacquer), with its own smooth highlight and reflection
 */
export function triMaterial(set, { scale = 1, tint = 0xffffff, normal = 1, rough = 1, ao = 1, gray = 0, moss = null, clearcoat = 0, side = THREE.FrontSide } = {}) {
  const mat = clearcoat
    ? new THREE.MeshPhysicalMaterial({ color: tint, roughness: 1, metalness: 0, side, clearcoat, clearcoatRoughness: 0.18 })
    : new THREE.MeshStandardMaterial({ color: tint, roughness: 1, metalness: 0, side });
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, { tDiff: { value: set.diff }, tNor: { value: set.nor }, tArm: { value: set.arm } });
    if (moss) Object.assign(sh.uniforms, { tMossD: { value: moss.set.diff } });
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vTriP; varying vec3 vTriN;')
      .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>
  vec4 triWp = vec4(transformed, 1.0);
  #ifdef USE_INSTANCING
    triWp = instanceMatrix * triWp;
  #endif
  triWp = modelMatrix * triWp;
  vTriP = triWp.xyz;
  vec3 triOn = objectNormal;
  #ifdef USE_INSTANCING
    triOn = mat3(instanceMatrix) * triOn;
  #endif
  vTriN = normalize(mat3(modelMatrix) * triOn);`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>\nuniform sampler2D tDiff; uniform sampler2D tNor; uniform sampler2D tArm; varying vec3 vTriP; varying vec3 vTriN;\n${moss ? 'uniform sampler2D tMossD;' : ''}\n${TRIPLANAR_GLSL}`)
      .replace('#include <map_fragment>', `
  vec3 triN0 = normalize(vTriN);
  vec4 triArm = triTex(tArm, vTriP, triN0, ${scale.toFixed(3)});
  vec3 triC = triTex(tDiff, vTriP, triN0, ${scale.toFixed(3)}).rgb;
  triC = mix(triC, vec3(dot(triC, vec3(0.299, 0.587, 0.114))), ${gray.toFixed(2)});
  ${moss ? `// moss: where rain and shade linger — faces looking up, and the crevices (dark in the scan's AO)
  float mUp = smoothstep(0.25, 0.85, triN0.y), mCrev = 1.0 - smoothstep(0.55, 0.95, triArm.r);
  float mPatch = smoothstep(0.35, 0.75, triTex(tArm, vTriP * 0.17 + 3.1, triN0, 1.0).g);
  float mK = clamp((0.75 * mUp + 0.6 * mCrev) * mPatch * ${moss.amount.toFixed(2)}, 0.0, 1.0);
  triC = mix(triC, triTex(tMossD, vTriP, triN0, ${(scale * 1.7).toFixed(3)}).rgb * vec3(0.85, 1.0, 0.7), mK);` : ''}
  diffuseColor.rgb *= triC * mix(1.0, triArm.r, ${ao.toFixed(2)});`)
      .replace('#include <roughnessmap_fragment>', `float roughnessFactor = clamp(triArm.g * ${rough.toFixed(2)}, 0.04, 1.0);`)
      .replace('#include <normal_fragment_maps>', `
  normal = normalize((viewMatrix * vec4(triNor(tNor, vTriP, triN0, ${scale.toFixed(3)}, ${normal.toFixed(2)}), 0.0)).xyz);
  #ifdef DOUBLE_SIDED
    normal *= faceDirection;
  #endif`);
  };
  mat.customProgramCacheKey = () => `tri-${set.diff.uuid}-${scale}-${normal}-${rough}-${ao}-${gray}-${moss ? moss.amount : 0}-${clearcoat}`;
  return mat;
}

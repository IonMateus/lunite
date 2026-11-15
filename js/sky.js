// sky.js: física da iluminação e do movimento dos astros, separada do app.js.
//
//  - earthFrame(t, g): orientação real da Terra no referencial fixo da Lua (MOON_ME). Usa dois vetores conhecidos nos dois
//    referenciais (método TRIAD): a direção Terra→Lua, cujo ponto sub-Lua na Terra vem do Horizons, e a direção do Sol,
//    cujo ponto subsolar na Terra sai das fórmulas do Almanaque (≈0,01°). Assim a Terra gira e inclina como a real.
//  - earthshine(g): iluminação da Terra sobre a Lua, relativa à do Sol (albedo da Terra × fase da Terra × (R_T/d)²).
//  - GLSL: fotometria lunar de McEwen (lunar-Lambert com o parâmetro L dependente do ângulo de fase), tone mapping ACES e
//    o sombreador da Terra (dia/noite, terminador, atmosfera).

const D2R = Math.PI / 180;
const unitV = (lat, lon) => { const a = lat * D2R, b = lon * D2R; return [Math.cos(a) * Math.cos(b), Math.cos(a) * Math.sin(b), Math.sin(a)]; };
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

// ponto subsolar na Terra (lat, lon leste, graus) no instante t (ms UTC); Almanaque Astronômico, precisão ~0,01°
export function subSolar(t) {
  const n = t / 86400000 + 2440587.5 - 2451545.0;
  const L = 280.460 + 0.9856474 * n, g = (357.528 + 0.9856003 * n) * D2R;
  const lam = (L + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * D2R, eps = (23.439 - 4e-7 * n) * D2R;
  const ra = Math.atan2(Math.cos(eps) * Math.sin(lam), Math.cos(lam)), dec = Math.asin(Math.sin(eps) * Math.sin(lam));
  const gmst = (280.46061837 + 360.98564736629 * n) * D2R;
  return { lat: dec / D2R, lon: ((((ra - gmst) / D2R) % 360) + 540) % 360 - 180 };
}

// eixos x, y, z da Terra (fixos na Terra) escritos no referencial da Lua, ou null se faltar o ponto sub-Lua (tabelas Apollo)
export function earthFrame(t, g) {
  if (!g.subMoon) return null;
  const eM = g.earthDir.slice(0, 3), sM = g.sun;                                    // na Lua: direção da Terra e do Sol
  const ss = subSolar(t), eE = unitV(g.subMoon.lat, g.subMoon.lon).map((v) => -v);    // na Terra: Lua→Terra (oposto do sub-Lua)
  const sE = unitV(ss.lat, ss.lon);
  const t1 = norm(eM), t2 = norm(cross(t1, sM)), t3 = cross(t1, t2);
  const u1 = norm(eE), u2 = norm(cross(u1, sE)), u3 = cross(u1, u2);
  // R = [t1 t2 t3] · [u1 u2 u3]ᵀ leva vetores da Terra para a Lua; as colunas de R são os eixos da Terra
  const col = (i) => [t1[0] * u1[i] + t2[0] * u2[i] + t3[0] * u3[i], t1[1] * u1[i] + t2[1] * u2[i] + t3[1] * u3[i], t1[2] * u1[i] + t2[2] * u2[i] + t3[2] * u3[i]];
  return { x: col(0), y: col(1), z: col(2) };
}

// iluminação da Terra sobre a Lua, como fração da iluminação do Sol (≈1e-4 com a Terra cheia)
export function earthshine(g) {
  const toMoon = g.earthDir.map((v) => -v), alpha = Math.acos(Math.max(-1, Math.min(1, dot(norm(g.sun), norm(toMoon)))));   // ângulo de fase da Terra
  const phase = (Math.sin(alpha) + (Math.PI - alpha) * Math.cos(alpha)) / Math.PI;   // esfera de Lambert
  const geomAlbedo = 0.367, k = 6371 / g.earthKm;
  return geomAlbedo * phase * k * k;
}

// ---------------------------------------------------------------------------------------------------------------- GLSL
// A mesma escala fotométrica vale para a Lua e para a Terra, então os brilhos relativos são reais: com a exposição no
// padrão (EV 0) o lado iluminado aparece bem exposto e a luz da Terra só aparece subindo a exposição (como numa foto).
export const GLSL_COMMON = `
  const float PHOTO = 2.4;   // radiância -> valor de tela no EV 0
  vec3 aces(vec3 x){ return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0); }
  vec3 toScreen(vec3 c){ return pow(aces(c), vec3(1.0 / 2.2)); }
  // McEwen (1991): r = A [ 2L mu0/(mu0+mu) + (1-L) mu0 ], L(alpha) ajustado às imagens Clementine/LRO
  float lunarLambert(float mu0, float mu, float alphaDeg){
    if (mu0 <= 0.0) return 0.0;
    float a = alphaDeg, L = clamp(1.0 - 0.019 * a + 2.42e-4 * a * a - 1.46e-6 * a * a * a, 0.0, 1.0);
    return 2.0 * L * mu0 / (mu0 + max(mu, 0.0) + 1e-4) + (1.0 - L) * mu0;
  }
  float phaseDeg(vec3 toSun, vec3 toCam){ return degrees(acos(clamp(dot(toSun, toCam), -1.0, 1.0))); }
`;

export const EARTH_VERT = `varying vec3 vO; varying vec3 vN; varying vec3 vWP;
  void main(){ vO = position; vN = normalize((modelMatrix * vec4(position, 0.0)).xyz); vWP = (modelMatrix * vec4(position, 1.0)).xyz;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
export const EARTH_FRAG = GLSL_COMMON + `
  uniform sampler2D day; uniform sampler2D night; uniform vec3 sunL; uniform float exposure;
  varying vec3 vO; varying vec3 vN; varying vec3 vWP;
  void main(){
    vec3 o = normalize(vO); float lon = atan(o.y, o.x), lat = asin(clamp(o.z, -1.0, 1.0));
    vec2 uv = vec2((lon + 3.14159265) / 6.2831853, (1.5707963 - lat) / 3.14159265);
    vec3 n = normalize(vN), V = normalize(cameraPosition - vWP);
    float d = dot(n, sunL), mu = max(dot(n, V), 0.0);
    vec3 alb = pow(texture2D(day, uv).rgb, vec3(2.2));
    vec3 c = alb * max(d, 0.0) * 1.15;                                         // superfície: Lambert
    float rim = pow(1.0 - mu, 2.5);
    c += vec3(0.30, 0.50, 1.00) * 0.35 * rim * smoothstep(-0.25, 0.35, d);     // espalhamento da atmosfera no limbo
    c = c * PHOTO * exposure;
    c += pow(texture2D(night, uv).rgb, vec3(2.2)) * (1.0 - smoothstep(-0.12, 0.04, d)) * 0.004 * exposure;   // luzes das cidades (fracas)
    gl_FragColor = vec4(toScreen(c), 1.0);
  }`;

// disco solar com escurecimento de borda (coeficiente ~0,6 no visível)
export function sunDiscCanvas() {
  const c = document.createElement('canvas'); c.width = c.height = 256; const x = c.getContext('2d');
  const img = x.createImageData(256, 256);
  for (let i = 0; i < 256; i++) for (let j = 0; j < 256; j++) {
    const dx = (j - 127.5) / 127.5, dy = (i - 127.5) / 127.5, r2 = dx * dx + dy * dy, k = 4 * (i * 256 + j);
    if (r2 > 1) { img.data[k + 3] = 0; continue; }
    const mu = Math.sqrt(1 - r2), I = 1 - 0.6 * (1 - mu), edge = Math.min(1, (1 - Math.sqrt(r2)) * 60);
    img.data[k] = 255; img.data[k + 1] = Math.round(255 * (0.93 + 0.07 * I)); img.data[k + 2] = Math.round(255 * (0.82 + 0.18 * I)); img.data[k + 3] = Math.round(255 * edge);
  }
  x.putImageData(img, 0, 0); return c;
}

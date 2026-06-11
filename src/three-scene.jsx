// Ambient three.js hero — a slow, organic blob displaced by simplex noise,
// shaded in the warm palette. Lightweight: one mesh, capped DPR, paused
// when the tab is hidden, static single frame under reduced motion.
import { useEffect, useRef } from 'react'
import { motionOK } from './anim.js'

const NOISE_GLSL = /* glsl */ `
vec3 mod289(vec3 x){return x-floor(x*(1.0/289.0))*289.0;}
vec4 mod289(vec4 x){return x-floor(x*(1.0/289.0))*289.0;}
vec4 permute(vec4 x){return mod289(((x*34.0)+1.0)*x);}
vec4 taylorInvSqrt(vec4 r){return 1.79284291400159-0.85373472095314*r;}
float snoise(vec3 v){
  const vec2 C=vec2(1.0/6.0,1.0/3.0);
  const vec4 D=vec4(0.0,0.5,1.0,2.0);
  vec3 i=floor(v+dot(v,C.yyy));
  vec3 x0=v-i+dot(i,C.xxx);
  vec3 g=step(x0.yzx,x0.xyz);
  vec3 l=1.0-g;
  vec3 i1=min(g.xyz,l.zxy);
  vec3 i2=max(g.xyz,l.zxy);
  vec3 x1=x0-i1+C.xxx;
  vec3 x2=x0-i2+C.yyy;
  vec3 x3=x0-D.yyy;
  i=mod289(i);
  vec4 p=permute(permute(permute(i.z+vec4(0.0,i1.z,i2.z,1.0))+i.y+vec4(0.0,i1.y,i2.y,1.0))+i.x+vec4(0.0,i1.x,i2.x,1.0));
  float n_=0.142857142857;
  vec3 ns=n_*D.wyz-D.xzx;
  vec4 j=p-49.0*floor(p*ns.z*ns.z);
  vec4 x_=floor(j*ns.z);
  vec4 y_=floor(j-7.0*x_);
  vec4 x=x_*ns.x+ns.yyyy;
  vec4 y=y_*ns.x+ns.yyyy;
  vec4 h=1.0-abs(x)-abs(y);
  vec4 b0=vec4(x.xy,y.xy);
  vec4 b1=vec4(x.zw,y.zw);
  vec4 s0=floor(b0)*2.0+1.0;
  vec4 s1=floor(b1)*2.0+1.0;
  vec4 sh=-step(h,vec4(0.0));
  vec4 a0=b0.xzyw+s0.xzyw*sh.xxyy;
  vec4 a1=b1.xzyw+s1.xzyw*sh.zzww;
  vec3 p0=vec3(a0.xy,h.x);
  vec3 p1=vec3(a0.zw,h.y);
  vec3 p2=vec3(a1.xy,h.z);
  vec3 p3=vec3(a1.zw,h.w);
  vec4 norm=taylorInvSqrt(vec4(dot(p0,p0),dot(p1,p1),dot(p2,p2),dot(p3,p3)));
  p0*=norm.x;p1*=norm.y;p2*=norm.z;p3*=norm.w;
  vec4 m=max(0.6-vec4(dot(x0,x0),dot(x1,x1),dot(x2,x2),dot(x3,x3)),0.0);
  m=m*m;
  return 42.0*dot(m*m,vec4(dot(p0,x0),dot(p1,x1),dot(p2,x2),dot(p3,x3)));
}
`

const VERT = /* glsl */ `
uniform float uTime;
uniform float uAmp;
varying float vNoise;
varying vec3 vNormal;
varying vec3 vView;
${NOISE_GLSL}
void main(){
  float n = snoise(normal * 1.15 + vec3(uTime * 0.12, uTime * 0.09, uTime * 0.07));
  float n2 = snoise(normal * 2.6 - vec3(0.0, uTime * 0.06, uTime * 0.1));
  vNoise = n * 0.8 + n2 * 0.2;
  vec3 displaced = position + normal * (vNoise * uAmp);
  vec4 mv = modelViewMatrix * vec4(displaced, 1.0);
  vNormal = normalize(normalMatrix * normal);
  vView = normalize(-mv.xyz);
  gl_Position = projectionMatrix * mv;
}
`

const FRAG = /* glsl */ `
uniform vec3 uColorA;
uniform vec3 uColorB;
uniform vec3 uColorC;
varying float vNoise;
varying vec3 vNormal;
varying vec3 vView;
void main(){
  float fresnel = pow(1.0 - max(dot(vNormal, vView), 0.0), 1.9);
  float t = smoothstep(-0.85, 0.95, vNoise);
  vec3 col = mix(uColorA, uColorB, t);
  // soft top-left light
  float lt = max(dot(vNormal, normalize(vec3(0.45, 0.7, 0.55))), 0.0);
  col *= 0.93 + lt * 0.13;
  // gold sheen, then melt the rim into warm ivory so edges stay airy
  col = mix(col, uColorC, fresnel * 0.6);
  col = mix(col, vec3(0.964, 0.945, 0.912), fresnel * 0.55);
  gl_FragColor = vec4(col, 1.0);
}
`

export function createAmbient(container, opts = {}) {
  const THREE = window.THREE
  if (!THREE || !container) return null

  const {
    amp = 0.5,
    speed = 1,
    scale = 1,
    colors = ['#f2d6cf', '#d28d80', '#e8cfa0'],
  } = opts

  const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75))
  renderer.setClearColor(0x000000, 0)
  container.appendChild(renderer.domElement)
  renderer.domElement.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block;'

  const scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 50)
  camera.position.z = 5.2

  const geo = new THREE.IcosahedronGeometry(1.7 * scale, 48)
  const mat = new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    uniforms: {
      uTime: { value: 0 },
      uAmp: { value: amp },
      uColorA: { value: new THREE.Color(colors[0]) },
      uColorB: { value: new THREE.Color(colors[1]) },
      uColorC: { value: new THREE.Color(colors[2]) },
    },
  })
  const blob = new THREE.Mesh(geo, mat)
  scene.add(blob)

  let raf = 0
  let running = true
  const mouse = { x: 0, y: 0, tx: 0, ty: 0 }
  const clock = new THREE.Clock()

  const resize = () => {
    const w = container.clientWidth || 1
    const h = container.clientHeight || 1
    renderer.setSize(w, h, false)
    camera.aspect = w / h
    camera.updateProjectionMatrix()
    // setSize clears the canvas — repaint when the loop isn't running
    if (!running) render()
  }
  const ro = new ResizeObserver(resize)
  ro.observe(container)
  resize()

  const onMouse = (e) => {
    mouse.tx = (e.clientX / window.innerWidth - 0.5) * 2
    mouse.ty = (e.clientY / window.innerHeight - 0.5) * 2
  }
  window.addEventListener('pointermove', onMouse, { passive: true })

  const render = () => {
    const dt = clock.getDelta()
    mat.uniforms.uTime.value += dt * 0.55 * speed
    blob.rotation.y += dt * 0.06 * speed
    blob.rotation.z += dt * 0.02 * speed
    mouse.x += (mouse.tx - mouse.x) * 0.035
    mouse.y += (mouse.ty - mouse.y) * 0.035
    blob.position.x = mouse.x * 0.18
    blob.position.y = -mouse.y * 0.14
    // subtle parallax tilt toward the pointer
    blob.rotation.x += (mouse.y * 0.12 - blob.rotation.x) * 0.03
    renderer.render(scene, camera)
  }

  const loop = () => {
    if (!running) return
    render()
    raf = requestAnimationFrame(loop)
  }

  const onVis = () => {
    if (document.hidden) {
      running = false
      cancelAnimationFrame(raf)
    } else if (motionOK()) {
      running = true
      clock.getDelta()
      loop()
    }
  }
  document.addEventListener('visibilitychange', onVis)

  if (motionOK()) {
    loop()
  } else {
    // single static frame
    running = false
    mat.uniforms.uTime.value = 3.2
    render()
  }

  return {
    destroy() {
      running = false
      cancelAnimationFrame(raf)
      document.removeEventListener('visibilitychange', onVis)
      window.removeEventListener('pointermove', onMouse)
      ro.disconnect()
      geo.dispose()
      mat.dispose()
      renderer.dispose()
      if (renderer.domElement.parentNode === container) {
        container.removeChild(renderer.domElement)
      }
    },
  }
}

export function Ambient({ className, style, ...opts }) {
  const ref = useRef(null)
  const optsRef = useRef(opts)
  useEffect(() => {
    const inst = createAmbient(ref.current, optsRef.current)
    return () => inst && inst.destroy()
  }, [])
  return <div ref={ref} className={className} style={style} aria-hidden="true" />
}

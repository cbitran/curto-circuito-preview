import * as THREE from 'three';

// Local light shafts: crossed soft cards, eight practical pools and four shadowless lights.
// No full-screen fog or ray marching; the playable floor remains unobscured.
export function createExteriorLighting() {
  const group = new THREE.Group(); group.name = 'Exterior lighting v15';
  const canvas = document.createElement('canvas'); canvas.width=canvas.height=128;
  const ctx=canvas.getContext('2d'), gradient=ctx.createRadialGradient(64,64,0,64,64,64);
  gradient.addColorStop(0,'rgba(255,225,170,0.65)'); gradient.addColorStop(.32,'rgba(255,160,65,0.35)'); gradient.addColorStop(1,'rgba(255,110,30,0)');
  ctx.fillStyle=gradient;ctx.fillRect(0,0,128,128);
  const tex=new THREE.CanvasTexture(canvas);tex.colorSpace=THREE.SRGBColorSpace;
  const poolMat=new THREE.MeshBasicMaterial({map:tex,color:0xffb269,transparent:true,blending:THREE.AdditiveBlending,depthWrite:false,opacity:.65,toneMapped:false});
  const beamMat=new THREE.ShaderMaterial({transparent:true,depthWrite:false,side:THREE.DoubleSide,blending:THREE.AdditiveBlending,
    uniforms:{uColor:{value:new THREE.Color(0xffa45b)}},
    vertexShader:`varying vec2 vUv;void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}`,
    fragmentShader:`varying vec2 vUv;uniform vec3 uColor;void main(){float width=mix(.5,.08,vUv.y);float edge=exp(-pow((vUv.x-.5)/width,2.)*5.);float ends=smoothstep(0.,.12,vUv.y)*(1.-smoothstep(.90,1.,vUv.y));float a=edge*ends*.13;gl_FragColor=vec4(uColor*1.5,a);}`});
  for(let i=0;i<8;i++){
    const a=i*Math.PI/4, x=Math.cos(a), z=-Math.sin(a);
    const pool=new THREE.Mesh(new THREE.PlaneGeometry(1.8,1.8),poolMat);pool.rotation.x=-Math.PI/2;pool.position.set(8.9*x,-.895,8.9*z);group.add(pool);
    const shaft=new THREE.Group();shaft.position.set(8.75*x,-.35,8.75*z);
    for(let j=0;j<3;j++){const card=new THREE.Mesh(new THREE.PlaneGeometry(1.25,1.06),beamMat);card.rotation.y=a+j*Math.PI/3;shaft.add(card);}group.add(shaft);
    if(i%2===0){const light=new THREE.SpotLight(0xffa054,14,4,Math.PI/3,.75,2);light.position.set(8.6*x,.18,8.6*z);light.target.position.set(8.9*x,-.88,8.9*z);light.castShadow=false;group.add(light,light.target);}
  }
  group.userData.dispose=()=>{tex.dispose();poolMat.dispose();beamMat.dispose();group.traverse(o=>o.geometry?.dispose());};
  return group;
}

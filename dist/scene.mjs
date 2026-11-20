import * as T from './three.js';
import {createCanvasView} from './canvas-view.mjs';
import {circuit,phases} from './model.mjs';
import {balance,mmPerUnit,placementOptions} from './layout.mjs';
import {peripherals,installedPeripherals,wireTypes} from './peripherals.mjs';

export function createScene(host){
  let renderer,software=false;
  try{renderer=new T.WebGLRenderer({alpha:true,antialias:true});}catch{
    renderer=createCanvasView();
    software=Boolean(renderer);
  }
  if(!renderer){
    host.innerHTML='<p style="padding:70px 20px">The 3D viewport requires WebGL. Assembly, wiring and telemetry are still available.</p>';
    return {available:false,build(){},pose(){},view(){},setFrame(){},setPicker(){},setSelection(){}};
  }
  renderer.setPixelRatio(Math.min(devicePixelRatio,2));
  renderer.outputColorSpace=T.SRGBColorSpace;
  renderer.toneMapping=T.ACESFilmicToneMapping;
  host.append(renderer.domElement);
  const scene=new T.Scene(), drone=new T.Group(), camera=new T.PerspectiveCamera(36,1,.05,3200);
  scene.add(drone);
  scene.add(new T.HemisphereLight(0xe0f0ff,0x635340,3));
  const key=new T.DirectionalLight(0xffe5d0,3);
  key.position.set(-4,9,6);scene.add(key);
  const rim=new T.DirectionalLight(0x89adff,2.4);
  rim.position.set(6,4,-7);scene.add(rim);
  const grid=new T.GridHelper(25,50,0x626b76,0x44505b);
  grid.material.transparent=true;grid.material.opacity=.37;scene.add(grid);
  const mat=(color,metalness=.2,roughness=.52)=>new T.MeshStandardMaterial({color,metalness,roughness});
  const metal=mat(0x88929e,.65,.27), black=mat(0x15191f,.42), edge=mat(0x3a424d,.55);
  const orange=mat(0xf58e49,.4,.38), pcb=mat(0x234d43), chip=mat(0x12191c), copper=mat(0xbd7543,.6);
  const tex=document.createElement('canvas');tex.width=tex.height=32;
  const ctx=tex.getContext('2d');
  for(let y=0;y<8;y++)for(let x=0;x<8;x++){
    ctx.fillStyle=(x+y)%2?'#343a43':'#20262f';ctx.fillRect(x*4,y*4,4,4);
    ctx.fillStyle='#ffffff12';ctx.fillRect(x*4,y*4,4,1);
  }
  const pattern=new T.CanvasTexture(tex);pattern.wrapS=pattern.wrapT=T.RepeatWrapping;
  pattern.repeat.set(5,4);pattern.anisotropy=renderer.capabilities.getMaxAnisotropy();
  pattern.colorSpace=T.SRGBColorSpace;
  const carbon=new T.MeshStandardMaterial({map:pattern,color:0xb2b8c3,roughness:.49,metalness:.49});
  const shades=Object.fromEntries(Object.entries(wireTypes).map(([kind,{color}])=>[kind,mat(color)]));
  const spinning=[];
  const cadMaterial=mat(0x7e9ab1,.38,.51);
  cadMaterial.side=T.DoubleSide;
  const markerMaterial=new T.MeshBasicMaterial({color:0x99ffcd,depthTest:false});
  const raycaster=new T.Raycaster();
  const selectionMaterial=new T.MeshBasicMaterial({color:0xffb271,depthTest:false,side:T.DoubleSide});
  let surfaces=[], selectable=[], activeCenters={}, selection=null, onSelect=null;
  let selectionRing=null;
  function setSelection(id,callback){
    selection=id;
    onSelect=callback;
    if(!selectionRing){
      selectionRing=mesh(drone,new T.RingGeometry(.36,.40,40),selectionMaterial,0,0,0);
      selectionRing.rotation.x=-Math.PI/2;
      selectionRing.renderOrder=3;
    }
    const center=activeCenters[id];
    selectionRing.visible=Boolean(center&&callback);
    if(center){selectionRing.position.copy(center);selectionRing.position.y+=id==='BAT'?.23:.18;}
  }
  let frameGeometry=null,frameMesh=null,picker=null,fit=13.8,frameHeight=0;

  function setFrame(raw,units=1,axis='Z'){
    const next=raw?.clone()??null;
    let height=0,extent=0;
    if(next){
      if(axis==='Z')next.rotateX(-Math.PI/2);
      next.scale(units/mmPerUnit,units/mmPerUnit,units/mmPerUnit);
      next.computeBoundingBox();
      const bounds=next.boundingBox, size=bounds.getSize(new T.Vector3());
      const center=bounds.getCenter(new T.Vector3());
      extent=Math.max(size.x,size.y,size.z);
      if(!Number.isFinite(extent)||extent<.025||extent>250){next.dispose();throw new Error('Model dimensions are out of range. Check the STL units.');}
      next.translate(-center.x,-bounds.min.y,-center.z);
      next.computeBoundingSphere();
      height=size.y;
    }
    frameGeometry?.dispose();
    frameGeometry=next;
    frameHeight=height;
    fit=next?Math.max(5,extent*2.25):13.8;
    view('orbit');
  }
  function setPicker(callback){
    picker=callback;
    host.classList.toggle('placing',Boolean(callback));
  }
  function pick(event,objects){
    if(!objects.length)return null;
    const rect=renderer.domElement.getBoundingClientRect();
    const pointer=new T.Vector2((event.clientX-rect.left)/rect.width*2-1,1-(event.clientY-rect.top)/rect.height*2);
    raycaster.setFromCamera(pointer,camera);
    scene.updateMatrixWorld();
    camera.updateMatrixWorld();
    return raycaster.intersectObjects(objects,true)[0]??null;
  }
  function mesh(parent,geometry,material,x,y,z){
    const object=new T.Mesh(geometry,material);object.position.set(x,y,z);parent.add(object);return object;
  }
  const box=(p,w,h,d,m,x=0,y=0,z=0)=>mesh(p,new T.BoxGeometry(w,h,d),m,x,y,z);
  const cyl=(p,r,h,m,x=0,y=0,z=0,n=36)=>mesh(p,new T.CylinderGeometry(r,r,h,n),m,x,y,z);
  function plate(parent,points,height,material,y){
    const outline=new T.Shape();points.forEach(([x,z],i)=>i?outline.lineTo(x,z):outline.moveTo(x,z));outline.closePath();
    const geo=new T.ExtrudeGeometry(outline,{depth:height,bevelEnabled:true,bevelThickness:.025,bevelSize:.025,bevelSegments:2});
    geo.rotateX(Math.PI/2);
    return mesh(parent,geo,material,0,y,0);
  }
  function label(str,color='#f7b27b'){
    const c=document.createElement('canvas');c.width=160;c.height=64;
    const pen=c.getContext('2d');
    pen.fillStyle='#222932';pen.beginPath();pen.roundRect(3,4,154,54,11);pen.fill();
    pen.strokeStyle='#697480';pen.lineWidth=2;pen.stroke();
    pen.font='600 28px monospace';pen.fillStyle=color;pen.textAlign='center';pen.fillText(str,80,41);
    const map=new T.CanvasTexture(c);map.colorSpace=T.SRGBColorSpace;
    const sprite=new T.Sprite(new T.SpriteMaterial({map,depthTest:false}));
    sprite.scale.set(.73,.292,1);return sprite;
  }
  const base=[[-.73,-1.08],[.73,-1.08],[1.02,-.54],[.93,.64],[.55,1.13],[-.55,1.13],[-.93,.64],[-1.02,-.54]];
  const deckY=.465;
  function standoffs(x,z,halfX,halfZ,bottom,top){
    for(const dx of [-halfX,halfX])for(const dz of [-halfZ,halfZ]){
      cyl(drone,.046,top-bottom,metal,x+dx,(bottom+top)/2,z+dz,8);
    }
  }
  function build(s,custom=null,positions={}){
    drone.traverse(o=>{if(o!==frameMesh)o.geometry?.dispose();if(o.isSprite){o.material.map.dispose();o.material.dispose();}});
    drone.clear();spinning.length=0;
    const ports={}, centers={}, mountNormals={};
    const up=new T.Vector3(0,1,0);
    surfaces=[];selectable=[];activeCenters=centers;selectionRing=null;
    frameMesh=custom&&frameGeometry?mesh(drone,frameGeometry,cadMaterial,0,0,0):null;
    if(frameMesh)surfaces.push(frameMesh);
    function movePart(id,start,anchor,center,prefixes){
      const mount=positions[id];
      const attached=Number.isFinite(mount?.x);
      const objects=drone.children.slice(start);
      if(!attached&&frameMesh){
        for(const object of objects){
          object.traverse(child=>child.geometry?.dispose());
          drone.remove(object);
        }
        for(const key of Object.keys(ports))if(prefixes.some(p=>key.startsWith(p)))delete ports[key];
        return;
      }
      if(objects.length){
        for(const object of objects)object.userData.component=id;
        selectable.push(...objects);
        centers[id]=new T.Vector3(...center);
      }
      if(!attached&&!mount?.turn)return;
      const base=new T.Vector3(...anchor);
      const destination=attached?new T.Vector3(mount.x,mount.y,mount.z):base;
      const normal=mount?.normal?new T.Vector3(...mount.normal).normalize():up;
      mountNormals[id]=normal;
      const turn=new T.Quaternion().setFromAxisAngle(up,(mount?.turn??0)*Math.PI/2);
      const rotation=new T.Quaternion().setFromUnitVectors(up,normal).multiply(turn);
      const transform=point=>point.sub(base).applyQuaternion(rotation).add(destination);
      for(const object of objects){
        transform(object.position);
        object.quaternion.premultiply(rotation);
      }
      for(const [key,point] of Object.entries(ports))if(prefixes.some(p=>key.startsWith(p)))transform(point);
      if(centers[id])transform(centers[id]);
    }
    if(!frameMesh){
      surfaces.push(plate(drone,base,.11,carbon,.44));
      surfaces.push(plate(drone,base.map(([x,z])=>[x*.89,z*.87]),.08,edge,.31));
      for(const x of [-.62,.62])for(const z of [-.72,.72]){
        cyl(drone,.07,.37,black,x,.26,z,12);
        cyl(drone,.075,.038,metal,x,.46,z,8);
        cyl(drone,.026,.008,black,x,.481,z,6);
        box(drone,.21,.13,.27,black,x,.065,z);
      }
      plate(drone,[[0,-.96],[-.16,-.7],[.16,-.7]],.01,orange,.462);
    }
    const radius=s.n===4?2.52:2.93;
    const mounts=Array.from({length:s.n},(_,i)=>{
      const a=(i+.5)*2*Math.PI/s.n;
      return [Math.sin(a)*radius,-Math.cos(a)*radius];
    });
    mounts.forEach(([x,z],i)=>{
      if(!frameMesh){
        const arm=new T.Group();
        arm.position.set(x/2,.33,z/2);arm.rotation.y=Math.atan2(x,z);drone.add(arm);
        box(arm,.49,.115,radius,edge);
        surfaces.push(box(arm,.46,.082,radius,carbon,0,.084,0));
        box(arm,.048,.012,radius*.65,orange,-.15,.13,0);
        cyl(drone,.46,.115,edge,x,.344,z,24);
        cyl(drone,.423,.085,carbon,x,.428,z,24);
        surfaces.push(cyl(drone,.337,.02,black,x,.478,z,36));
        for(let j=0;j<4;j++){
          const k=j*Math.PI/2;
          cyl(drone,.054,.029,metal,x+Math.sin(k)*.29,.496,z+Math.cos(k)*.29,8);
          cyl(drone,.021,.006,black,x+Math.sin(k)*.29,.514,z+Math.cos(k)*.29,6);
        }
      }
      const start=drone.children.length;
      if(s.motor[i]!=null){
        cyl(drone,.337,.048,metal,x,.51,z);
        cyl(drone,.34,.245,s.motor[i]?metal:black,x,.65,z);
        cyl(drone,.345,.051,orange,x,.77,z);
        for(let j=0;j<10;j++){
          const a=j*Math.PI/5;
          const vent=box(drone,.10,.014,.056,black,x+.25*Math.sin(a),.798,z+.25*Math.cos(a));
          vent.rotation.y=a;
          cyl(drone,.024,.035,copper,x+.299*Math.sin(a),.666,z+.299*Math.cos(a),10);
        }
        cyl(drone,.071,.105,metal,x,.83,z,16);
        phases.forEach((phase,j)=>{
          const offset=(j-1)*.085/radius;
          ports['M'+(i+1)+'.'+phase]=new T.Vector3(x*.9-z*offset,.49,z*.9+x*offset);
        });
      }
      if(s.prop[i]!=null&&s.motor[i]!=null){
        const prop=new T.Group();prop.position.set(x,.90,z);drone.add(prop);
        const blades=s.prop[i]===1?2:3;
        for(let j=0;j<blades;j++){
          const blade=new T.Group();blade.rotation.y=j*2*Math.PI/blades;prop.add(blade);
          plate(blade,[[-.085,.08],[-.18,.7],[-.1,1.03],[.04,1.08],[.14,.91],[.15,.55],[.07,.08]],.027,i%2?edge:orange,0);
        }
        cyl(prop,.139,.06,black,0,0,0);
        cyl(prop,.068,.045,metal,0,.051,0,6);
        if(!frameMesh||Number.isFinite(positions['M'+(i+1)]?.x))spinning.push([prop,i%2?1:-1]);
      }
      movePart('M'+(i+1),start,[x,.486,z],[x,.65,z],['M'+(i+1)+'.']);
      if(!frameMesh){
        const mark=label('M'+(i+1)+(i%2?' ↺':' ↻'));
        mark.position.set(x*1.24,.24,z*1.24);drone.add(mark);
      }
    });
    const stackZ=-.48;
    const escY=.55;
    const sharesStack=s.esc!=null&&!frameMesh&&!positions.ESC&&!positions.FC;
    if(s.esc!=null){
      const start=drone.children.length;
      standoffs(0,stackZ,.43,.36,deckY,escY-.04);
      box(drone,1.09,.08,.89,pcb,0,escY,stackZ);
      for(const x of [-.29,0,.29]){
        box(drone,.17,.08,.19,chip,x,escY+.078,stackZ+.14);
        box(drone,.17,.08,.19,chip,x,escY+.078,stackZ-.14);
      }
      for(let i=0;i<s.n;i++){
        const [x,z]=mounts[i], side=Math.sign(x);
        const row=stackZ+z/radius*.29;
        phases.forEach((phase,j)=>{
          const padZ=row+(j-1)*.047;
          const padX=side*(.46-(1-Math.abs(x/radius))*.24);
          box(drone,.034,.016,.030,copper,padX,escY+.042,padZ);
          ports['ESC.M'+(i+1)+phase]=new T.Vector3(padX,escY+.052,padZ);
        });
        ports['ESC.IN'+(i+1)]=new T.Vector3(.49,escY+.055,stackZ-.31+.085*i);
      }
      Object.assign(ports,{'ESC.VBAT':new T.Vector3(-.40,escY+.053,stackZ+.39),'ESC.GND':new T.Vector3(-.25,escY+.053,stackZ+.39),'ESC.BEC':new T.Vector3(.43,escY+.053,stackZ+.39),'ESC.SGND':new T.Vector3(.32,escY+.053,stackZ+.39)});
      movePart('ESC',start,[0,deckY,stackZ],[0,escY,stackZ],['ESC.']);
    }
    if(s.controller!=null){
      const start=drone.children.length;
      const bottom=sharesStack?escY+.04:deckY;
      const h=bottom+(sharesStack?.164:.077);
      standoffs(0,stackZ,.43,.36,bottom,h-.04);
      box(drone,1.04,.08,.89,s.controller?black:pcb,0,h,stackZ);
      box(drone,.43,.07,.34,s.controller?edge:chip,0,h+.06,stackZ);
      if(s.controller===2){
        box(drone,1.13,.21,.90,black,0,h+.12,stackZ);
        box(drone,.79,.04,.60,edge,0,h+.244,stackZ);
      }
      for(let i=0;i<7;i++){
        box(drone,.055,.056,.11,metal,-.42+i*.14,h+.049,stackZ-.41);
        box(drone,.04,.05,.10,copper,-.42+i*.14,h+.04,stackZ+.39);
      }
      box(drone,.18,.1,.23,metal,-.47,h+.06,stackZ);
      for(let i=0;i<s.n;i++){
        const z=stackZ-.32+.115*i;
        box(drone,.07,.04,.058,copper,.51,h+.05,z);
        ports['FC.OUT'+(i+1)]=new T.Vector3(.54,h+.07,z);
      }
      ports['FC.5V']=new T.Vector3(.42,h+.065,stackZ+.41);
      ports['FC.GND']=new T.Vector3(.28,h+.065,stackZ+.41);
      movePart('FC',start,[0,bottom,stackZ],[0,h+(s.controller===2?.12:0),stackZ],['FC.']);
    }
    if(s.controller===2){
      const start=drone.children.length;
      box(drone,.25,.045,.43,black,.55,deckY+.022,.42);
      box(drone,.25,.065,.43,pcb,.55,deckY+.077,.42);
      box(drone,.16,.09,.18,chip,.55,deckY+.151,.42);
      Object.assign(ports,{'PM.IN+':new T.Vector3(.52,deckY+.116,.61),'PM.IN−':new T.Vector3(.61,deckY+.116,.61),'PM.5V':new T.Vector3(.52,deckY+.116,.23),'PM.GND':new T.Vector3(.61,deckY+.116,.23)});
      movePart('PM',start,[.55,deckY,.42],[.55,deckY+.08,.42],['PM.']);
    }
    if(s.battery!=null){
      const start=drone.children.length;
      const x=-.17,z=.51;
      const pad=.046;
      const h=deckY+pad+.17;
      box(drone,.78,pad,1.00,black,x,deckY+pad/2,z);
      box(drone,.74,.34,.96,black,x,h,z);
      box(drone,.746,.321,.60,orange,x,h,z);
      for(const strapZ of [z-.23,z+.23]){
        box(drone,.80,.044,.15,carbon,x,h+.175,strapZ);
        for(const dx of [-.389,.389])box(drone,.039,pad+.36,.15,carbon,x+dx,deckY+(pad+.36)/2,strapZ);
      }
      box(drone,.18,.14,.16,orange,-.35,h,.99);
      ports['BAT.+']=new T.Vector3(-.40,h,1.07);
      ports['BAT.−']=new T.Vector3(-.30,h,1.07);
      movePart('BAT',start,[x,deckY,z],[x,h,z],['BAT.']);
    }
    const {links,groups}=circuit(s);
    const accessories=installedPeripherals(s);
    accessories.forEach((id,i)=>{
      const start=drone.children.length;
      const [mx,mz]=mounts[Math.floor(i/2)%s.n];
      const fraction=i%2?.66:.43;
      const x=mx*fraction,z=mz*fraction;
      const h=deckY+.06;
      const item=peripherals[id];
      const signalKind=item.pins.find(pin=>!['power','ground'].includes(pin[2]))?.[2]??'signal';
      box(drone,.31,.10,.34,chip,x,h,z);
      box(drone,.27,.04,.29,shades[signalKind],x,h+.07,z);
      if(id==='GPS'||id==='GPSCAN')cyl(drone,.09,.044,metal,x,h+.105,z,16);
      if(id==='RC'||id==='RADIO'||id==='ADSB')cyl(drone,.018,.17,black,x+.12,h+.11,z-.12,8);
      item.pins.forEach(([pin],j)=>{
        const contact=x-.105+.07*j;
        box(drone,.038,.025,.047,copper,contact,h+.058,z+.17);
        ports[id+'.'+pin]=new T.Vector3(contact,h+.072,z+.188);
      });
      movePart(id,start,[x,deckY,z],[x,h,z],[id+'.']);
    });
    if(centers.FC){
      const expansion=groups.filter(g=>g.type==='port').flatMap(g=>g.pins.map(pin=>g.id+'.'+pin));
      const chipBase=ports['FC.5V']??centers.FC;
      expansion.forEach((pin,i)=>{ports[pin]=chipBase.clone().lerp(centers.FC,(i%8)*.04);});
    }
    const routed=links.filter(l=>s.wires.includes(l.key)&&ports[l.a]&&ports[l.b]);
    if(s.payload>0){
      const start=drone.children.length;
      box(drone,.43,.17,.43,edge,0,deckY+.085,0);
      movePart('LOAD',start,[0,deckY,0],[0,deckY+.085,0],[]);
    }
    const frameMass=custom?.mass??(s.n===4?128:196);
    const weights=placementOptions(s).map(entry=>({...entry,position:centers[entry.id]??null}));
    const harness=routed.map(l=>({mass:.55,position:ports[l.a].clone().lerp(ports[l.b],.5)}));
    const result=balance([...weights,...harness],frameMass,frameMesh?frameHeight/2:.25);
    result.rotorAligned=mounts.every((_,i)=>(mountNormals['M'+(i+1)]?.y??1)>.98);
    result.rotors=mounts.map((_,i)=>centers['M'+(i+1)]??null);
    const frameRadius=frameMesh?frameGeometry.boundingSphere.radius*.55:radius*.6;
    const inertia=(axis)=>Math.max(.001,frameMass*.001*(frameRadius*.04)**2+
      weights.reduce((sum,{position,mass})=>position?sum+mass*.001*.04**2*((position[axis]-result[axis])**2+(position.y-result.y)**2):sum,0));
    result.pitchInertia=inertia('z');
    result.rollInertia=inertia('x');
    if(frameMesh||Object.keys(positions).length){
      if(result.rotors.every(Boolean)){
        const thrust=result.rotors.reduce((v,r)=>v.add(r),new T.Vector3()).divideScalar(s.n);
        result.offset=Math.hypot(result.x-thrust.x,result.z-thrust.z);
      }
      const marker=mesh(drone,new T.SphereGeometry(.10,16,12),markerMaterial,result.x,result.y,result.z);
      marker.renderOrder=2;
    }
    pivot.set(result.x,result.y,result.z);
    for(const link of routed){
      const a=ports[link.a], b=ports[link.b];
      const curve=new T.CubicBezierCurve3(a,a.clone().add(new T.Vector3(0,.16,0)),b.clone().add(new T.Vector3(0,.13,0)),b);
      mesh(drone,new T.TubeGeometry(curve,20,link.kind==='power'?.021:.013,6,false),shades[link.kind],0,0,0);
    }
    setSelection(selection,onSelect);
    return result;
  }
  const pivot=new T.Vector3(), rotatedPivot=new T.Vector3();
  let tiltPitch=0,tiltRoll=0;
  let yaw=-.33,pitch=.64,distance=13.8,target=.25,drag=null,spin=0,alt=0;
  function view(mode){
    const orientations={top:[0,1.565],bottom:[0,-1.565],left:[-Math.PI/2,0],right:[Math.PI/2,0],orbit:[-.33,.64]};
    [yaw,pitch]=orientations[mode]??orientations.orbit;
    distance=fit;
  }
  renderer.domElement.addEventListener('pointerdown',e=>{
    if(e.button!==0)return;
    drag={x:e.clientX,y:e.clientY,moved:false};
    renderer.domElement.setPointerCapture(e.pointerId);
  });
  renderer.domElement.addEventListener('pointermove',e=>{
    if(!drag)return;
    const dx=e.clientX-drag.x,dy=e.clientY-drag.y;
    if(!drag.moved&&Math.hypot(dx,dy)<5)return;
    drag.moved=true;drag.x=e.clientX;drag.y=e.clientY;
    yaw-=dx*.009;pitch=Math.min(1.565,Math.max(-1.565,pitch+dy*.008));
  });
  renderer.domElement.addEventListener('pointerup',e=>{
    if(drag&&!drag.moved){
      if(picker){
        const hit=pick(e,surfaces);
        if(!hit){picker(null);return;}
        const normal=hit.face.normal.clone().applyMatrix3(new T.Matrix3().getNormalMatrix(hit.object.matrixWorld)).normalize();
        if(normal.dot(raycaster.ray.direction)>0)normal.negate();
        normal.applyQuaternion(drone.quaternion.clone().invert());
        picker(drone.worldToLocal(hit.point),normal.toArray());
      }else if(onSelect){
        let object=pick(e,selectable)?.object;
        while(object&&!object.userData.component)object=object.parent;
        if(object)onSelect(object.userData.component);
      }
    }
    drag=null;
  });
  for(const type of ['pointercancel','lostpointercapture'])renderer.domElement.addEventListener(type,()=>drag=null);
  renderer.domElement.addEventListener('wheel',e=>{e.preventDefault();distance=Math.min(fit*3,Math.max(fit*.28,distance*Math.exp(e.deltaY*.001)));},{passive:false});
  new ResizeObserver(()=>{
    if(!host.clientHeight)return;
    renderer.setSize(host.clientWidth,host.clientHeight,false);camera.aspect=host.clientWidth/host.clientHeight;camera.updateProjectionMatrix();
  }).observe(host);
  let last=performance.now(),previousFrame=null;
  renderer.setAnimationLoop(now=>{
    const dt=Math.min(.05,(now-last)/1000);last=now;
    drone.rotation.set(tiltPitch,0,tiltRoll);
    rotatedPivot.copy(pivot).applyEuler(drone.rotation);
    drone.position.copy(pivot).sub(rotatedPivot);
    drone.position.y+=alt*1.3;
    target+=((frameMesh?frameHeight*.5:.24)+drone.position.y*.74-target)*.1;
    const d=distance*Math.max(1,1.24/camera.aspect);
    camera.position.set(Math.sin(yaw)*Math.cos(pitch)*d,target+Math.sin(pitch)*d,Math.cos(yaw)*Math.cos(pitch)*d);
    camera.lookAt(0,target,0);
    for(const [p,dir] of spinning)p.rotation.y+=dt*spin*42*dir;
    const revision=[yaw,pitch,distance,target.toFixed(4),camera.aspect,renderer.domElement.width,renderer.domElement.height,alt,tiltPitch,tiltRoll,selection,Boolean(onSelect),drone.children[0]];
    if(!software||spin||!previousFrame||revision.some((value,i)=>value!==previousFrame[i])){
      const drawn=renderer.render(scene,camera);
      if(!software||drawn)previousFrame=revision;
    }
  });
  return {available:true,software,build,view,setFrame,setPicker,setSelection,pose(height,command,pitch=0,roll=0){alt=height;spin=command;tiltPitch=pitch;tiltRoll=roll;}};
}

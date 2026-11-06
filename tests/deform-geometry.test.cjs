const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const assert=require('node:assert/strict'),{test}=require('node:test');
const source=fs.readFileSync(path.join(__dirname,'../app.js'),'utf8'),functions=[...source.matchAll(/^function (\w+)\(/gm)];
function declaration(name){const i=functions.findIndex(f=>f[1]===name);assert(i>=0,name);return source.slice(functions[i].index,functions[i+1]?.index??source.length)}
const names=['finiteNumber','boxShape','isLine','isEllipse','isFillShape','defaultDeformPoints','cornerRadii','normalizedCornerRadii','ensureDeformPoints','deformPointBaseLocal','deformPointCurveLocal','deformRange','smoothKernel','rectDeformAt','ellipseDeformAt','nearestDeformLocation','addDeformPointAt','deleteSelectedDeformPoint','legacyDeformOffset','localDeformKnots','localDeformSegment','localDeformAt','updateLocalDeformTangents','setDeformPointPosition','worldPointToObjectLocal','objectLocalToWorld','cleanDeformPointList','deformSampleParameters','deformContourPoints','pointsBounds','getDeformLocalBounds','getObjectEditRect','getObjectSize','getObjectBounds','getUnrotatedVisualRect','rectsIntersect','pointInsideContour','segmentIntersectsRect','objectIntersectsSelection','deformBaseDerivative','resizeDeformGeometry','applyDeformedResize','resizeDeformedDimensions'];
const context=vm.createContext({console,structuredClone});
vm.runInContext(`const clamp=(v,a,b)=>Math.max(a,Math.min(b,v)),BORDER_SIDE_KEYS=['top','right','bottom','left'];const state={zoom:1};const maxBorderWidth=o=>o.borderWidth||0;let selectedDeformPointId=null,subject=null;const selected=()=>subject,hasMultiBoxes=()=>false,renderObjects=()=>{},commitHistory=()=>{},setDataStatus=()=>{};`+names.map(declaration).join('\n'),context);
const run=code=>vm.runInContext(code,context);
run(`function shape(ellipse=false){return {type:'box',shape:ellipse?'ellipse':'rect',w:480,h:280,x:10,y:20,radius:20,rotation:0,deformEnabled:true,deformSmoothness:58,deformModel:'local-segments-v1',deformPoints:defaultDeformPoints(ellipse?'ellipse':'rect'),nextDeformPointId:5}}`);
const near=(a,b,epsilon=1e-6)=>assert(Math.abs(a-b)<epsilon,`${a} != ${b}`);

test('dragging one anchor preserves all other anchor positions',()=>{
  for(const ellipse of [false,true]){
    const r=run(`(()=>{const o=shape(${ellipse});o.deformPoints.push({id:5,side:${ellipse?"'ellipse'":"'top'"},t:${ellipse?.13:.32},dx:5,dy:-18});const p=o.deformPoints[4],before=o.deformPoints.map(p=>deformPointCurveLocal(o,p));setDeformPointPosition(o,p,{x:before[4].x+27.5,y:before[4].y-60});return{before,after:o.deformPoints.map(p=>deformPointCurveLocal(o,p))}})()`);
    r.before.forEach((p,i)=>{near(r.after[i].x,p.x+(i===4?27.5:0));near(r.after[i].y,p.y-(i===4?60:0))});
  }
});
test('rectangle spans outside the two neighbours are byte-for-byte unchanged',()=>{
  const r=run(`(()=>{const o=shape();o.deformPoints=[.1,.3,.5,.7,.9].map((t,i)=>({id:i+1,side:'top',t,dx:i*2,dy:-15*(i+1),slopeX:3,slopeY:-9}));const sample=()=>Array.from({length:1001},(_,i)=>deformPointCurveLocal(o,{side:'top',t:i/1000}));const before=sample();setDeformPointPosition(o,o.deformPoints[2],{x:220,y:-170});return{before,after:sample()}})()`);
  let changed=0;r.before.forEach((p,i)=>{if(i<=300||i>=700){assert.equal(r.after[i].x,p.x);assert.equal(r.after[i].y,p.y)}else if(r.after[i].y!==p.y)changed++});assert(changed>0);
});
test('ellipse wrap-around spans remain unchanged beyond the two neighbours',()=>{
  const r=run(`(()=>{const o=shape(true);o.deformPoints=Array.from({length:8},(_,i)=>({id:i+1,side:'ellipse',t:i/8,dx:i,dy:-8*i,slopeX:0,slopeY:0}));const sample=()=>Array.from({length:1001},(_,i)=>deformPointCurveLocal(o,{side:'ellipse',t:i/1000}));const before=sample();setDeformPointPosition(o,o.deformPoints[0],{x:270,y:-90});return{before,after:sample()}})()`);
  for(let i=125;i<=875;i++){assert.equal(r.after[i].x,r.before[i].x);assert.equal(r.after[i].y,r.before[i].y)}
});
test('adding on a deformed edge splits its polynomial without changing the contour',()=>{
  for(const ellipse of [false,true]){
    const r=run(`(()=>{const o=shape(${ellipse});o.deformPoints[0].dy=-65;updateLocalDeformTangents(o);const side=${ellipse?"'ellipse'":"'top'"},t=${ellipse?.13:.31},sample=()=>Array.from({length:1001},(_,i)=>deformPointCurveLocal(o,{side,t:i/1000}));const before=sample(),target=deformPointCurveLocal(o,{side,t});addDeformPointAt(o,target);const after=sample(),count=o.deformPoints.length;addDeformPointAt(o,target);return{before,after,count,again:o.deformPoints.length}})()`);
    r.before.forEach((p,i)=>{near(p.x,r.after[i].x);near(p.y,r.after[i].y)});assert.equal(r.count,5);assert.equal(r.again,5);
  }
});
test('deleting a point changes only the merged span and preserves surviving anchors',()=>{
  const r=run(`(()=>{const o=subject=shape();o.deformPoints=[.1,.3,.5,.7,.9].map((t,i)=>({id:i+1,side:'bottom',t,dx:0,dy:-20*i,slopeX:0,slopeY:0}));selectedDeformPointId=3;const sample=()=>Array.from({length:1001},(_,i)=>deformPointCurveLocal(o,{side:'bottom',t:i/1000}));const before=sample(),anchors=o.deformPoints.filter(p=>p.id!==3).map(p=>deformPointCurveLocal(o,p));deleteSelectedDeformPoint();return{before,after:sample(),anchors,next:o.deformPoints.map(p=>deformPointCurveLocal(o,p))}})()`);
  r.before.forEach((p,i)=>{if(i<=300||i>=700){assert.equal(r.after[i].x,p.x);assert.equal(r.after[i].y,p.y)}});r.anchors.forEach((p,i)=>{near(p.x,r.next[i].x);near(p.y,r.next[i].y)});
});
test('the reported thin rectangle migrates without moving anchors or retaining cancellation spikes',()=>{
  context.fixture=JSON.parse(fs.readFileSync(path.join(__dirname,'fixtures/deform-overlap.json'),'utf8'));
  const r=run(`(()=>{const o=structuredClone(fixture),before=o.deformPoints.map(p=>{const b=deformPointBaseLocal(o,p),d=legacyDeformOffset(o,p.side,p.t);return{x:b.x+d.dx,y:b.y+d.dy}});ensureDeformPoints(o);const anchors=o.deformPoints.map(p=>deformPointCurveLocal(o,p)),sample=()=>Array.from({length:2001},(_,i)=>deformPointCurveLocal(o,{side:'bottom',t:i/2000})),initial=sample(),p=o.deformPoints.find(p=>p.id===6),v=deformPointCurveLocal(o,p);setDeformPointPosition(o,p,{x:v.x,y:v.y+20});return{before,anchors,initial,after:sample(),lo:.5,hi:.6375}})()`);
  r.before.forEach((p,i)=>{near(p.x,r.anchors[i].x);near(p.y,r.anchors[i].y)});
  const minY=Math.min(38.057,...r.anchors.filter((_,i)=>[2,4,5].includes(i)).map(p=>p.y)),maxY=Math.max(38.057,...r.anchors.filter((_,i)=>[2,4,5].includes(i)).map(p=>p.y));
  r.initial.forEach(p=>assert(p.y>=minY-1e-5&&p.y<=maxY+1e-5,'unexpected spike'));
  r.initial.forEach((p,i)=>{const t=i/2000;if(t<r.lo||t>r.hi){assert.equal(r.after[i].x,p.x);assert.equal(r.after[i].y,p.y)}});
});
test('fine adjustments retain a tenth of a pixel after rotation',()=>{
  const r=run(`(()=>{const o=shape();o.rotation=37;const p=o.deformPoints[0],before=objectLocalToWorld(o,deformPointCurveLocal(o,p));setDeformPointPosition(o,p,worldPointToObjectLocal(o,{x:before.x+.1,y:before.y}));return{before,after:objectLocalToWorld(o,deformPointCurveLocal(o,p))}})()`);near(r.after.x,r.before.x+.1);near(r.after.y,r.before.y);
});
test('legacy coincident points stay finite and locked shapes reject additions',()=>{
  const r=run(`(()=>{const o=shape();delete o.deformModel;o.deformPoints.push({...o.deformPoints[0],id:5});ensureDeformPoints(o);setDeformPointPosition(o,o.deformPoints[0],{x:240,y:-30});o.locked=true;return{finite:o.deformPoints.every(p=>Number.isFinite(p.dx)&&Number.isFinite(p.dy)),added:addDeformPointAt(o,{x:400,y:0})}})()`);assert(r.finite);assert.equal(r.added,false);
});
test('local positions and split tangents survive save and reload',()=>{
  const r=run(`(()=>{const o=shape(true);o.deformPoints[0].dy=-70;const target=deformPointCurveLocal(o,{side:'ellipse',t:.13});addDeformPointAt(o,target);const sample=()=>Array.from({length:1001},(_,i)=>deformPointCurveLocal(o,{side:'ellipse',t:i/1000})),before=sample(),saved=JSON.parse(JSON.stringify(o));o.deformPoints=cleanDeformPointList(saved.deformPoints,'ellipse',{}).points;o.deformModel=saved.deformModel;return{before,after:sample()}})()`);
  r.before.forEach((p,i)=>{near(p.x,r.after[i].x);near(p.y,r.after[i].y)});
});
test('physical bounds and selection follow a translated ellipse instead of its old rectangle',()=>{
  const r=run(`(()=>{const o=shape(true);o.radius=0;o.borderOn=false;o.deformPoints.forEach(p=>{p.dx=600;p.dy=350});const b=getDeformLocalBounds(o),body=getObjectBounds(o);return{b,body,old:objectIntersectsSelection(o,{x:40,y:40,w:30,h:30}),new:objectIntersectsSelection(o,{x:800,y:420,w:10,h:10}),emptyCorner:objectIntersectsSelection(o,{x:611,y:371,w:5,h:5})}})()`);
  near(r.b.x,600);near(r.b.y,350);near(r.body.x,610);near(r.body.y,370);assert.equal(r.old,false);assert.equal(r.new,true);assert.equal(r.emptyCorner,false);
});
test('scaling a deformed rectangle preserves the full profile relative to its visible bounds',()=>{
  const r=run(`(()=>{const o=shape();o.radius=0;o.deformPoints[2].dy=130;const original=structuredClone(o),b=getDeformLocalBounds(o),sample=()=>Array.from({length:101},(_,i)=>objectLocalToWorld(o,deformPointCurveLocal(o,{side:'bottom',t:i/100}))),before=sample();applyDeformedResize(o,original,b,{...b,w:b.w*1.4,h:b.h*1.8});return{before,after:sample(),origin:objectLocalToWorld(original,{x:b.x,y:b.y}),rect:getObjectEditRect(o),bounds:b}})()`);
  r.before.forEach((p,i)=>{near(r.after[i].x,r.origin.x+(p.x-r.origin.x)*1.4);near(r.after[i].y,r.origin.y+(p.y-r.origin.y)*1.8)});near(r.rect.w,r.bounds.w*1.4);near(r.rect.h,r.bounds.h*1.8);
});
test('rotated resizing keeps the opposite visible corner fixed',()=>{
  const r=run(`(()=>{const o=shape();o.radius=0;o.rotation=37;o.deformPoints[2].dy=90;const original=structuredClone(o),b=getDeformLocalBounds(o),fixed=objectLocalToWorld(o,{x:b.x+b.w,y:b.y+b.h});applyDeformedResize(o,original,b,{x:b.x-80,y:b.y-60,w:b.w+80,h:b.h+60});const next=getDeformLocalBounds(o);return{fixed,after:objectLocalToWorld(o,{x:next.x+next.w,y:next.y+next.h})}})()`);near(r.fixed.x,r.after.x);near(r.fixed.y,r.after.y);
});
test('numeric dimensions resize the visible outline rather than the undeformed model',()=>{
  const r=run(`(()=>{const o=shape();o.radius=0;o.deformPoints[2].dy=140;resizeDeformedDimensions(o,720,210);return{rect:getObjectEditRect(o),modelHeight:o.h}})()`);near(r.rect.w,720);near(r.rect.h,210);near(r.modelHeight,140);
});

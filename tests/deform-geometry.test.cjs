const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const assert=require('node:assert/strict'),{test}=require('node:test');
const filename=fs.existsSync(path.join(__dirname,'../app.js'))?path.join(__dirname,'../app.js'):path.join(__dirname,'app.js');
const source=fs.readFileSync(filename,'utf8');
const functions=[...source.matchAll(/^function (\w+)\(/gm)];
function declaration(name){const i=functions.findIndex(f=>f[1]===name);assert(i>=0,name);return source.slice(functions[i].index,functions[i+1]?.index??source.length)}
const names=['finiteNumber','boxShape','isLine','isEllipse','isFillShape','defaultDeformPoints','cornerRadii','normalizedCornerRadii','ensureDeformPoints','deformPointBaseLocal','deformPointCurveLocal','deformRange','smoothKernel','rectDeformAt','ellipseDeformAt','nearestDeformLocation','addDeformPointAt','deleteSelectedDeformPoint','deformWeight','captureDeformAnchors','applyDeformAnchors','setDeformPointPosition','worldPointToObjectLocal','objectLocalToWorld','cleanDeformPointList'];
const context=vm.createContext({console,structuredClone});
vm.runInContext(`const clamp=(v,a,b)=>Math.max(a,Math.min(b,v)),BORDER_SIDE_KEYS=['top','right','bottom','left'];const state={zoom:1};let selectedDeformPointId=null,subject=null;const selected=()=>subject,hasMultiBoxes=()=>false,renderObjects=()=>{},commitHistory=()=>{},setDataStatus=()=>{};`+names.map(declaration).join('\n'),context);
const run=code=>vm.runInContext(code,context);
run(`function shape(ellipse=false){return {type:'box',shape:ellipse?'ellipse':'rect',w:480,h:280,x:10,y:20,radius:20,rotation:0,deformEnabled:true,deformSmoothness:58,deformPoints:defaultDeformPoints(ellipse?'ellipse':'rect'),nextDeformPointId:5}}`);
const near=(a,b,epsilon=1e-6)=>assert(Math.abs(a-b)<epsilon,`${a} != ${b}`);

test('dragging one anchor preserves its neighbours on rectangles and ellipses',()=>{
  for(const ellipse of [false,true]){
    const r=run(`(()=>{const o=shape(${ellipse});o.deformPoints.push({id:5,side:${ellipse?"'ellipse'":"'top'"},t:${ellipse?.13:.32},dx:5,dy:-18});const p=o.deformPoints.find(p=>p.id===5),before=o.deformPoints.map(p=>deformPointCurveLocal(o,p)),anchors=captureDeformAnchors(o,p);setDeformPointPosition(o,p,{x:before[4].x+27.5,y:before[4].y-60},anchors);return {before,after:o.deformPoints.map(p=>deformPointCurveLocal(o,p))}})()`);
    r.before.forEach((p,i)=>{near(r.after[i].x,p.x+(i===4?27.5:0));near(r.after[i].y,p.y-(i===4?60:0))});
  }
});
test('adding on a deformed edge preserves the whole contour and avoids duplicates',()=>{
  const r=run(`(()=>{const o=shape();o.deformPoints[0].dy=-65;const sample=()=>Array.from({length:101},(_,i)=>deformPointCurveLocal(o,{side:'top',t:i/100}));const before=sample(),target=deformPointCurveLocal(o,{side:'top',t:.31});addDeformPointAt(o,target);const after=sample(),count=o.deformPoints.length;addDeformPointAt(o,target);return{before,after,count,again:o.deformPoints.length,t:o.deformPoints.at(-1).t}})()`);
  r.before.forEach((p,i)=>{near(p.x,r.after[i].x);near(p.y,r.after[i].y)});assert.equal(r.count,5);assert.equal(r.again,5);near(r.t,.31,.0001);
});
test('deleting a displaced point keeps all surviving anchor positions',()=>{
  const r=run(`(()=>{const o=subject=shape(true);o.deformPoints.push({id:5,side:'ellipse',t:.13,dx:20,dy:-50});selectedDeformPointId=5;const before=o.deformPoints.slice(0,4).map(p=>deformPointCurveLocal(o,p));deleteSelectedDeformPoint();return{before,after:o.deformPoints.map(p=>deformPointCurveLocal(o,p))}})()`);
  r.before.forEach((p,i)=>{near(p.x,r.after[i].x);near(p.y,r.after[i].y)});
});
test('fine adjustments retain a tenth of a pixel and rotation round trips',()=>{
  const r=run(`(()=>{const o=shape();o.rotation=37;const p=o.deformPoints[0],before=objectLocalToWorld(o,deformPointCurveLocal(o,p));setDeformPointPosition(o,p,worldPointToObjectLocal(o,{x:before.x+.1,y:before.y}));return{before,after:objectLocalToWorld(o,deformPointCurveLocal(o,p))}})()`);near(r.after.x,r.before.x+.1);near(r.after.y,r.before.y);
});
test('legacy coincident points stay finite and locked shapes reject additions',()=>{
  const r=run(`(()=>{const o=shape();o.deformPoints.push({...o.deformPoints[0],id:5});setDeformPointPosition(o,o.deformPoints[0],{x:240,y:-30});o.locked=true;return{finite:o.deformPoints.every(p=>Number.isFinite(p.dx)&&Number.isFinite(p.dy)),added:addDeformPointAt(o,{x:400,y:0})}})()`);assert(r.finite);assert.equal(r.added,false);
});
test('edits stay within project serialization bounds and survive point data reload',()=>{
  const r=run(`(()=>{const o=shape(true);o.deformPoints.push({id:5,side:'ellipse',t:.012,dx:0,dy:0});setDeformPointPosition(o,o.deformPoints[4],{x:300,y:-200});const before=Array.from({length:128},(_,i)=>deformPointCurveLocal(o,{side:'ellipse',t:i/128}));o.deformPoints=cleanDeformPointList(JSON.parse(JSON.stringify(o.deformPoints)),'ellipse',{}).points;return{before,after:Array.from({length:128},(_,i)=>deformPointCurveLocal(o,{side:'ellipse',t:i/128}))}})()`);
  r.before.forEach((p,i)=>{near(p.x,r.after[i].x);near(p.y,r.after[i].y)});
});

const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict'),{test}=require('node:test');
const source=fs.readFileSync(path.join(__dirname,'../app.js'),'utf8'),functions=[...source.matchAll(/^function (\w+)\(/gm)];
function declaration(name){const i=functions.findIndex(f=>f[1]===name);assert(i>=0,name);return source.slice(functions[i].index,functions[i+1]?.index??source.length)}
const names=['parseColorValue','finiteNumber','normalizeColorValue','cleanColor','cleanStops','cleanBorderSpec','cleanBorders','defaultBorderSpec','defaultBorders','borderGradientStops','syncBorderColorAliases','borderSpecsEqual','ensureBorders','borderStrokeStyle','sampleGradientColor','gradientGapPosition'];
const context=vm.createContext({structuredClone});
const rgbaSource=source.slice(source.indexOf('const rgba='),source.indexOf('\nconst fitCSS='));
vm.runInContext("const clamp=(v,a,b)=>Math.max(a,Math.min(b,v)),BORDER_SIDE_KEYS=['top','right','bottom','left'];"+names.map(declaration).join('\n')+'\n'+rgbaSource,context);
const run=code=>vm.runInContext(code,context);

test('new stops interpolate the existing gradient including premultiplied alpha',()=>{
  assert.equal(run("sampleGradientColor([{c:'#000000',p:0},{c:'#ffffff',p:100}],25)"),'#404040');
  assert.equal(run("sampleGradientColor([{c:'#ff0000',p:0},{c:'rgba(0,0,255,0)',p:100}],50)"),'rgba(255, 0, 0, 0.5)');
});
test('coincident stops retain hard transitions and insertion uses the largest open gap',()=>{
  assert.equal(run("sampleGradientColor([{c:'#000000',p:0},{c:'#ff0000',p:50},{c:'#00ff00',p:50},{c:'#ffffff',p:100}],50)"),'#00ff00');
  assert.equal(run("gradientGapPosition([{c:'#000000',p:0},{c:'#fff',p:20},{c:'#fff',p:100}])"),60);
});
test('legacy two-color borders load without changing colors, positions or direction',()=>{
  const r=run(`(()=>{const o={type:'box',borderWidth:3,borderColor:'#ffffff',borderOpacity:.8,borders:{top:{on:true,width:3,opacity:.8,paint:'linear',color1:'#ff0000',color2:'#0000ff'}}};const b=ensureBorders(o).top;return{colors:b.colors,angle:b.angle,center:b.center,range:b.range}})()`);
  assert.equal(JSON.stringify(r.colors),JSON.stringify([{c:'#ff0000',p:0},{c:'#0000ff',p:100}]));assert.equal(r.angle,0);assert.equal(r.center,50);assert.equal(r.range,100);
});
test('a border palette remains editable after repeated normalization',()=>{
  const r=run(`(()=>{const o={type:'box',borders:defaultBorders()},list=ensureBorders(o).top.colors;ensureBorders(o);list.push({c:'#ff0000',p:50});return ensureBorders(o).top.colors.length})()`);assert.equal(r,3);
});
test('all border stops, parameters and per-stop alpha survive project normalization',()=>{
  const r=run(`(()=>{const b={on:true,width:6,opacity:.5,paint:'radial',color1:'#ffffff',color2:'#000000',colors:[{c:'#ff0000',p:0},{c:'rgba(0,255,0,0.25)',p:27.5},{c:'#0000ff',p:100}],angle:125,center:33,range:180};return cleanBorderSpec(JSON.parse(JSON.stringify(b)),'#fff',2,1)})()`);
  assert.equal(r.colors.length,3);assert.equal(r.colors[1].p,27.5);assert.equal(r.colors[1].c,'rgba(0, 255, 0, 0.25)');assert.equal(r.angle,125);assert.equal(r.center,33);assert.equal(r.range,180);
});
test('border painting sends every stop and multiplies stop alpha by border opacity',()=>{
  const r=run(`(()=>{const calls=[],ctx={createLinearGradient:(...v)=>{calls.push(['linear',v]);return{addColorStop:(...s)=>calls.push(['stop',s])}},createRadialGradient:(...v)=>{calls.push(['radial',v]);return{addColorStop:(...s)=>calls.push(['stop',s])}}};const b=cleanBorderSpec({paint:'linear',opacity:.5,colors:[{c:'#ff0000',p:0},{c:'rgba(0,255,0,.4)',p:40},{c:'#0000ff',p:100}]},'#fff',2,1);borderStrokeStyle(ctx,{x:10,y:20,w:200,h:100},'top',b);return calls})()`);
  assert.equal(r[0][0],'linear');assert.equal(JSON.stringify(r[0][1]),JSON.stringify([10,20,210,20]));assert.equal(r.length,4);assert.equal(r[2][1][0],.4);assert.equal(r[2][1][1],'rgba(0,255,0,0.2)');
});
test('radial center and spread affect the actual border gradient geometry',()=>{
  const r=run(`(()=>{let geometry;const ctx={createRadialGradient:(...v)=>{geometry=v;return{addColorStop:()=>{}}}};const b=cleanBorderSpec({paint:'radial',center:25,range:160},'#fff',2,1);borderStrokeStyle(ctx,{x:10,y:20,w:200,h:100},'top',b);return geometry})()`);assert.equal(JSON.stringify(r),JSON.stringify([60,20,0,60,20,160]));
});
test('linear rotation changes the painted border gradient direction',()=>{
  const r=run(`(()=>{let geometry;const ctx={createLinearGradient:(...v)=>{geometry=v;return{addColorStop:()=>{}}}};const b=cleanBorderSpec({paint:'linear',angle:90},'#fff',2,1);borderStrokeStyle(ctx,{x:10,y:20,w:200,h:100},'top',b);return geometry})()`);[110,-80,110,120].forEach((v,i)=>assert(Math.abs(r[i]-v)<1e-8));
});
test('per-side palettes are independent and middle-stop differences are detected',()=>{
  const r=run(`(()=>{const o={type:'box',borders:defaultBorders()};const b=ensureBorders(o);b.top.paint=b.bottom.paint='linear';b.top.colors=[{c:'#000',p:0},{c:'#f00',p:50},{c:'#fff',p:100}];b.bottom.colors=structuredClone(b.top.colors);ensureBorders(o);const same=borderSpecsEqual(b.top,b.bottom);b.bottom.colors[1].c='#00ff00';return{same,different:!borderSpecsEqual(b.top,b.bottom),top:b.top.colors[1].c}})()`);assert(r.same);assert(r.different);assert.equal(r.top,'#ff0000');
});

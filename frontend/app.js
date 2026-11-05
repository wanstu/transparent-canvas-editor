const $=s=>document.querySelector(s);
const world=$('#world'),viewport=$('#viewport'),guideLayer=$('#guideLayer'),snapOverlay=$('#snapOverlay'),selectionMarquee=$('#selectionMarquee'),topRuler=$('#topRuler'),leftRuler=$('#leftRuler');
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const state={
  objects:[],selectedId:null,selectedBoxIds:[],nextId:1,
  zoom:1,panX:80,panY:70,
  canvasW:1600,canvasH:1000,
  canvasBgOpacity:0,canvasGradientType:'linear',canvasAngle:135,canvasColors:[{c:'#ffffff',p:0},{c:'#dfe7f2',p:100}],
  canvasImageRef:null,canvasImageOpacity:1,canvasImageFit:'cover',
  guides:{vertical:[],horizontal:[]},guidesVisible:true,snapEnabled:true,
  customFonts:[]
};
let boxClipboard=null;
let statusTimer=null;
let alignCloseTimer=null;
let rightbarCloseTimer=null;
let desktopSaveTimer=null;
let desktopCleanupTimer=null;
let desktopWorkspacePath='';
const desktopPersistedImages=new Set();
const historyState={entries:[],currentId:null,redoStack:[],nextId:1,max:100,restoring:false,ready:false};
const assetStore={nextImageId:1,images:new Map(),imageByValue:new Map()};
const imageCache=new Map();
const previewImageCache=new Map();
const previewBuilds=new Map();
const loadedCustomFontFamilies=new Set();
const layerNodeCache=new Map();
const objectNodeCache=new Map();
let worldUpdateRAF=0;
let selectedDeformPointId=null;
let deformAddMode=false;
const measureCtx=document.createElement('canvas').getContext('2d');
const uid=()=>state.nextId++;
function parseColorValue(value){
  if(typeof value!=='string')return null;
  let s=value.trim();if(!s)return null;
  if(/^transparent$/i.test(s))return{r:0,g:0,b:0,a:0,css:'rgba(0, 0, 0, 0)',hex:'#000000'};
  let h=s.replace(/^#/,'').replace(/\s+/g,'');
  if(/^[0-9a-f]{3,4}$/i.test(h)){h=h.split('').map(ch=>ch+ch).join('')}
  if(/^[0-9a-f]{6}([0-9a-f]{2})?$/i.test(h)){
    const r=parseInt(h.slice(0,2),16),g=parseInt(h.slice(2,4),16),b=parseInt(h.slice(4,6),16),a=h.length===8?parseInt(h.slice(6,8),16)/255:1;
    return{r,g,b,a,hex:'#'+h.slice(0,6).toLowerCase(),css:a<.999?`rgba(${r}, ${g}, ${b}, ${Math.round(a*1000)/1000})`:'#'+h.slice(0,6).toLowerCase()}
  }
  const m=s.match(/^rgba?\(\s*([^)]*)\s*\)$/i);
  if(m){
    const parts=m[1].split(',').map(v=>v.trim());if(parts.length<3||parts.length>4)return null;
    const channel=v=>{if(/%$/.test(v))return clamp(Math.round(parseFloat(v)*2.55),0,255);const n=Number(v);return Number.isFinite(n)?clamp(Math.round(n),0,255):NaN};
    const r=channel(parts[0]),g=channel(parts[1]),b=channel(parts[2]);if(![r,g,b].every(Number.isFinite))return null;
    let a=1;if(parts[3]!=null){a=/%$/.test(parts[3])?parseFloat(parts[3])/100:Number(parts[3]);if(!Number.isFinite(a))return null;a=clamp(a,0,1)}
    const hex='#'+[r,g,b].map(n=>n.toString(16).padStart(2,'0')).join('');
    return{r,g,b,a,hex,css:a<.999?`rgba(${r}, ${g}, ${b}, ${Math.round(a*1000)/1000})`:hex}
  }
  return null
}
function normalizeColorValue(value,fallback='#ffffff'){return parseColorValue(value)?.css||parseColorValue(fallback)?.css||'#ffffff'}
function colorToHex(value,fallback='#ffffff'){return parseColorValue(value)?.hex||parseColorValue(fallback)?.hex||'#ffffff'}
function colorAlpha(value){return parseColorValue(value)?.a??1}
const hexToRgb=h=>{const p=parseColorValue(h)||parseColorValue('#ffffff');return[p.r,p.g,p.b]};
const rgba=(color,a=1)=>{const p=parseColorValue(color)||parseColorValue('#ffffff'),alpha=clamp((p.a??1)*a,0,1);return `rgba(${p.r},${p.g},${p.b},${Math.round(alpha*1000)/1000})`};
const fitCSS=fit=>fit==='stretch'?'100% 100%':fit;

function desktopApp(){
  return window.go?.main?.App||null
}
async function persistDesktopImageAsset(ref,dataUrl){
  const api=desktopApp();if(!api?.SaveImageAsset||!ref||!dataUrl||desktopPersistedImages.has(ref))return;
  try{await api.SaveImageAsset(ref,dataUrl);desktopPersistedImages.add(ref)}
  catch(err){console.warn('desktop image persist failed',err)}
}
function desktopWorkspaceSnapshot(){
  const data=projectSnapshot();
  if(data.assets)data.assets.images={};
  return data
}
function scheduleDesktopWorkspaceSave(){
  const api=desktopApp();if(!api?.SaveWorkspace||historyState.restoring)return;
  clearTimeout(desktopSaveTimer);
  desktopSaveTimer=setTimeout(async()=>{
    try{await api.SaveWorkspace(JSON.stringify(desktopWorkspaceSnapshot()))}
    catch(err){console.warn('desktop workspace save failed',err);setDataStatus('桌面自动保存失败','err')}
  },700)
}
function scheduleDesktopAssetCleanup(refs){
  const api=desktopApp();if(!api?.CleanupImageAssets)return;
  const list=[...refs];
  clearTimeout(desktopCleanupTimer);
  desktopCleanupTimer=setTimeout(async()=>{
    try{
      await api.CleanupImageAssets(list);
      const keep=new Set(list);[...desktopPersistedImages].forEach(ref=>{if(!keep.has(ref))desktopPersistedImages.delete(ref)})
    }catch(err){console.warn('desktop asset cleanup failed',err)}
  },1800)
}
function imageRefsFromProjectData(data){
  const refs=new Set(),canvas=data?.canvas;
  if(canvas?.imageRef)refs.add(canvas.imageRef);
  (Array.isArray(data?.objects)?data.objects:[]).forEach(o=>{if(o?.type==='box'&&o.imageRef)refs.add(o.imageRef)});
  return refs
}
async function restoreDesktopWorkspace(){
  const api=desktopApp();if(!api?.LoadWorkspace)return false;
  if(api.WorkspacePath){try{desktopWorkspacePath=await api.WorkspacePath()}catch(err){console.warn('workspace path unavailable',err)}}
  const raw=await api.LoadWorkspace();if(!raw)return false;
  const data=JSON.parse(raw),refs=imageRefsFromProjectData(data);
  if(refs.size&&api.LoadImageAssets){
    const images=await api.LoadImageAssets([...refs]);
    Object.keys(images||{}).forEach(ref=>desktopPersistedImages.add(ref));
    data.assets=data.assets||{};data.assets.images=images||{}
  }
  await loadProjectData(data);
  return true
}

function registerImageAsset(dataUrl,preferredId=null){
  if(!dataUrl)return null;
  const existing=assetStore.imageByValue.get(dataUrl);if(existing)return existing;
  let id=preferredId||('img-'+assetStore.nextImageId++);
  while(assetStore.images.has(id))id='img-'+assetStore.nextImageId++;
  assetStore.images.set(id,dataUrl);assetStore.imageByValue.set(dataUrl,id);
  const n=Number(String(id).replace(/^img-/,''));if(Number.isFinite(n))assetStore.nextImageId=Math.max(assetStore.nextImageId,n+1);
  persistDesktopImageAsset(id,dataUrl);
  return id
}
function imageAssetValue(ref){return ref?assetStore.images.get(ref)||null:null}
function usedImageAssetRefs(objects=state.objects,canvasRef=state.canvasImageRef){
  const refs=new Set();if(canvasRef)refs.add(canvasRef);objects.forEach(o=>{if(o.type==='box'&&o.imageRef)refs.add(o.imageRef)});return refs
}
function exportImageAssets(refs=usedImageAssetRefs()){
  const out={};refs.forEach(ref=>{const value=imageAssetValue(ref);if(value)out[ref]=value});return out
}
function importImageAssets(raw){
  const aliases=new Map();if(!raw||typeof raw!=='object')return aliases;
  Object.entries(raw).forEach(([id,value])=>{if(typeof value==='string'){const canonical=registerImageAsset(value,id);aliases.set(id,canonical)}});
  return aliases
}
async function ensureImagePreview(ref,maxSide=2048){
  if(!ref)return null;if(previewImageCache.has(ref))return previewImageCache.get(ref);if(previewBuilds.has(ref))return previewBuilds.get(ref);
  const task=(async()=>{
    const src=imageAssetValue(ref);if(!src)return null;
    const img=await loadImage(src),max=Math.max(img.naturalWidth||img.width,img.naturalHeight||img.height),scale=Math.min(1,maxSide/Math.max(1,max));
    let blob;
    if(scale<.999){
      const c=document.createElement('canvas');c.width=Math.max(1,Math.round((img.naturalWidth||img.width)*scale));c.height=Math.max(1,Math.round((img.naturalHeight||img.height)*scale));
      c.getContext('2d').drawImage(img,0,0,c.width,c.height);blob=await new Promise(res=>c.toBlob(res,'image/webp',.86));
    }else{
      blob=await (await fetch(src)).blob()
    }
    const url=URL.createObjectURL(blob);previewImageCache.set(ref,url);previewBuilds.delete(ref);return url
  })().catch(err=>{previewBuilds.delete(ref);console.warn('preview build failed',err);return null});
  previewBuilds.set(ref,task);return task
}
function previewImageUrl(ref){
  if(!ref)return null;const cached=previewImageCache.get(ref);if(cached)return cached;
  ensureImagePreview(ref).then(url=>{if(url&&document.body)renderObjects(false)});return null
}
function collectResourceUsage(){
  const imageRefs=new Set(),fontValues=new Set();
  const scanObjects=objects=>(objects||[]).forEach(o=>{if(o.type==='box'&&o.imageRef)imageRefs.add(o.imageRef);if(o.type==='text'&&o.fontFamily)fontValues.add(o.fontFamily)});
  if(state.canvasImageRef)imageRefs.add(state.canvasImageRef);scanObjects(state.objects);
  historyState.entries.forEach(entry=>{const s=entry.snapshot;if(s?.canvas?.imageRef)imageRefs.add(s.canvas.imageRef);scanObjects(s?.objects)});
  scanObjects(boxClipboard?.boxes);
  return{imageRefs,fontValues}
}
function cleanupUnusedResources(){
  const{imageRefs,fontValues}=collectResourceUsage();let imagesRemoved=0,fontsRemoved=0;
  [...assetStore.images.entries()].forEach(([ref,value])=>{if(imageRefs.has(ref))return;assetStore.images.delete(ref);assetStore.imageByValue.delete(value);imageCache.delete(value);const url=previewImageCache.get(ref);if(url)URL.revokeObjectURL(url);previewImageCache.delete(ref);previewBuilds.delete(ref);imagesRemoved++});
  state.customFonts=state.customFonts.filter(f=>{const value=cssFontFamilyValue(f.family);if(fontValues.has(value))return true;try{for(const face of document.fonts){if(face.family===f.family)document.fonts.delete(face)}}catch{}loadedCustomFontFamilies.delete(f.family);const opt=[...$('#fontFamily').options].find(o=>o.value===value);if(opt)opt.remove();fontsRemoved++;return false});
  scheduleDesktopAssetCleanup(imageRefs);
  return{imagesRemoved,fontsRemoved}
}

function defaultBorderSpec(color='#ffffff',width=2,opacity=.9){return{on:true,width,opacity,paint:'solid',color1:color,color2:color}}
function defaultBorders(color='#ffffff',width=2,opacity=.9){return{top:defaultBorderSpec(color,width,opacity),right:defaultBorderSpec(color,width,opacity),bottom:defaultBorderSpec(color,width,opacity),left:defaultBorderSpec(color,width,opacity)}}
function defaultDeformPoints(shape='rect'){
  if(shape==='ellipse')return[
    {id:1,side:'ellipse',t:0,dx:0,dy:0},{id:2,side:'ellipse',t:.25,dx:0,dy:0},{id:3,side:'ellipse',t:.5,dx:0,dy:0},{id:4,side:'ellipse',t:.75,dx:0,dy:0}
  ];
  return[
    {id:1,side:'top',t:.5,dx:0,dy:0},{id:2,side:'right',t:.5,dx:0,dy:0},{id:3,side:'bottom',t:.5,dx:0,dy:0},{id:4,side:'left',t:.5,dx:0,dy:0}
  ]
}
function defaultBox(){return{id:uid(),type:'box',shape:'rect',name:'方框',visible:true,locked:false,rotation:0,lockAspect:false,x:180,y:150,w:420,h:300,radius:28,cornerRadii:{tl:28,tr:28,br:28,bl:28},bgOpacity:.88,gradientType:'linear',angle:135,colors:[{c:'#f7f8fa',p:0},{c:'#d9dde2',p:55},{c:'#bfc5cb',p:100}],imageRef:null,imageOpacity:1,imageFit:'cover',borderOn:true,borderWidth:2,borderColor:'#ffffff',borderOpacity:.9,borders:defaultBorders('#ffffff',2,.9),shadowOn:true,shadowX:0,shadowY:16,shadowBlur:34,shadowSpread:0,shadowColor:'#232e3f',shadowOpacity:.22,innerShadowOn:false,innerShadowX:0,innerShadowY:4,innerShadowBlur:12,innerShadowSpread:0,innerShadowColor:'#000000',innerShadowOpacity:.18,deformEnabled:false,deformSmoothness:58,deform:{top:0,right:0,bottom:0,left:0},deformPoints:defaultDeformPoints('rect'),nextDeformPointId:5}}
function defaultCircle(){return{id:uid(),type:'box',shape:'ellipse',name:'圆形',visible:true,locked:false,rotation:0,lockAspect:true,x:250,y:180,w:240,h:240,radius:120,cornerRadii:{tl:120,tr:120,br:120,bl:120},bgOpacity:.9,gradientType:'radial',angle:135,colors:[{c:'#ffffff',p:0},{c:'#dce8ff',p:100}],imageRef:null,imageOpacity:1,imageFit:'cover',borderOn:true,borderWidth:2,borderColor:'#8fb6ff',borderOpacity:.9,borders:defaultBorders('#8fb6ff',2,.9),shadowOn:false,shadowX:0,shadowY:12,shadowBlur:28,shadowSpread:0,shadowColor:'#315887',shadowOpacity:.22,innerShadowOn:false,innerShadowX:0,innerShadowY:4,innerShadowBlur:12,innerShadowSpread:0,innerShadowColor:'#315887',innerShadowOpacity:.16,deformEnabled:false,deformSmoothness:58,deform:{top:0,right:0,bottom:0,left:0},deformPoints:defaultDeformPoints('ellipse'),nextDeformPointId:5}}
function defaultLine(){return{id:uid(),type:'box',shape:'line',name:'直线',visible:true,locked:false,rotation:0,lockAspect:false,x:280,y:260,w:300,h:20,radius:0,bgOpacity:0,gradientType:'linear',angle:0,colors:[{c:'#2563eb',p:0},{c:'#2563eb',p:100}],imageRef:null,imageOpacity:1,imageFit:'cover',borderOn:false,borderWidth:0,borderColor:'#2563eb',borderOpacity:1,shadowOn:false,shadowX:0,shadowY:6,shadowBlur:12,shadowSpread:0,shadowColor:'#111827',shadowOpacity:.3,innerShadowOn:false,lineColor:'#2563eb',lineWidth:4,lineOpacity:1}}
function defaultText(){return{id:uid(),type:'text',name:'文字',visible:true,locked:false,rotation:0,x:260,y:230,content:'文字',fontSize:48,color:'#111827',opacity:1,fontWeight:'400',fontFamily:'"Microsoft YaHei",sans-serif'}}
function boxShape(o){return o?.type==='box'?(o.shape||'rect'):null}
function objectKindName(o){if(o?.type==='text')return'文字';const s=boxShape(o);return s==='ellipse'?'圆形':s==='line'?'直线':'方框'}
function objectKindIcon(o){if(o?.type==='text')return'T';const s=boxShape(o);return s==='ellipse'?'○':s==='line'?'╱':'□'}
function isLine(o){return boxShape(o)==='line'}
function isEllipse(o){return boxShape(o)==='ellipse'}
function isFillShape(o){return o?.type==='box'&&!isLine(o)}
function outerShadowCSS(o){
  if(!o?.shadowOn)return'none';
  return `${finiteNumber(o.shadowX,0)}px ${finiteNumber(o.shadowY,0)}px ${Math.max(0,finiteNumber(o.shadowBlur,0))}px ${finiteNumber(o.shadowSpread,0)}px ${rgba(o.shadowColor||'#000000',clamp(finiteNumber(o.shadowOpacity,.25),0,1))}`
}
function innerShadowCSS(o){
  if(!o?.innerShadowOn||isLine(o))return'none';
  return `inset ${finiteNumber(o.innerShadowX,0)}px ${finiteNumber(o.innerShadowY,0)}px ${Math.max(0,finiteNumber(o.innerShadowBlur,0))}px ${finiteNumber(o.innerShadowSpread,0)}px ${rgba(o.innerShadowColor||'#000000',clamp(finiteNumber(o.innerShadowOpacity,.18),0,1))}`
}
function shadowCSS(o){const parts=[];const outer=outerShadowCSS(o),inner=innerShadowCSS(o);if(outer!=='none')parts.push(outer);if(inner!=='none')parts.push(inner);return parts.join(', ')||'none'}
function selected(){return state.objects.find(o=>o.id===state.selectedId)||null}
function selectedObjects(){const ids=new Set(state.selectedBoxIds);return state.objects.filter(o=>ids.has(o.id))}
function editableSelectedObjects(){return selectedObjects().filter(o=>!o.locked)}
function selectedBoxes(){return selectedObjects().filter(o=>o.type==='box')}
function editableSelectedBoxes(){return editableSelectedObjects().filter(o=>o.type==='box')}
function hasMultiBoxes(){return selectedObjects().length>1}
function gradientCSS(colors,angle,type='linear'){const ss=[...colors].sort((a,b)=>a.p-b.p);if(ss.length===1)return ss[0].c;const stops=ss.map(s=>`${s.c} ${s.p}%`).join(',');return type==='radial'?`radial-gradient(circle at center,${stops})`:`linear-gradient(${angle}deg,${stops})`}
function clearSelection(){state.selectedId=null;state.selectedBoxIds=[];selectedDeformPointId=null;deformAddMode=false;$('#addDeformPoint')?.classList.remove('active')}
function selectObject(o,additive=false){
  if(state.selectedId!==o.id){selectedDeformPointId=null;deformAddMode=false;$('#addDeformPoint')?.classList.remove('active')}
  if(additive){
    const i=state.selectedBoxIds.indexOf(o.id);
    if(i>=0){state.selectedBoxIds.splice(i,1);if(state.selectedId===o.id)state.selectedId=state.selectedBoxIds.at(-1)||null}
    else{state.selectedBoxIds.push(o.id);state.selectedId=o.id}
  }else{state.selectedBoxIds=[o.id];state.selectedId=o.id}
  setSettingsPane('object')
}
function syncSelectionValidity(){
  const valid=new Set(state.objects.map(o=>o.id));
  state.selectedBoxIds=state.selectedBoxIds.filter(id=>valid.has(id));
  if(state.selectedId!=null&&!state.objects.some(o=>o.id===state.selectedId))state.selectedId=state.selectedBoxIds.at(-1)||null;
}

function escapeHtml(v){return String(v??'').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]))}
function beginInlineLayerRename(row,o){
  if(o.locked){setDataStatus('锁定对象不能重命名','err');return}
  const nameEl=row.querySelector('.layer-name');if(!nameEl||row.querySelector('.layer-name-input'))return;
  row.draggable=false;const input=document.createElement('input');input.className='layer-name-input';input.type='text';input.value=o.name||'';input.maxLength=200;nameEl.replaceWith(input);input.focus();input.select();
  let done=false;const finish=save=>{if(done)return;done=true;const old=o.name||'';if(save)o.name=input.value;row.draggable=!o.locked;const span=document.createElement('span');span.className='layer-name';span.title='双击重命名';span.textContent=o.name||(objectKindName(o)+' '+o.id);input.replaceWith(span);renderLayers();if(save&&o.name!==old){$('#layerName').value=o.name;commitHistory('重命名图层')}};
  input.addEventListener('keydown',e=>{e.stopPropagation();if(e.key==='Enter'){e.preventDefault();finish(true)}else if(e.key==='Escape'){e.preventDefault();finish(false)}});
  input.addEventListener('blur',()=>finish(true))
}
function handleHTML(){return'<i class="handle nw" data-dir="nw"></i><i class="handle n" data-dir="n"></i><i class="handle ne" data-dir="ne"></i><i class="handle e" data-dir="e"></i><i class="handle se" data-dir="se"></i><i class="handle s" data-dir="s"></i><i class="handle sw" data-dir="sw"></i><i class="handle w" data-dir="w"></i><i class="rotate-handle" data-dir="rotate" title="拖动旋转；Shift 按 15° 吸附"></i>'}
function lineHandleHTML(){return'<i class="handle e" data-dir="e"></i><i class="handle w" data-dir="w"></i><i class="rotate-handle" data-dir="rotate" title="拖动旋转；Shift 按 15° 吸附"></i>'}
const BORDER_SIDE_KEYS=['top','right','bottom','left'];
function cornerRadii(o){
  const legacy=Math.max(0,finiteNumber(o?.radius,0)),r=o?.cornerRadii||{};
  return{tl:Math.max(0,finiteNumber(r.tl,legacy)),tr:Math.max(0,finiteNumber(r.tr,legacy)),br:Math.max(0,finiteNumber(r.br,legacy)),bl:Math.max(0,finiteNumber(r.bl,legacy))}
}
function normalizedCornerRadii(o,inset=0){
  const r=cornerRadii(o),w=Math.max(.01,o.w-inset*2),h=Math.max(.01,o.h-inset*2),limit=Math.min(w,h)/2;
  return{tl:clamp(r.tl-inset,0,limit),tr:clamp(r.tr-inset,0,limit),br:clamp(r.br-inset,0,limit),bl:clamp(r.bl-inset,0,limit)}
}
function ensureBorders(o){
  if(!o||o.type!=='box')return null;
  if(!o.borders){
    const c=o.borderColor||'#ffffff',w=Math.max(0,finiteNumber(o.borderWidth,2)),a=clamp(finiteNumber(o.borderOpacity,.9),0,1);
    o.borders=defaultBorders(c,w,a)
  }
  for(const side of BORDER_SIDE_KEYS){
    const b=o.borders[side]||(o.borders[side]=defaultBorderSpec(o.borderColor||'#ffffff',o.borderWidth||2,o.borderOpacity??.9));
    b.on=b.on!==false;b.width=Math.max(0,finiteNumber(b.width,o.borderWidth||2));b.opacity=clamp(finiteNumber(b.opacity,o.borderOpacity??.9),0,1);
    b.paint=['solid','linear','radial'].includes(b.paint)?b.paint:'solid';b.color1=normalizeColorValue(b.color1||o.borderColor||'#ffffff');b.color2=normalizeColorValue(b.color2||b.color1)
  }
  return o.borders
}
function activeBorderSpec(o){const borders=ensureBorders(o);return borders?.[$('#borderSide')?.value||'top']||null}
function syncLegacyBorderFromTop(o){const b=ensureBorders(o)?.top;if(!b)return;o.borderWidth=b.width;o.borderColor=b.color1;o.borderOpacity=b.opacity}
function refreshBorderControls(o){
  if(!isFillShape(o))return;const b=activeBorderSpec(o);if(!b)return;
  $('#borderOn').checked=o.borderOn!==false;$('#borderSideOn').checked=b.on!==false;$('#borderWidth').value=b.width;$('#borderPaint').value=b.paint;$('#borderOpacity').value=Math.round(b.opacity*100);$('#borderOpacityVal').textContent=Math.round(b.opacity*100)+'%';
  $('#borderColor2Row').style.display=b.paint==='solid'?'none':'';staticColorEditors.borderColor.set(b.color1);staticColorEditors.borderColor2.set(b.color2)
}
function maxBorderWidth(o){const b=ensureBorders(o);return b?Math.max(...BORDER_SIDE_KEYS.map(k=>b[k].on?b[k].width:0)):0}
function bordersNeedCanvas(o){const b=ensureBorders(o);return !!b&&o.borderOn!==false&&BORDER_SIDE_KEYS.some(k=>b[k].on&&b[k].paint!=='solid')}
function borderRadiusCSS(o){const r=normalizedCornerRadii(o);return `${r.tl}px ${r.tr}px ${r.br}px ${r.bl}px`}
function applySolidBordersCSS(el,o){
  if(!o.borderOn||bordersNeedCanvas(o)){el.style.border='none';return}
  const b=ensureBorders(o);el.style.borderStyle='solid';
  el.style.borderTopWidth=(b.top.on?b.top.width:0)+'px';el.style.borderRightWidth=(b.right.on?b.right.width:0)+'px';el.style.borderBottomWidth=(b.bottom.on?b.bottom.width:0)+'px';el.style.borderLeftWidth=(b.left.on?b.left.width:0)+'px';
  el.style.borderTopColor=rgba(b.top.color1,b.top.opacity);el.style.borderRightColor=rgba(b.right.color1,b.right.opacity);el.style.borderBottomColor=rgba(b.bottom.color1,b.bottom.opacity);el.style.borderLeftColor=rgba(b.left.color1,b.left.opacity)
}
function ensureDeformPoints(o){
  if(!isFillShape(o))return[];
  if(!Array.isArray(o.deformPoints)){
    const legacy=o.deform||{top:0,right:0,bottom:0,left:0};
    o.deformPoints=defaultDeformPoints(isEllipse(o)?'ellipse':'rect');
    if(isEllipse(o)){
      const vals=[finiteNumber(legacy.top,0),finiteNumber(legacy.right,0),finiteNumber(legacy.bottom,0),finiteNumber(legacy.left,0)];
      const vec=[[0,-1],[1,0],[0,1],[-1,0]];o.deformPoints.forEach((p,i)=>{p.dx=vec[i][0]*vals[i];p.dy=vec[i][1]*vals[i]})
    }else{
      const map={top:[0,-finiteNumber(legacy.top,0)],right:[finiteNumber(legacy.right,0),0],bottom:[0,finiteNumber(legacy.bottom,0)],left:[-finiteNumber(legacy.left,0),0]};
      o.deformPoints.forEach(p=>{[p.dx,p.dy]=map[p.side]})
    }
  }
  let max=0;o.deformPoints.forEach(p=>{p.id=Math.max(1,Math.floor(finiteNumber(p.id,++max)));max=Math.max(max,p.id);p.t=isEllipse(o)?((finiteNumber(p.t,0)%1)+1)%1:clamp(finiteNumber(p.t,.5),0,1);p.dx=finiteNumber(p.dx,0);p.dy=finiteNumber(p.dy,0)});
  o.nextDeformPointId=Math.max(max+1,Math.floor(finiteNumber(o.nextDeformPointId,max+1)));return o.deformPoints
}
function deformPointBaseLocal(o,p){
  if(isEllipse(o)||p.side==='ellipse'){const a=-Math.PI/2+p.t*Math.PI*2;return{x:o.w/2+Math.cos(a)*o.w/2,y:o.h/2+Math.sin(a)*o.h/2}}
  const r=normalizedCornerRadii(o,0);
  if(p.side==='top')return{x:r.tl+p.t*Math.max(0,o.w-r.tl-r.tr),y:0};
  if(p.side==='right')return{x:o.w,y:r.tr+p.t*Math.max(0,o.h-r.tr-r.br)};
  if(p.side==='bottom')return{x:o.w-r.br-p.t*Math.max(0,o.w-r.br-r.bl),y:o.h};
  return{x:0,y:o.h-r.bl-p.t*Math.max(0,o.h-r.bl-r.tl)}
}
function deformPointCurveLocal(o,p){
  const b=deformPointBaseLocal(o,p),d=isEllipse(o)?ellipseDeformAt(o,p.t):rectDeformAt(o,p.side,p.t);return{x:b.x+d.dx,y:b.y+d.dy}
}
function deformHandleHTML(o){return ensureDeformPoints(o).map(p=>`<i class="deform-handle${p.id===selectedDeformPointId?' selected-point':''}" data-deform-point="${p.id}" title="拖动形变点；Delete 删除"></i>`).join('')}
function syncDeformHandles(el,o){
  if(!o?.deformEnabled||!isFillShape(o))return;
  ensureDeformPoints(o).forEach(p=>{const h=el.querySelector(`[data-deform-point="${p.id}"]`);if(!h)return;const a=deformPointCurveLocal(o,p);h.style.left=a.x+'px';h.style.top=a.y+'px';h.classList.toggle('selected-point',p.id===selectedDeformPointId)})
}
function deformExtents(o){
  if(!o?.deformEnabled||!isFillShape(o))return{left:0,right:0,top:0,bottom:0};
  let minX=0,minY=0,maxX=o.w,maxY=o.h;
  if(isEllipse(o)){
    for(let i=0;i<128;i++){const tt=i/128,a=-Math.PI/2+tt*Math.PI*2,d=ellipseDeformAt(o,tt),x=o.w/2+Math.cos(a)*o.w/2+d.dx,y=o.h/2+Math.sin(a)*o.h/2+d.dy;minX=Math.min(minX,x);minY=Math.min(minY,y);maxX=Math.max(maxX,x);maxY=Math.max(maxY,y)}
  }else{
    for(const side of BORDER_SIDE_KEYS)for(let i=0;i<=40;i++){const tt=i/40,base=deformPointBaseLocal(o,{side,t:tt,dx:0,dy:0}),d=rectDeformAt(o,side,tt),x=base.x+d.dx,y=base.y+d.dy;minX=Math.min(minX,x);minY=Math.min(minY,y);maxX=Math.max(maxX,x);maxY=Math.max(maxY,y)}
  }
  return{left:Math.max(0,-minX),right:Math.max(0,maxX-o.w),top:Math.max(0,-minY),bottom:Math.max(0,maxY-o.h)}
}
function nearestDeformLocation(o,local){
  const candidates=[];
  if(isEllipse(o)){
    for(let i=0;i<160;i++){const t=i/160,a=-Math.PI/2+t*Math.PI*2,d=ellipseDeformAt(o,t),x=o.w/2+Math.cos(a)*o.w/2+d.dx,y=o.h/2+Math.sin(a)*o.h/2+d.dy;candidates.push({side:'ellipse',t,distance:Math.hypot(local.x-x,local.y-y)})}
  }else{
    for(const side of BORDER_SIDE_KEYS)for(let i=0;i<=80;i++){const t=i/80,b=deformPointBaseLocal(o,{side,t,dx:0,dy:0}),d=rectDeformAt(o,side,t),x=b.x+d.dx,y=b.y+d.dy;candidates.push({side,t,distance:Math.hypot(local.x-x,local.y-y)})}
  }
  return candidates.sort((a,b)=>a.distance-b.distance)[0]||null
}
function addDeformPointAt(o,local,allowFar=false){
  if(!isFillShape(o)||!o.deformEnabled)return false;const loc=nearestDeformLocation(o,local),threshold=34/Math.max(.1,state.zoom);if(!loc||(!allowFar&&loc.distance>threshold))return false;
  if(!isEllipse(o))loc.t=clamp(loc.t,.03,.97);
  const points=ensureDeformPoints(o),id=o.nextDeformPointId++;points.push({id,side:loc.side,t:loc.t,dx:0,dy:0});selectedDeformPointId=id;return true
}
function deleteSelectedDeformPoint(){
  const o=selected();if(!isFillShape(o)||!o.deformEnabled||selectedDeformPointId==null)return false;const points=ensureDeformPoints(o),i=points.findIndex(p=>p.id===selectedDeformPointId);if(i<0)return false;
  points.splice(i,1);selectedDeformPointId=points.at(-1)?.id??null;renderObjects();commitHistory('删除形变点');return true
}
function deformPreviewPad(o){
  const outer=o.shadowOn?Math.max(0,finiteNumber(o.shadowBlur,0)*2+finiteNumber(o.shadowSpread,0))+Math.hypot(finiteNumber(o.shadowX,0),finiteNumber(o.shadowY,0)):0,d=deformExtents(o),bulge=Math.max(d.left,d.right,d.top,d.bottom);
  return Math.ceil(clamp(Math.max(8,outer+maxBorderWidth(o)+4,bulge+8),8,500))
}
async function renderDeformCanvas(el,o){
  let canvas=el.querySelector('.deform-canvas');if(!canvas){canvas=document.createElement('canvas');canvas.className='deform-canvas';el.prepend(canvas)}
  const token=(Number(canvas.dataset.renderToken)||0)+1;canvas.dataset.renderToken=String(token);
  const pad=deformPreviewPad(o),cssW=Math.ceil(o.w+pad*2),cssH=Math.ceil(o.h+pad*2),dpr=clamp(Math.min(window.devicePixelRatio||1,4096/Math.max(cssW,cssH)),.5,2),tmp=canvas._renderBuffer||(canvas._renderBuffer=document.createElement('canvas'));
  tmp.width=Math.max(1,Math.ceil(cssW*dpr));tmp.height=Math.max(1,Math.ceil(cssH*dpr));
  const ctx=tmp.getContext('2d');ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,cssW,cssH);
  const local={...o,x:pad,y:pad,rotation:0};await drawBox(ctx,local);
  if(Number(canvas.dataset.renderToken)!==token)return;
  canvas.width=tmp.width;canvas.height=tmp.height;canvas.style.width=cssW+'px';canvas.style.height=cssH+'px';canvas.style.left=(-pad)+'px';canvas.style.top=(-pad)+'px';
  const out=canvas.getContext('2d');out.clearRect(0,0,canvas.width,canvas.height);out.drawImage(tmp,0,0)
}
function updateWorldDom(){
  const cimg=world.querySelector('.canvas-image-layer'),cbg=world.querySelector('.canvas-bg-layer');
  if(cimg){const p=previewImageUrl(state.canvasImageRef);cimg.style.backgroundImage=p?`url("${p}")`:'none';cimg.style.backgroundSize=fitCSS(state.canvasImageFit);cimg.style.opacity=state.canvasImageOpacity}
  if(cbg){cbg.style.background=gradientCSS(state.canvasColors,state.canvasAngle,state.canvasGradientType);cbg.style.opacity=state.canvasBgOpacity}
  state.objects.forEach((o,i)=>{
    const el=objectNodeCache.get(o.id);if(!el)return;
    el.style.left=o.x+'px';el.style.top=o.y+'px';el.style.zIndex=i+3;el.style.transform=`rotate(${o.rotation||0}deg)`;el.style.transformOrigin='50% 50%';
    if(o.type==='box'){
      el.style.width=o.w+'px';el.style.height=o.h+'px';
      if(isLine(o)){
        el.style.border='none';el.style.boxShadow='none';el.style.borderRadius='0';
        const stroke=el.querySelector('.line-stroke');if(stroke){stroke.style.height=Math.max(1,o.lineWidth)+'px';stroke.style.background=rgba(o.lineColor,o.lineOpacity);stroke.style.opacity=1;stroke.style.boxShadow=shadowCSS(o)}
      }else if(o.deformEnabled||bordersNeedCanvas(o)){
        el.classList.toggle('deform-active',!!o.deformEnabled);el.style.borderRadius='0';el.style.border='none';el.style.boxShadow='none';if(o.deformEnabled)syncDeformHandles(el,o);renderDeformCanvas(el,o)
      }else{
        el.classList.remove('deform-active');el.style.borderRadius=isEllipse(o)?'50%':borderRadiusCSS(o);
        applySolidBordersCSS(el,o);el.style.boxShadow=outerShadowCSS(o);
        const img=el.querySelector('.box-image'),fill=el.querySelector('.box-fill'),inner=el.querySelector('.inner-shadow-layer'),p=previewImageUrl(o.imageRef);
        if(img){img.style.backgroundImage=p?`url("${p}")`:'none';img.style.backgroundSize=fitCSS(o.imageFit);img.style.opacity=o.imageOpacity}
        if(fill){fill.style.background=gradientCSS(o.colors,o.angle,o.gradientType);fill.style.opacity=o.bgOpacity}
        if(inner)inner.style.boxShadow=innerShadowCSS(o)
      }
    }else{
      const content=el.querySelector('.text-content');if(content&&content.textContent!==o.content)content.textContent=o.content;el.style.fontSize=o.fontSize+'px';el.style.color=o.color;el.style.opacity=o.opacity;el.style.fontWeight=o.fontWeight;el.style.fontFamily=o.fontFamily
    }
  })
}
function renderObjects(syncUI=true){
  if(!syncUI&&world.querySelector('.canvas-bg-layer')){
    if(!worldUpdateRAF)worldUpdateRAF=requestAnimationFrame(()=>{worldUpdateRAF=0;updateWorldDom()});
    return
  }
  if(worldUpdateRAF){cancelAnimationFrame(worldUpdateRAF);worldUpdateRAF=0}
  objectNodeCache.clear();world.innerHTML='';
  const cimg=document.createElement('div');cimg.className='canvas-image-layer';
  const canvasPreview=previewImageUrl(state.canvasImageRef);if(canvasPreview){cimg.style.backgroundImage=`url("${canvasPreview}")`;cimg.style.backgroundSize=fitCSS(state.canvasImageFit);cimg.style.opacity=state.canvasImageOpacity}
  world.appendChild(cimg);
  const cbg=document.createElement('div');cbg.className='canvas-bg-layer';cbg.style.background=gradientCSS(state.canvasColors,state.canvasAngle,state.canvasGradientType);cbg.style.opacity=state.canvasBgOpacity;world.appendChild(cbg);

  const boxIds=new Set(state.selectedBoxIds),singleBox=state.selectedBoxIds.length===1;
  state.objects.forEach((o,i)=>{
    if(o.visible===false)return;
    const el=document.createElement('div');
    const primary=o.id===state.selectedId,multi=boxIds.has(o.id),shapeClass=o.type==='box'?(isLine(o)?' line-object':isEllipse(o)?' ellipse-object':' box-object'):' text-object';
    el.className='object'+shapeClass+(o.deformEnabled&&isFillShape(o)?' deform-active':'')+(o.locked?' locked':'')+(primary?' selected':'')+(multi?' multi-selected':'')+(primary&&singleBox&&!o.locked?' single-selection':'');
    el.dataset.id=o.id;el.style.left=o.x+'px';el.style.top=o.y+'px';el.style.zIndex=i+3;el.style.transform=`rotate(${o.rotation||0}deg)`;el.style.transformOrigin='50% 50%';
    if(o.type==='box'){
      el.style.width=o.w+'px';el.style.height=o.h+'px';
      if(isLine(o)){
        const stroke=document.createElement('div');stroke.className='line-stroke';stroke.style.height=Math.max(1,o.lineWidth)+'px';stroke.style.background=rgba(o.lineColor,o.lineOpacity);stroke.style.opacity=1;stroke.style.boxShadow=shadowCSS(o);el.appendChild(stroke);
        el.insertAdjacentHTML('beforeend',lineHandleHTML())
      }else if(o.deformEnabled||bordersNeedCanvas(o)){
        el.style.border='none';el.style.boxShadow='none';el.style.borderRadius='0';
        const canvas=document.createElement('canvas');canvas.className='deform-canvas';el.appendChild(canvas);
        el.insertAdjacentHTML('beforeend',handleHTML()+(o.deformEnabled?deformHandleHTML(o):''));if(o.deformEnabled)syncDeformHandles(el,o);renderDeformCanvas(el,o)
      }else{
        el.style.borderRadius=isEllipse(o)?'50%':borderRadiusCSS(o);
        applySolidBordersCSS(el,o);
        el.style.boxShadow=outerShadowCSS(o);
        const img=document.createElement('div');img.className='box-image';
        const preview=previewImageUrl(o.imageRef);if(preview){img.style.backgroundImage=`url("${preview}")`;img.style.backgroundSize=fitCSS(o.imageFit);img.style.opacity=o.imageOpacity}
        el.appendChild(img);
        const fill=document.createElement('div');fill.className='box-fill';fill.style.background=gradientCSS(o.colors,o.angle,o.gradientType);fill.style.opacity=o.bgOpacity;el.appendChild(fill);
        const inner=document.createElement('div');inner.className='inner-shadow-layer';inner.style.boxShadow=innerShadowCSS(o);el.appendChild(inner);
        el.insertAdjacentHTML('beforeend',handleHTML())
      }
    }else{
      const content=document.createElement('span');content.className='text-content';content.textContent=o.content;el.appendChild(content);el.style.fontSize=o.fontSize+'px';el.style.color=o.color;el.style.opacity=o.opacity;el.style.fontWeight=o.fontWeight;el.style.fontFamily=o.fontFamily;
      el.insertAdjacentHTML('beforeend','<i class="rotate-handle" data-dir="rotate" title="拖动旋转；Shift 按 15° 吸附"></i>')
    }
    bindObjectEvents(el,o);objectNodeCache.set(o.id,el);world.appendChild(el)
  });
  if(syncUI){renderLayers();refreshPanels();refreshAlignPanel();refreshRightbar();updateSmartHint()}
}
function createLayerNode(id){
  const d=document.createElement('div');d.className='layer';d.dataset.id=id;
  d.innerHTML='<button class="layer-control" data-layer-action="visibility"></button><button class="layer-control" data-layer-action="lock"></button><span class="layer-icon"></span><span class="layer-name" title="双击重命名"></span><span class="layer-z"></span>';
  d.addEventListener('click',e=>{
    const o=state.objects.find(x=>x.id===Number(d.dataset.id));if(!o)return;const action=e.target.closest('[data-layer-action]')?.dataset.layerAction;
    if(action){e.stopPropagation();const kind=objectKindName(o);if(action==='visibility'){o.visible=o.visible===false;renderObjects();commitHistory((o.visible?'显示':'隐藏')+kind)}else{o.locked=!o.locked;renderObjects();commitHistory((o.locked?'锁定':'解锁')+kind)}return}
    selectObject(o,e.shiftKey);renderObjects()
  });
  d.addEventListener('dblclick',e=>{const name=e.target.closest('.layer-name');if(!name)return;const o=state.objects.find(x=>x.id===Number(d.dataset.id));if(o){e.preventDefault();e.stopPropagation();beginInlineLayerRename(d,o)}});
  d.addEventListener('dragstart',e=>{if(e.target.closest('.layer-name-input')){e.preventDefault();return}d.classList.add('dragging');e.dataTransfer.effectAllowed='move';e.dataTransfer.setData('text/plain',d.dataset.id)});
  d.addEventListener('dragend',()=>{d.classList.remove('dragging');$('#layers').querySelectorAll('.drop-target').forEach(x=>x.classList.remove('drop-target'))});
  d.addEventListener('dragover',e=>{e.preventDefault();d.classList.add('drop-target');e.dataTransfer.dropEffect='move'});
  d.addEventListener('dragleave',()=>d.classList.remove('drop-target'));
  d.addEventListener('drop',e=>{e.preventDefault();d.classList.remove('drop-target');const draggedId=Number(e.dataTransfer.getData('text/plain')),targetId=Number(d.dataset.id);if(!Number.isFinite(draggedId)||draggedId===targetId)return;const from=state.objects.findIndex(x=>x.id===draggedId),to=state.objects.findIndex(x=>x.id===targetId);if(from<0||to<0)return;const[moved]=state.objects.splice(from,1);state.objects.splice(to,0,moved);renderObjects();commitHistory('调整图层顺序')});
  d.addEventListener('contextmenu',e=>{const o=state.objects.find(x=>x.id===Number(d.dataset.id));if(!o)return;e.preventDefault();e.stopPropagation();if(!state.selectedBoxIds.includes(o.id)&&state.selectedId!==o.id)selectObject(o,false);renderObjects();showContextMenu(e.clientX,e.clientY,o)});
  return d
}
function renderLayers(){
  const wrap=$('#layers');$('#layerCount').textContent=state.objects.length+' 个';
  if(!state.objects.length){wrap.innerHTML='<div class="empty-state">还没有图层</div>';layerNodeCache.clear();return}
  wrap.querySelector('.empty-state')?.remove();const selectedSet=new Set(state.selectedBoxIds),valid=new Set(state.objects.map(o=>o.id)),frag=document.createDocumentFragment();
  for(const[id,node]of layerNodeCache)if(!valid.has(id)){node.remove();layerNodeCache.delete(id)}
  for(let i=state.objects.length-1;i>=0;i--){
    const o=state.objects[i];let d=layerNodeCache.get(o.id);if(!d){d=createLayerNode(o.id);layerNodeCache.set(o.id,d)}
    d.className='layer'+(o.id===state.selectedId?' active':'')+(selectedSet.has(o.id)?' multi':'');d.draggable=!o.locked;
    const vis=d.querySelector('[data-layer-action="visibility"]'),lock=d.querySelector('[data-layer-action="lock"]');
    vis.className='layer-control '+(o.visible===false?'':'on');vis.title=o.visible===false?'显示':'隐藏';vis.textContent=o.visible===false?'◌':'◉';
    lock.className='layer-control '+(o.locked?'locked':'');lock.title=o.locked?'解锁':'锁定';lock.textContent=o.locked?'🔒':'🔓';
    d.querySelector('.layer-icon').textContent=objectKindIcon(o);
    const name=d.querySelector('.layer-name');if(name)name.textContent=o.name||(objectKindName(o)+' '+o.id);
    d.querySelector('.layer-z').textContent=i+1;frag.appendChild(d)
  }
  wrap.appendChild(frag)
}

function refreshAlignPanel(){
  const total=selectedObjects().length,n=editableSelectedObjects().length;$('#selectionCount').textContent=total+' 个对象';$('#alignMenuButton').disabled=n<2;
  ['alignLeft','alignCenterX','alignRight','alignTop','alignCenterY','alignBottom'].forEach(id=>$('#'+id).disabled=n<2);
  ['distributeH','distributeV'].forEach(id=>$('#'+id).disabled=n<3);
  if(n<2)$('#alignPanel').classList.remove('open')
}
function setSettingsPane(which){
  const object=which==='object';
  $('#objectTab').classList.toggle('active',object);$('#canvasTab').classList.toggle('active',!object);
  $('#objectSettingsPane').classList.toggle('active',object);$('#objectSettingsPane').hidden=!object;
  $('#canvasSettingsPane').classList.toggle('active',!object);$('#canvasSettingsPane').hidden=object
}
$('#objectTab').onclick=()=>setSettingsPane('object');
$('#canvasTab').onclick=()=>setSettingsPane('canvas');
function refreshRightbar(){
  const n=selectedObjects().length;
  $('#snapEnabled').classList.toggle('active',state.snapEnabled);
  $('#guidesToggle').classList.toggle('active',state.guidesVisible);
  $('#copySelected').disabled=n<1;
  $('#exportSelectedData').disabled=n<1;
  $('#pasteSelected').disabled=!boxClipboard;
  const current=historyState.entries.find(e=>e.id===historyState.currentId);
  $('#undoBtn').disabled=!current||current.parentId==null||!historyState.entries.some(e=>e.id===current.parentId);
  $('#redoBtn').disabled=!historyState.redoStack.some(id=>historyState.entries.some(e=>e.id===id));
}
document.querySelectorAll('.tool-group>.group-trigger').forEach(trigger=>{
  trigger.addEventListener('click',e=>{
    e.stopPropagation();
    const group=trigger.closest('.tool-group'),wasOpen=group.classList.contains('open');
    document.querySelectorAll('.tool-group.open').forEach(g=>g.classList.remove('open'));
    if(!wasOpen)group.classList.add('open')
  })
});
$('#historyToggle').onclick=e=>{e.stopPropagation();const shell=$('#rightbarShell');shell.classList.toggle('history-open');$('.history-group').classList.add('open')};
const shortcutPanel=$('#shortcutPanel');
shortcutPanel.innerHTML='<div class="shortcut-head"><strong>完整快捷键 / 操作</strong><button id="shortcutClose">×</button></div><div class="shortcut-list"><div><span>撤回</span><span><kbd>Ctrl</kbd>+<kbd>Z</kbd></span></div><div><span>反撤回</span><span><kbd>Ctrl</kbd>+<kbd>Y</kbd> / <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Z</kbd></span></div><div><span>全选可见对象</span><span><kbd>Ctrl</kbd>+<kbd>A</kbd></span></div><div><span>清除选择</span><kbd>Esc</kbd></div><div><span>追加 / 取消多选</span><span><kbd>Shift</kbd>+点击</span></div><div><span>框选多个对象</span><span>空白处左键拖动</span></div><div><span>复制 / 粘贴</span><span><kbd>Ctrl</kbd>+<kbd>C</kbd> / <kbd>V</kbd></span></div><div><span>复制一份</span><span><kbd>Ctrl</kbd>+<kbd>D</kbd></span></div><div><span>删除</span><kbd>Delete</kbd></div><div><span>移动 1px / 10px</span><span><kbd>方向键</kbd> / <kbd>Shift</kbd>+<kbd>方向键</kbd></span></div><div><span>居中定位选中对象</span><kbd>Home</kbd></div><div><span>缩放到选中对象</span><kbd>F</kbd></div><div><span>移动画布</span><span>中键拖动 / <kbd>Space</kbd>+左键拖动</span></div><div><span>缩放画布</span><span>鼠标滚轮</span></div><div><span>临时锁定纵横比</span><span>缩放时按 <kbd>Shift</kbd></span></div><div><span>旋转 15° 吸附</span><span>旋转时按 <kbd>Shift</kbd></span></div><div><span>局部弧度形变</span><span>拖紫色点 · 双击轮廓增加点</span></div><div><span>删除形变点</span><span>选中紫色点后 <kbd>Delete</kbd></span></div><div><span>颜色值输入</span><span>#HEX / rgb(...) / rgba(...)</span></div><div><span>创建参考线</span><span>从水平 / 垂直刻度拖出</span></div><div><span>删除参考线</span><span>双击参考线</span></div><div><span>重命名图层</span><span>双击图层名称</span></div><div><span>显示 / 隐藏本面板</span><kbd>?</kbd></div></div>';
function updateSmartHint(){
  const el=$('#smartHint');if(!el)return;const n=selectedObjects().length;let msg='';
  if(spacePanHeld)msg='平移模式：按住 Space + 左键拖动 · 松开 Space 恢复编辑';
  else if(!n)msg='空白拖动框选 · Ctrl+A 全选 · Space / 中键平移 · 滚轮缩放 · ? 全部快捷键';
  else if(n===1){const o=selected(),kind=objectKindName(o);msg=isFillShape(o)&&o.deformEnabled?kind+'形变模式 · 拖紫色点 · 双击轮廓加点 · Delete 删除选中点 · ? 全部操作':isLine(o)?'直线已选中 · 两端手柄调整长度 · 上方圆点旋转 · Home 居中 · F 缩放到选中 · ? 全部快捷键':o?.type==='box'?kind+'已选中 · 上方圆点旋转 · Shift 缩放锁比例 · Home 居中 · F 缩放到选中 · ? 全部快捷键':'文字已选中 · 上方圆点旋转 · Shift+点击追加多选 · Home 居中 · F 缩放到选中 · ? 全部快捷键'}
  else msg=n+' 个对象已选中 · Shift+点击增减选择 · F 缩放到选中 · 方向键移动 · Delete 删除 · ? 全部快捷键';
  el.textContent=msg;el.title=msg+' · 点击查看完整快捷键'
}
$('#smartHint').onclick=e=>{e.stopPropagation();$('#rightbarShell').classList.add('shortcuts-open')};
$('#shortcutToggle').onclick=e=>{e.stopPropagation();$('#rightbarShell').classList.toggle('shortcuts-open')};
$('#shortcutClose').onclick=e=>{e.stopPropagation();$('#rightbarShell').classList.remove('shortcuts-open')};
$('#undoBtn').onclick=undoHistory;$('#redoBtn').onclick=redoHistory;
document.addEventListener('click',e=>{
  const shell=$('#rightbarShell');
  if(!shell.contains(e.target)){document.querySelectorAll('.tool-group.open').forEach(g=>{if(!g.classList.contains('history-group')||!shell.classList.contains('history-open'))g.classList.remove('open')})}
});

function ensureFontOption(value,label=value){
  const select=$('#fontFamily');if(!select||!value)return;
  if([...select.options].some(o=>o.value===value))return;
  const opt=document.createElement('option');opt.value=value;opt.textContent=label;select.appendChild(opt)
}
function cssFontFamilyValue(name){return '"'+String(name).replace(/"/g,'')+'",sans-serif'}
async function restoreCustomFonts(){
  for(const f of state.customFonts){
    if(!f?.family||!f?.data)continue;
    const value=cssFontFamilyValue(f.family);ensureFontOption(value,(f.name||f.family)+'（自定义）');
    if(loadedCustomFontFamilies.has(f.family))continue;
    try{const face=new FontFace(f.family,`url("${f.data}")`);await face.load();document.fonts.add(face);loadedCustomFontFamilies.add(f.family)}catch(err){console.warn('font restore failed',f.name,err)}
  }
  renderObjects(false)
}
$('#loadSystemFonts').onclick=async()=>{
  const status=$('#fontStatus');
  if(typeof window.queryLocalFonts!=='function'){status.textContent='当前浏览器不支持读取系统字体；可使用预置字体或上传字体文件。';setDataStatus('当前浏览器不支持系统字体枚举','err');return}
  try{
    const fonts=await window.queryLocalFonts(),families=[...new Set(fonts.map(f=>f.family).filter(Boolean))].sort((a,b)=>a.localeCompare(b));
    families.forEach(name=>ensureFontOption(cssFontFamilyValue(name),name));status.textContent='已读取 '+families.length+' 个系统字体。';setDataStatus('已读取 '+families.length+' 个系统字体','ok')
  }catch(err){status.textContent='读取系统字体被浏览器拒绝或不可用，可改用上传字体。';setDataStatus('读取系统字体失败','err')}
};
$('#uploadFont').onclick=()=>{const o=selected();if(o?.type==='text'&&!o.locked)$('#fontFile').click()};
$('#fontFile').onchange=async e=>{
  const file=e.target.files?.[0],o=selected();if(!file||o?.type!=='text'||o.locked){e.target.value='';return}
  try{
    const data=await readFileAsDataURL(file),base=(file.name.replace(/\.[^.]+$/,'')||'CustomFont').replace(/[^\w\u4e00-\u9fff-]+/g,'_'),family='TCE_'+base+'_'+Date.now().toString(36);
    const face=new FontFace(family,`url("${data}")`);await face.load();document.fonts.add(face);loadedCustomFontFamilies.add(family);
    state.customFonts.push({id:'font-'+Date.now().toString(36),name:file.name,family,data});
    const value=cssFontFamilyValue(family);ensureFontOption(value,file.name+'（自定义）');o.fontFamily=value;$('#fontFamily').value=value;renderObjects();commitHistory('上传并应用自定义字体');$('#fontStatus').textContent='已加载自定义字体：'+file.name
  }catch(err){setDataStatus('字体加载失败：'+(err?.message||'格式不支持'),'err')}
  finally{e.target.value=''}
};

function refreshPanels(){
  const o=selected(),has=!!o,multi=hasMultiBoxes(),locked=!!o?.locked,line=isLine(o),fillShape=isFillShape(o);
  $('#commonPanel').style.opacity=has?(locked?'.58':'1'):'.45';
  $('#layerName').disabled=!has||multi||locked;
  ['objX','objY','objW','objH','objRotation'].forEach(id=>$('#'+id).disabled=!has||multi||locked);
  $('#lockAspect').disabled=!has||multi||locked||!fillShape;
  $('#aspectLockRow').style.display=fillShape?'flex':'none';
  $('#boxPanel').hidden=!fillShape;$('#deformPanel').hidden=!fillShape;$('#linePanel').hidden=!line;$('#shadowPanel').hidden=o?.type!=='box';$('#textPanel').hidden=o?.type!=='text';
  $('#deleteObj').disabled=multi?editableSelectedObjects().length===0:(!has||locked);
  if(!o){$('#layerName').value='';return}
  $('#layerName').value=o.name||'';$('#objX').value=Math.round(o.x);$('#objY').value=Math.round(o.y);$('#objRotation').value=Math.round(o.rotation||0);$('#lockAspect').checked=!!o.lockAspect;
  if(o.type==='box'){
    $('#sizeFields').style.display='grid';$('#objW').value=Math.round(o.w);$('#objH').value=Math.round(o.h);
    $('#objWLabel').textContent=line?'长度':'宽';$('#objHField').style.display=line?'none':'';$('#objWField').style.display='';$('#objWField').style.gridColumn=line?'1 / -1':'';
    if(line){
      staticColorEditors.lineColor.set(o.lineColor);$('#lineWidth').value=o.lineWidth;$('#lineOpacity').value=Math.round(o.lineOpacity*100);$('#lineOpacityVal').textContent=Math.round(o.lineOpacity*100)+'%';
      $('#linePanel').querySelectorAll('input,select,button,textarea').forEach(el=>el.disabled=locked||multi)
    }else{
      $('#shapePanelTitle').textContent=isEllipse(o)?'圆形外观':'方框外观';$('#radiusRow').style.display=isEllipse(o)?'none':'';
      $('#gradientType').value=o.gradientType||'linear';$('#angleRow').style.display=(o.gradientType||'linear')==='radial'?'none':'';
      if(!isEllipse(o)){const cr=cornerRadii(o);$('#radiusTL').value=Math.round(cr.tl);$('#radiusTR').value=Math.round(cr.tr);$('#radiusBR').value=Math.round(cr.br);$('#radiusBL').value=Math.round(cr.bl)}
      $('#bgOpacity').value=Math.round(o.bgOpacity*100);$('#bgOpacityVal').textContent=Math.round(o.bgOpacity*100)+'%';
      $('#angle').value=o.angle;$('#angleVal').textContent=Math.round(o.angle)+'°';
      $('#boxImageOpacity').value=Math.round(o.imageOpacity*100);$('#boxImageOpacityVal').textContent=Math.round(o.imageOpacity*100)+'%';$('#boxImageFit').value=o.imageFit;
      refreshBorderControls(o);
      renderColorControls(o);
      $('#boxPanel').querySelectorAll('input,select,button,textarea').forEach(el=>el.disabled=locked||multi);
      $('#boxImageRemove').disabled=locked||multi||!o.imageRef
    }
    if(fillShape){
      const points=ensureDeformPoints(o);if(selectedDeformPointId!=null&&!points.some(p=>p.id===selectedDeformPointId))selectedDeformPointId=null;
      $('#deformEnabled').checked=!!o.deformEnabled;$('#deformSmoothness').value=clamp(finiteNumber(o.deformSmoothness,58),20,90);$('#deformSmoothnessVal').textContent=Math.round(clamp(finiteNumber(o.deformSmoothness,58),20,90))+'%';
      $('#deformPanel').querySelectorAll('input,select,button,textarea').forEach(el=>el.disabled=locked||multi);
      $('#addDeformPoint').disabled=locked||multi||!o.deformEnabled;$('#addDeformPoint').classList.toggle('active',deformAddMode);$('#deleteDeformPoint').disabled=locked||multi||!o.deformEnabled||selectedDeformPointId==null
    }
    $('#shadowOn').checked=!!o.shadowOn;$('#shadowX').value=finiteNumber(o.shadowX,0);$('#shadowY').value=finiteNumber(o.shadowY,0);$('#shadowBlur').value=Math.max(0,finiteNumber(o.shadowBlur,0));$('#shadowSpread').value=finiteNumber(o.shadowSpread,0);staticColorEditors.shadowColor.set(o.shadowColor||'#000000');$('#shadowOpacity').value=Math.round(clamp(finiteNumber(o.shadowOpacity,.25),0,1)*100);$('#shadowOpacityVal').textContent=Math.round(clamp(finiteNumber(o.shadowOpacity,.25),0,1)*100)+'%';
    $('#innerShadowSection').hidden=line;
    if(!line){$('#innerShadowOn').checked=!!o.innerShadowOn;$('#innerShadowX').value=finiteNumber(o.innerShadowX,0);$('#innerShadowY').value=finiteNumber(o.innerShadowY,0);$('#innerShadowBlur').value=Math.max(0,finiteNumber(o.innerShadowBlur,0));$('#innerShadowSpread').value=finiteNumber(o.innerShadowSpread,0);staticColorEditors.innerShadowColor.set(o.innerShadowColor||'#000000');$('#innerShadowOpacity').value=Math.round(clamp(finiteNumber(o.innerShadowOpacity,.18),0,1)*100);$('#innerShadowOpacityVal').textContent=Math.round(clamp(finiteNumber(o.innerShadowOpacity,.18),0,1)*100)+'%'}
    $('#shadowHint').textContent=line?'直线没有内部区域，因此只支持外阴影。':'外阴影与内阴影可以同时启用，参数互不影响。';
    $('#shadowPanel').querySelectorAll('input,select,button,textarea').forEach(el=>el.disabled=locked||multi)
  }else{
    $('#sizeFields').style.display='none';$('#objHField').style.display='';$('#objWField').style.gridColumn='';$('#objWLabel').textContent='宽';
    $('#textContent').value=o.content;$('#fontSize').value=o.fontSize;staticColorEditors.textColor.set(o.color);
    $('#textOpacity').value=Math.round(o.opacity*100);$('#textOpacityVal').textContent=Math.round(o.opacity*100)+'%';$('#fontWeight').value=o.fontWeight;ensureFontOption(o.fontFamily,o.fontFamily);$('#fontFamily').value=o.fontFamily;
    $('#textPanel').querySelectorAll('input,select,button,textarea').forEach(el=>el.disabled=locked)
  }
}
function syncColorEditor(textEl,pickerEl,value){
  const normalized=normalizeColorValue(value,'#ffffff');textEl.value=normalized;textEl.classList.remove('invalid');pickerEl.value=colorToHex(normalized)
}
function bindColorEditor(textEl,pickerEl,onValue){
  const apply=(raw,commit=false)=>{
    const parsed=parseColorValue(raw);
    textEl.classList.toggle('invalid',!parsed);
    if(!parsed)return false;
    textEl.value=parsed.css;pickerEl.value=parsed.hex;onValue(parsed.css,commit);return true
  };
  textEl.addEventListener('input',()=>{const parsed=parseColorValue(textEl.value);textEl.classList.toggle('invalid',!parsed);if(parsed){pickerEl.value=parsed.hex;onValue(parsed.css,false)}});
  textEl.addEventListener('change',()=>{if(!apply(textEl.value,true)){textEl.classList.add('invalid')}});
  textEl.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();textEl.blur()}});
  pickerEl.addEventListener('input',()=>{textEl.value=pickerEl.value;textEl.classList.remove('invalid');onValue(pickerEl.value,false)});
  pickerEl.addEventListener('change',()=>onValue(pickerEl.value,true));
  return{set:value=>syncColorEditor(textEl,pickerEl,value),apply}
}
function makeColorEditor(value,onValue){
  const wrap=document.createElement('div');wrap.className='color-editor';
  const picker=document.createElement('input');picker.type='color';
  const text=document.createElement('input');text.type='text';text.spellcheck=false;text.placeholder='#RRGGBB / rgba(...)';text.title='支持 #RGB、#RGBA、#RRGGBB、#RRGGBBAA、rgb(...)、rgba(...)';
  wrap.append(picker,text);const binding=bindColorEditor(text,picker,onValue);binding.set(value);return{wrap,binding,text,picker}
}
function renderColorControls(o){
  const wrap=$('#colors');wrap.innerHTML='';
  o.colors.forEach((s,i)=>{
    const r=document.createElement('div');r.className='color-row';
    const editor=makeColorEditor(s.c,(value,commit)=>{s.c=value;renderObjects(false);if(commit)commitHistory('修改对象渐变颜色')});
    const p=document.createElement('input');p.type='range';p.min='0';p.max='100';p.value=s.p;p.title='位置 '+s.p+'%';
    const rm=document.createElement('button');rm.className='remove';rm.textContent='×';
    p.oninput=()=>{s.p=+p.value;p.title='位置 '+s.p+'%';renderObjects(false)};
    p.onchange=()=>commitHistory('调整对象渐变位置');
    rm.onclick=()=>{if(o.colors.length>1){o.colors.splice(i,1);renderObjects(true);commitHistory('删除对象渐变颜色')}};
    r.append(editor.wrap,p,rm);wrap.appendChild(r)
  })
}
function renderCanvasColorControls(){
  const wrap=$('#canvasColors');wrap.innerHTML='';
  state.canvasColors.forEach((s,i)=>{
    const r=document.createElement('div');r.className='color-row';
    const editor=makeColorEditor(s.c,(value,commit)=>{s.c=value;renderObjects(false);if(commit)commitHistory('修改画布渐变颜色')});
    const p=document.createElement('input');p.type='range';p.min='0';p.max='100';p.value=s.p;p.title='位置 '+s.p+'%';
    const rm=document.createElement('button');rm.className='remove';rm.textContent='×';
    p.oninput=()=>{s.p=+p.value;p.title='位置 '+s.p+'%';renderObjects(false)};
    p.onchange=()=>commitHistory('调整画布渐变位置');
    rm.onclick=()=>{if(state.canvasColors.length>1){state.canvasColors.splice(i,1);renderCanvasColorControls();renderObjects(false);commitHistory('删除画布渐变颜色')}};
    r.append(editor.wrap,p,rm);wrap.appendChild(r)
  })
}
const staticColorEditors={
  borderColor:bindColorEditor($('#borderColor'),$('#borderColorPicker'),(value,commit)=>{mutateSelected(o=>{if(isFillShape(o)){const b=activeBorderSpec(o);if(b)b.color1=value;syncLegacyBorderFromTop(o)}});if(commit)commitHistory('修改边框颜色 1')}),
  borderColor2:bindColorEditor($('#borderColor2'),$('#borderColor2Picker'),(value,commit)=>{mutateSelected(o=>{if(isFillShape(o)){const b=activeBorderSpec(o);if(b)b.color2=value}});if(commit)commitHistory('修改边框颜色 2')}),
  shadowColor:bindColorEditor($('#shadowColor'),$('#shadowColorPicker'),(value,commit)=>{mutateSelected(o=>{if(o.type==='box')o.shadowColor=value});if(commit)commitHistory('修改外阴影颜色')}),
  innerShadowColor:bindColorEditor($('#innerShadowColor'),$('#innerShadowColorPicker'),(value,commit)=>{mutateSelected(o=>{if(isFillShape(o))o.innerShadowColor=value});if(commit)commitHistory('修改内阴影颜色')}),
  lineColor:bindColorEditor($('#lineColor'),$('#lineColorPicker'),(value,commit)=>{mutateSelected(o=>{if(isLine(o))o.lineColor=value});if(commit)commitHistory('修改直线颜色')}),
  textColor:bindColorEditor($('#textColor'),$('#textColorPicker'),(value,commit)=>{mutateSelected(o=>{if(o.type==='text')o.color=value});if(commit)commitHistory('修改文字颜色')})
};

let gesture=null;
let spacePanHeld=false;
function setSpacePanHeld(active){
  spacePanHeld=active;
  viewport.classList.toggle('space-pan-ready',active);updateSmartHint()
}
function beginPan(e){
  e.preventDefault();
  gesture={type:'pan',sx:e.clientX,sy:e.clientY,orig:{x:state.panX,y:state.panY}};
  viewport.classList.add('panning');
  viewport.setPointerCapture(e.pointerId)
}
function bindObjectEvents(el,o){
  el.addEventListener('pointerdown',e=>{
    if(e.button===1||(e.button===0&&spacePanHeld)){e.stopPropagation();beginPan(e);return}
    if(e.button!==0)return;
    e.stopPropagation();
    const dir=e.target.dataset.dir,deformPointId=Number(e.target.dataset.deformPoint)||null;
    if(e.shiftKey&&!dir&&!deformPointId){selectObject(o,true);renderObjects();return}
    if(!state.selectedBoxIds.includes(o.id)){selectObject(o,false);renderObjects()}
    if(o.locked){gesture=null;return}
    if(deformAddMode&&isFillShape(o)&&o.deformEnabled&&!deformPointId&&!dir){
      const local=worldPointToObjectLocal(o,clientToWorld(e.clientX,e.clientY));
      if(addDeformPointAt(o,local)){deformAddMode=false;$('#addDeformPoint').classList.remove('active');renderObjects();commitHistory('增加形变点')}else setDataStatus('请点击更靠近轮廓的位置','err');
      return
    }
    if(deformPointId&&isFillShape(o)&&o.deformEnabled&&state.selectedBoxIds.length===1){
      selectedDeformPointId=deformPointId;$('#deleteDeformPoint').disabled=false;e.target.classList.add('selected-point');gesture={type:'deformPoint',id:o.id,pointId:deformPointId};el.classList.add('deforming')
    }else if(dir==='rotate'&&state.selectedBoxIds.length===1){
      const s=getObjectSize(o),center={x:o.x+s.w/2,y:o.y+s.h/2},p=clientToWorld(e.clientX,e.clientY);
      gesture={type:'rotate',id:o.id,center,startAngle:Math.atan2(p.y-center.y,p.x-center.x),origRotation:o.rotation||0};
      el.classList.add('rotating')
    }else if(dir&&o.type==='box'&&state.selectedBoxIds.length===1){
      gesture={type:'resize',id:o.id,dir,sx:e.clientX,sy:e.clientY,ratio:o.w/Math.max(1,o.h),lockAspect:!!o.lockAspect,orig:{x:o.x,y:o.y,w:o.w,h:o.h}}
    }else if(state.selectedBoxIds.length>1&&state.selectedBoxIds.includes(o.id)){
      const items=editableSelectedObjects(),origins=items.map(item=>({id:item.id,x:item.x,y:item.y}));
      if(!origins.length){gesture=null;return}
      gesture={type:'moveGroup',sx:e.clientX,sy:e.clientY,origins,bounds:selectionBounds(items)}
    }else{
      gesture={type:'move',id:o.id,sx:e.clientX,sy:e.clientY,orig:{x:o.x,y:o.y}}
    }
    viewport.setPointerCapture(e.pointerId)
  });
  el.addEventListener('dblclick',e=>{
    if(!isFillShape(o)||!o.deformEnabled||o.locked||e.target.closest('.deform-handle,.handle,.rotate-handle'))return;
    e.preventDefault();e.stopPropagation();const local=worldPointToObjectLocal(o,clientToWorld(e.clientX,e.clientY));
    if(addDeformPointAt(o,local)){renderObjects();commitHistory('增加形变点')}else setDataStatus('双击更靠近轮廓的位置可增加形变点','err')
  });
  el.addEventListener('contextmenu',e=>{
    e.preventDefault();e.stopPropagation();const pointId=Number(e.target.dataset.deformPoint)||null;
    if(state.selectedBoxIds.includes(o.id)&&state.selectedBoxIds.length>1){state.selectedId=o.id}
    else if(state.selectedId!==o.id){selectObject(o,false);renderObjects()}
    if(pointId)selectedDeformPointId=pointId;showContextMenu(e.clientX,e.clientY,o,pointId)
  })
}
function getObjectSize(o){if(o.type==='box')return{w:o.w,h:o.h};const m=textMetrics(measureCtx,o);return{w:m.w,h:m.h}}
function getUnrotatedVisualRect(o){
  const base=getObjectSize(o),cy=o.y+base.h/2;
  if(isLine(o)){const h=Math.max(1,o.lineWidth);return{x:o.x,y:cy-h/2,w:o.w,h}}
  let rect;if(isFillShape(o)&&o.deformEnabled){const d=deformExtents(o);rect={x:o.x-d.left,y:o.y-d.top,w:o.w+d.left+d.right,h:o.h+d.top+d.bottom}}else rect={x:o.x,y:o.y,w:base.w,h:base.h};
  if(isFillShape(o)&&o.borderOn){const p=maxBorderWidth(o)/2;rect={x:rect.x-p,y:rect.y-p,w:rect.w+p*2,h:rect.h+p*2}}
  return rect
}
function getObjectBounds(o){
  const base=getObjectSize(o),cx=o.x+base.w/2,cy=o.y+base.h/2,rect=getUnrotatedVisualRect(o);
  const angle=((o.rotation||0)%360)*Math.PI/180;if(Math.abs(angle)<1e-8)return rect;
  const c=Math.cos(angle),s=Math.sin(angle),pts=[[rect.x,rect.y],[rect.x+rect.w,rect.y],[rect.x+rect.w,rect.y+rect.h],[rect.x,rect.y+rect.h]].map(([x,y])=>{const dx=x-cx,dy=y-cy;return{x:cx+dx*c-dy*s,y:cy+dx*s+dy*c}});
  const minX=Math.min(...pts.map(p=>p.x)),minY=Math.min(...pts.map(p=>p.y)),maxX=Math.max(...pts.map(p=>p.x)),maxY=Math.max(...pts.map(p=>p.y));return{x:minX,y:minY,w:maxX-minX,h:maxY-minY}
}
function selectionBounds(items=selectedObjects()){
  if(!items.length)return null;const rects=items.map(getObjectBounds),x=Math.min(...rects.map(r=>r.x)),y=Math.min(...rects.map(r=>r.y)),right=Math.max(...rects.map(r=>r.x+r.w)),bottom=Math.max(...rects.map(r=>r.y+r.h));
  return{x,y,w:right-x,h:bottom-y}
}
function clientToWorld(clientX,clientY){const r=viewport.getBoundingClientRect();return{x:(clientX-r.left-state.panX)/state.zoom,y:(clientY-r.top-state.panY)/state.zoom}}
function worldPointToObjectLocal(o,p){
  const cx=o.x+o.w/2,cy=o.y+o.h/2,rad=-(o.rotation||0)*Math.PI/180,c=Math.cos(rad),s=Math.sin(rad),dx=p.x-cx,dy=p.y-cy;
  return{x:dx*c-dy*s+o.w/2,y:dx*s+dy*c+o.h/2}
}
function rectsIntersect(a,b){return a.x<=b.x+b.w&&a.x+a.w>=b.x&&a.y<=b.y+b.h&&a.y+a.h>=b.y}
function focusBounds(bounds,fit=false){
  if(!bounds)return;const pad=fit?150:0;
  if(fit)state.zoom=clamp(Math.min((viewport.clientWidth-pad)/Math.max(1,bounds.w),(viewport.clientHeight-pad)/Math.max(1,bounds.h)),.1,4);
  state.panX=viewport.clientWidth/2-(bounds.x+bounds.w/2)*state.zoom;state.panY=viewport.clientHeight/2-(bounds.y+bounds.h/2)*state.zoom;updateWorldTransform()
}
let snapFeedback={lines:[],distances:[]};
function clearSnapFeedback(){snapFeedback={lines:[],distances:[]};snapOverlay.innerHTML=''}
function renderSnapFeedback(){
  snapOverlay.innerHTML='';
  snapFeedback.lines.forEach(line=>{const el=document.createElement('div');el.className='snap-line '+line.axis;if(line.axis==='vertical')el.style.left=(state.panX+line.value*state.zoom)+'px';else el.style.top=(state.panY+line.value*state.zoom)+'px';snapOverlay.appendChild(el)});
  snapFeedback.distances.forEach(d=>{const el=document.createElement('div');el.className='snap-distance';el.textContent=(d.axis==='x'?'↔ ':'↕ ')+Math.round(d.gap*10)/10+' px';el.style.left=(state.panX+d.x*state.zoom)+'px';el.style.top=(state.panY+d.y*state.zoom)+'px';snapOverlay.appendChild(el)})
}
function snapTargets(axis,excludeIds=new Set()){
  const base=axis==='x'?[0,state.canvasW/2,state.canvasW,...state.guides.vertical]:[0,state.canvasH/2,state.canvasH,...state.guides.horizontal];
  state.objects.forEach(o=>{if(o.visible===false||excludeIds.has(o.id))return;const b=getObjectBounds(o);if(axis==='x')base.push(b.x,b.x+b.w/2,b.x+b.w);else base.push(b.y,b.y+b.h/2,b.y+b.h)});
  return[...new Set(base.filter(Number.isFinite).map(v=>Math.round(v*1000)/1000))]
}
function equalSpacingCandidate(axis,rect,x,y,excludeIds,threshold){
  const others=state.objects.filter(o=>o.visible!==false&&!excludeIds.has(o.id)).map(getObjectBounds).sort((a,b)=>axis==='x'?a.x-b.x:a.y-b.y);
  let best=null;
  for(let i=0;i<others.length-1;i++){
    const a=others[i],b=others[i+1],aEnd=axis==='x'?a.x+a.w:a.y+a.h,bStart=axis==='x'?b.x:b.y,gap=bStart-aEnd;if(gap<0)continue;
    const size=axis==='x'?rect.w:rect.h,pos=axis==='x'?x:y;
    const candidates=[
      {pos:(axis==='x'?b.x+b.w:b.y+b.h)+gap,gap,anchor:b},
      {pos:(axis==='x'?a.x:a.y)-size-gap,gap,anchor:a}
    ];
    const room=gap-size;if(room>=0)candidates.push({pos:aEnd+room/2,gap:room/2,anchor:a});
    for(const c of candidates){const d=Math.abs(c.pos-pos);if(d<=threshold&&(!best||d<best.d))best={...c,d}}
  }
  if(!best)return null;
  return axis==='x'?{pos:best.pos,d:best.d,feedback:{axis:'x',gap:best.gap,x:best.pos+rect.w/2,y:y-24/state.zoom}}:{pos:best.pos,d:best.d,feedback:{axis:'y',gap:best.gap,x:x+rect.w/2,y:best.pos-24/state.zoom}}
}
function snapValue(v,targets){if(!state.snapEnabled)return v;const th=8/Math.max(.1,state.zoom);let best=v,dist=Infinity;for(const t of targets){const d=Math.abs(v-t);if(d<=th&&d<dist){best=t;dist=d}}return Math.round(best*1000)/1000}
function snapRectMove(rect,x,y,excludeIds=new Set()){
  if(!state.snapEnabled){clearSnapFeedback();return{x,y}}const tx=snapTargets('x',excludeIds),ty=snapTargets('y',excludeIds),th=8/state.zoom;let dx=0,dy=0,bx=Infinity,by=Infinity,xLine=null,yLine=null;
  for(const c of[x,x+rect.w/2,x+rect.w])for(const t of tx){const d=Math.abs(c-t);if(d<=th&&d<bx){bx=d;dx=t-c;xLine=t}}
  for(const c of[y,y+rect.h/2,y+rect.h])for(const t of ty){const d=Math.abs(c-t);if(d<=th&&d<by){by=d;dy=t-c;yLine=t}}
  const eqX=equalSpacingCandidate('x',rect,x,y,excludeIds,th),eqY=equalSpacingCandidate('y',rect,x,y,excludeIds,th);let usedEqX=false,usedEqY=false;
  if(eqX&&eqX.d<bx){dx=eqX.pos-x;bx=eqX.d;xLine=null;usedEqX=true}
  if(eqY&&eqY.d<by){dy=eqY.pos-y;by=eqY.d;yLine=null;usedEqY=true}
  const clean=v=>Math.round(v*1000)/1000,rx=clean(x+dx),ry=clean(y+dy);
  snapFeedback={lines:[],distances:[]};if(xLine!=null)snapFeedback.lines.push({axis:'vertical',value:xLine});if(yLine!=null)snapFeedback.lines.push({axis:'horizontal',value:yLine});if(usedEqX)snapFeedback.distances.push({...eqX.feedback,x:rx+rect.w/2,y:ry-24/state.zoom});if(usedEqY)snapFeedback.distances.push({...eqY.feedback,x:rx+rect.w/2,y:ry+rect.h/2});renderSnapFeedback();
  return{x:rx,y:ry}
}
function snapMove(o,x,y){
  const b=getObjectBounds(o),offsetX=b.x-o.x,offsetY=b.y-o.y,p=snapRectMove({w:b.w,h:b.h},x+offsetX,y+offsetY,new Set([o.id]));
  return{x:p.x-offsetX,y:p.y-offsetY}
}
function syncPositionFields(o){if(!o||o.id!==state.selectedId||hasMultiBoxes())return;$('#objX').value=Math.round(o.x);$('#objY').value=Math.round(o.y);if(o.type==='box'){$('#objW').value=Math.round(o.w);$('#objH').value=Math.round(o.h)}}
function applyAspectResize(g,d,x,y,w,h,preserve){
  const ratio=g.ratio||1,horiz=d.includes('e')||d.includes('w'),vert=d.includes('n')||d.includes('s');
  if(!preserve)return{x,y,w,h};
  if(horiz&&vert){
    const rw=Math.abs(w-g.orig.w)/Math.max(1,g.orig.w),rh=Math.abs(h-g.orig.h)/Math.max(1,g.orig.h);
    if(rw>=rh){h=w/ratio;if(d.includes('n'))y=g.orig.y+g.orig.h-h;else y=g.orig.y}
    else{w=h*ratio;if(d.includes('w'))x=g.orig.x+g.orig.w-w;else x=g.orig.x}
  }else if(horiz){h=w/ratio;y=g.orig.y+(g.orig.h-h)/2}
  else if(vert){w=h*ratio;x=g.orig.x+(g.orig.w-w)/2}
  const scale=Math.max(1,20/Math.max(.001,w),20/Math.max(.001,h));if(scale>1){w*=scale;h*=scale}
  if(d.includes('w'))x=g.orig.x+g.orig.w-w;if(d.includes('n'))y=g.orig.y+g.orig.h-h;
  return{x,y,w,h}
}
viewport.addEventListener('pointermove',e=>{
  if(!gesture)return;
  if(gesture.type==='pan'){state.panX=gesture.orig.x+(e.clientX-gesture.sx);state.panY=gesture.orig.y+(e.clientY-gesture.sy);updateWorldTransform();return}
  if(gesture.type==='marquee'){
    const r=viewport.getBoundingClientRect(),x1=gesture.sx-r.left,y1=gesture.sy-r.top,x2=e.clientX-r.left,y2=e.clientY-r.top;
    selectionMarquee.style.left=Math.min(x1,x2)+'px';selectionMarquee.style.top=Math.min(y1,y2)+'px';selectionMarquee.style.width=Math.abs(x2-x1)+'px';selectionMarquee.style.height=Math.abs(y2-y1)+'px';return
  }
  if(gesture.type==='deformPoint'){
    const o=state.objects.find(x=>x.id===gesture.id);if(!o||!isFillShape(o))return;const point=ensureDeformPoints(o).find(p=>p.id===gesture.pointId);if(!point)return;
    const local=worldPointToObjectLocal(o,clientToWorld(e.clientX,e.clientY)),base=deformPointBaseLocal(o,point),limit=Math.max(o.w,o.h)*1.5;
    const other=isEllipse(o)?ellipseDeformAt(o,point.t,point.id):rectDeformAt(o,point.side,point.t,point.id);
    const selfWeight=isEllipse(o)?1:Math.max(.001,Math.min(1,point.t/.12,(1-point.t)/.12));
    point.dx=clamp(Math.round(((local.x-base.x-other.dx)/selfWeight)*100)/100,-limit,limit);
    point.dy=clamp(Math.round(((local.y-base.y-other.dy)/selfWeight)*100)/100,-limit,limit);
    if(Math.abs(point.dx)<3/Math.max(.1,state.zoom))point.dx=0;if(Math.abs(point.dy)<3/Math.max(.1,state.zoom))point.dy=0;
    renderObjects(false);return
  }
  if(gesture.type==='rotate'){
    const o=state.objects.find(x=>x.id===gesture.id);if(!o)return;const p=clientToWorld(e.clientX,e.clientY),a=Math.atan2(p.y-gesture.center.y,p.x-gesture.center.x),delta=(a-gesture.startAngle)*180/Math.PI;
    let rotation=gesture.origRotation+delta;if(e.shiftKey)rotation=Math.round(rotation/15)*15;o.rotation=Math.round(rotation*100)/100;renderObjects(false);$('#objRotation').value=Math.round(o.rotation);return
  }
  const dx=(e.clientX-gesture.sx)/state.zoom,dy=(e.clientY-gesture.sy)/state.zoom;
  if(gesture.type==='moveGroup'){
    const excluded=new Set(gesture.origins.map(or=>or.id)),p=snapRectMove(gesture.bounds,gesture.bounds.x+dx,gesture.bounds.y+dy,excluded),adx=p.x-gesture.bounds.x,ady=p.y-gesture.bounds.y;
    gesture.origins.forEach(or=>{const o=state.objects.find(x=>x.id===or.id);if(o){o.x=or.x+adx;o.y=or.y+ady}});
    renderObjects(false);return
  }
  const o=state.objects.find(x=>x.id===gesture.id);if(!o)return;
  if(gesture.type==='move'){const p=snapMove(o,gesture.orig.x+dx,gesture.orig.y+dy);o.x=p.x;o.y=p.y;renderObjects(false);syncPositionFields(o);return}
  let{x,y,w,h}=gesture.orig;const d=gesture.dir,excluded=new Set([o.id]);
  if(d.includes('e')){let right=snapValue(gesture.orig.x+gesture.orig.w+dx,snapTargets('x',excluded));w=right-x}
  if(d.includes('s')){let bottom=snapValue(gesture.orig.y+gesture.orig.h+dy,snapTargets('y',excluded));h=bottom-y}
  if(d.includes('w')){let left=snapValue(gesture.orig.x+dx,snapTargets('x',excluded));w=gesture.orig.x+gesture.orig.w-left;x=left}
  if(d.includes('n')){let top=snapValue(gesture.orig.y+dy,snapTargets('y',excluded));h=gesture.orig.y+gesture.orig.h-top;y=top}
  ({x,y,w,h}=applyAspectResize(gesture,d,x,y,w,h,gesture.lockAspect||e.shiftKey));
  if(w<20){if(d.includes('w'))x=gesture.orig.x+gesture.orig.w-20;w=20}if(h<20){if(d.includes('n'))y=gesture.orig.y+gesture.orig.h-20;h=20}
  o.x=x;o.y=y;o.w=w;o.h=h;renderObjects(false);syncPositionFields(o)
});
viewport.addEventListener('pointerdown',e=>{
  if(e.button===1||(e.button===0&&spacePanHeld)){beginPan(e);return}
  if(e.button!==0)return;
  if(e.target===viewport||e.target===world||e.target.classList.contains('canvas-image-layer')||e.target.classList.contains('canvas-bg-layer')){
    const r=viewport.getBoundingClientRect(),x=e.clientX-r.left,y=e.clientY-r.top;
    gesture={type:'marquee',sx:e.clientX,sy:e.clientY,baseIds:e.shiftKey?[...state.selectedBoxIds]:[]};
    selectionMarquee.style.left=x+'px';selectionMarquee.style.top=y+'px';selectionMarquee.style.width='0px';selectionMarquee.style.height='0px';selectionMarquee.classList.add('show');viewport.setPointerCapture(e.pointerId)
  }
});
viewport.addEventListener('auxclick',e=>{if(e.button===1)e.preventDefault()});
viewport.addEventListener('pointerup',e=>{
  if(!gesture||gesture.type==='guide')return;const g=gesture,type=g.type;gesture=null;viewport.classList.remove('panning');world.querySelectorAll('.rotating,.deforming').forEach(el=>{el.classList.remove('rotating');el.classList.remove('deforming')});
  if(type==='marquee'){
    const moved=Math.hypot(e.clientX-g.sx,e.clientY-g.sy),a=clientToWorld(g.sx,g.sy),b=clientToWorld(e.clientX,e.clientY);
    selectionMarquee.classList.remove('show');
    if(moved<3){if(!g.baseIds.length)clearSelection()}
    else{
      const rect={x:Math.min(a.x,b.x),y:Math.min(a.y,b.y),w:Math.abs(b.x-a.x),h:Math.abs(b.y-a.y)},hits=state.objects.filter(o=>o.visible!==false&&rectsIntersect(getObjectBounds(o),rect)).map(o=>o.id);
      state.selectedBoxIds=[...new Set([...g.baseIds,...hits])];state.selectedId=state.selectedBoxIds.at(-1)||null
    }
    renderObjects();updateSmartHint();return
  }
  clearSnapFeedback();
  if(type==='move'||type==='moveGroup')commitHistory('移动对象');else if(type==='resize')commitHistory('调整对象尺寸');else if(type==='rotate')commitHistory('旋转对象');else if(type==='deformPoint')commitHistory('形变对象')
});
viewport.addEventListener('pointercancel',()=>{
  if(!gesture||gesture.type==='guide')return;const type=gesture.type;gesture=null;viewport.classList.remove('panning');selectionMarquee.classList.remove('show');world.querySelectorAll('.rotating,.deforming').forEach(el=>{el.classList.remove('rotating');el.classList.remove('deforming')});clearSnapFeedback();
  if(type==='move'||type==='moveGroup'||type==='resize'||type==='rotate'||type==='deformPoint')commitHistory(type==='resize'?'调整对象尺寸':type==='rotate'?'旋转对象':type==='deformPoint'?'形变对象':'移动对象')
});

const RULER_SIZE=28;
function chooseRulerStep(){const xs=[5,10,20,25,50,100,200,250,500,1000,2000];return xs.find(v=>v*state.zoom>=62)||2000}
function prepRuler(canvas){
  const dpr=Math.max(1,window.devicePixelRatio||1),r=canvas.getBoundingClientRect(),w=Math.max(1,Math.round(r.width*dpr)),h=Math.max(1,Math.round(r.height*dpr));
  if(canvas.width!==w||canvas.height!==h){canvas.width=w;canvas.height=h}
  const ctx=canvas.getContext('2d');ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,r.width,r.height);return{ctx,w:r.width,h:r.height}
}
function renderRulers(){
  const major=chooseRulerStep(),minor=major/5;
  {
    const{ctx,w,h}=prepRuler(topRuler);ctx.fillStyle='#f8fafc';ctx.fillRect(0,0,w,h);ctx.strokeStyle='rgba(82,98,120,.34)';ctx.fillStyle='#64748b';ctx.font='9px system-ui';ctx.textBaseline='top';
    for(let v=0;v<=state.canvasW+1e-6;v+=minor){const x=v*state.zoom,isMajor=Math.abs(v/major-Math.round(v/major))<1e-6;ctx.beginPath();ctx.moveTo(Math.round(x)+.5,h);ctx.lineTo(Math.round(x)+.5,h-(isMajor?13:6));ctx.stroke();if(isMajor){const label=String(Math.round(v));const tw=ctx.measureText(label).width;ctx.fillText(label,Math.min(Math.max(2,x+3),Math.max(2,w-tw-3)),2)}}
  }
  {
    const{ctx,w,h}=prepRuler(leftRuler);ctx.fillStyle='#f8fafc';ctx.fillRect(0,0,w,h);ctx.strokeStyle='rgba(82,98,120,.34)';ctx.fillStyle='#64748b';ctx.font='9px system-ui';ctx.textBaseline='middle';
    for(let v=0;v<=state.canvasH+1e-6;v+=minor){const y=v*state.zoom,isMajor=Math.abs(v/major-Math.round(v/major))<1e-6;ctx.beginPath();ctx.moveTo(w,Math.round(y)+.5);ctx.lineTo(w-(isMajor?13:6),Math.round(y)+.5);ctx.stroke();if(isMajor){ctx.save();const yy=Math.min(Math.max(10,y+3),Math.max(10,h-10));ctx.translate(7,yy);ctx.rotate(-Math.PI/2);ctx.fillText(String(Math.round(v)),0,0);ctx.restore()}}
  }
}
function renderGuides(){
  guideLayer.innerHTML='';
  guideLayer.style.display=state.guidesVisible?'block':'none';
  const add=(axis,value,index)=>{
    const line=document.createElement('div');line.className='guide '+(axis==='vertical'?'vertical':'horizontal');line.dataset.axis=axis;line.dataset.index=index;
    if(axis==='vertical')line.style.left=(state.panX+value*state.zoom)+'px';else line.style.top=(state.panY+value*state.zoom)+'px';
    line.title=(axis==='vertical'?'X: ':'Y: ')+Math.round(value);
    line.addEventListener('pointerdown',e=>{e.preventDefault();e.stopPropagation();gesture={type:'guide',axis,index};showGuideLabel(axis,value,e.clientX,e.clientY)});
    line.addEventListener('dblclick',e=>{e.stopPropagation();state.guides[axis].splice(index,1);renderGuides();commitHistory('删除参考线')});guideLayer.appendChild(line)
  };
  state.guides.vertical.forEach((v,i)=>add('vertical',v,i));state.guides.horizontal.forEach((v,i)=>add('horizontal',v,i));const count=state.guides.vertical.length+state.guides.horizontal.length;const countEl=$('#guideCount');if(countEl)countEl.textContent='参考线 '+count
}
function guideCoord(axis,e){const r=viewport.getBoundingClientRect();return axis==='vertical'?(e.clientX-r.left-state.panX)/state.zoom:(e.clientY-r.top-state.panY)/state.zoom}
function showGuideLabel(axis,value,cx,cy){let el=$('#guideDragLabel');if(!el){el=document.createElement('div');el.id='guideDragLabel';el.className='guide-label';document.querySelector('.workspace').appendChild(el)}const r=document.querySelector('.workspace').getBoundingClientRect();el.style.display='block';el.style.left=(cx-r.left+10)+'px';el.style.top=(cy-r.top+10)+'px';el.textContent=(axis==='vertical'?'X ':'Y ')+Math.round(value)}
function hideGuideLabel(){const el=$('#guideDragLabel');if(el)el.style.display='none'}
function beginGuide(axis,e){if(e.button===1||(e.button===0&&spacePanHeld)){e.preventDefault();e.stopPropagation();beginPan(e);return}e.preventDefault();e.stopPropagation();if(!state.guidesVisible){state.guidesVisible=true;refreshRightbar()}const value=guideCoord(axis,e),list=state.guides[axis];list.push(value);gesture={type:'guide',axis,index:list.length-1,newGuide:true};renderGuides();showGuideLabel(axis,value,e.clientX,e.clientY)}
topRuler.addEventListener('pointerdown',e=>beginGuide('vertical',e));
leftRuler.addEventListener('pointerdown',e=>beginGuide('horizontal',e));
document.addEventListener('pointermove',e=>{if(!gesture||gesture.type!=='guide')return;const list=state.guides[gesture.axis];if(!list||gesture.index>=list.length)return;const value=guideCoord(gesture.axis,e);list[gesture.index]=value;renderGuides();showGuideLabel(gesture.axis,value,e.clientX,e.clientY)});
document.addEventListener('pointerup',()=>{if(!gesture||gesture.type!=='guide')return;const wasNew=!!gesture.newGuide,list=state.guides[gesture.axis],v=list?.[gesture.index],max=gesture.axis==='vertical'?state.canvasW:state.canvasH;if(!Number.isFinite(v)||v<0||v>max)list.splice(gesture.index,1);gesture=null;hideGuideLabel();renderGuides();commitHistory(wasNew?'添加参考线':'移动参考线')});

function updateWorldTransform(){
  world.style.width=state.canvasW+'px';world.style.height=state.canvasH+'px';world.style.transform=`translate(${state.panX}px,${state.panY}px) scale(${state.zoom})`;
  const rw=state.canvasW*state.zoom,rh=state.canvasH*state.zoom;
  topRuler.style.left=state.panX+'px';topRuler.style.top=(state.panY-RULER_SIZE)+'px';topRuler.style.width=rw+'px';topRuler.style.height=RULER_SIZE+'px';
  leftRuler.style.left=(state.panX-RULER_SIZE)+'px';leftRuler.style.top=state.panY+'px';leftRuler.style.width=RULER_SIZE+'px';leftRuler.style.height=rh+'px';
  const corner=document.querySelector('.ruler-corner');corner.style.left=(state.panX-RULER_SIZE)+'px';corner.style.top=(state.panY-RULER_SIZE)+'px';
  $('#zoomLabel').textContent=Math.round(state.zoom*100)+'%';$('#canvasSizeLabel').textContent=state.canvasW+' × '+state.canvasH;renderRulers();renderGuides()
}
function zoomAt(clientX,clientY,newZoom){newZoom=clamp(newZoom,.1,5);const r=viewport.getBoundingClientRect(),vx=clientX-r.left,vy=clientY-r.top,wx=(vx-state.panX)/state.zoom,wy=(vy-state.panY)/state.zoom;state.panX=vx-wx*newZoom;state.panY=vy-wy*newZoom;state.zoom=newZoom;updateWorldTransform()}
viewport.addEventListener('wheel',e=>{e.preventDefault();zoomAt(e.clientX,e.clientY,state.zoom*(e.deltaY<0?1.12:1/1.12))},{passive:false});
$('#zoomIn').onclick=()=>zoomAt(viewport.clientWidth/2,viewport.clientHeight/2,state.zoom*1.2);
$('#zoomOut').onclick=()=>zoomAt(viewport.clientWidth/2,viewport.clientHeight/2,state.zoom/1.2);
$('#resetView').onclick=()=>{state.zoom=1;state.panX=70;state.panY=70;updateWorldTransform()};
$('#fitView').onclick=()=>{const pad=100;state.zoom=clamp(Math.min((viewport.clientWidth-pad)/state.canvasW,(viewport.clientHeight-pad)/state.canvasH),.1,3);state.panX=(viewport.clientWidth-state.canvasW*state.zoom)/2;state.panY=(viewport.clientHeight-state.canvasH*state.zoom)/2;updateWorldTransform()};

function mutateSelected(fn,syncUI=false){const o=selected();if(!o||hasMultiBoxes()||o.locked)return;fn(o);renderObjects(syncUI)}
$('#layerName').oninput=e=>{const o=selected();if(!o||hasMultiBoxes()||o.locked)return;o.name=e.target.value;renderLayers()};
$('#objX').oninput=e=>mutateSelected(o=>o.x=+e.target.value||0);$('#objY').oninput=e=>mutateSelected(o=>o.y=+e.target.value||0);
$('#objRotation').oninput=e=>mutateSelected(o=>o.rotation=finiteNumber(e.target.value,0));
$('#lockAspect').onchange=e=>mutateSelected(o=>{if(isFillShape(o))o.lockAspect=e.target.checked});
$('#deformEnabled').onchange=e=>{mutateSelected(o=>{if(isFillShape(o)){o.deformEnabled=e.target.checked;ensureDeformPoints(o);if(!e.target.checked){selectedDeformPointId=null;deformAddMode=false}}},true);commitHistory(e.target.checked?'启用局部形变':'关闭局部形变')};
$('#deformSmoothness').oninput=e=>{mutateSelected(o=>{if(isFillShape(o))o.deformSmoothness=clamp(+e.target.value||58,20,90)});$('#deformSmoothnessVal').textContent=e.target.value+'%'};
$('#deformSmoothness').onchange=()=>commitHistory('调整形变平滑范围');
$('#addDeformPoint').onclick=()=>{const o=selected();if(!isFillShape(o)||!o.deformEnabled||o.locked)return;deformAddMode=!deformAddMode;$('#addDeformPoint').classList.toggle('active',deformAddMode);setDataStatus(deformAddMode?'点击或双击对象轮廓以增加形变点':'已退出增加形变点模式','ok')};
$('#deleteDeformPoint').onclick=()=>{if(!deleteSelectedDeformPoint())setDataStatus('请先选中一个紫色形变点','err')};
$('#resetDeform').onclick=()=>{mutateSelected(o=>{if(isFillShape(o)){ensureDeformPoints(o).forEach(p=>{p.dx=0;p.dy=0})}},true);commitHistory('重置形变')};
$('#objW').oninput=e=>mutateSelected(o=>{if(o.type!=='box')return;const ratio=o.w/Math.max(1,o.h),w=Math.max(20,+e.target.value||20);o.w=w;if(o.lockAspect&&!isLine(o))o.h=Math.max(20,w/ratio)},true);
$('#objH').oninput=e=>mutateSelected(o=>{if(o.type!=='box'||isLine(o))return;const ratio=o.w/Math.max(1,o.h),h=Math.max(20,+e.target.value||20);o.h=h;if(o.lockAspect)o.w=Math.max(20,h*ratio)},true);
[['radiusTL','tl'],['radiusTR','tr'],['radiusBR','br'],['radiusBL','bl']].forEach(([id,key])=>{$('#'+id).oninput=e=>mutateSelected(o=>{if(isFillShape(o)&&!isEllipse(o)){o.cornerRadii=o.cornerRadii||cornerRadii(o);o.cornerRadii[key]=Math.max(0,+e.target.value||0);o.radius=o.cornerRadii.tl}})});
$('#syncCorners').onclick=()=>{mutateSelected(o=>{if(isFillShape(o)&&!isEllipse(o)){const v=Math.max(0,+$('#radiusTL').value||0);o.cornerRadii={tl:v,tr:v,br:v,bl:v};o.radius=v}},true);commitHistory('同步四角圆角')};
$('#gradientType').onchange=e=>mutateSelected(o=>{if(isFillShape(o)){o.gradientType=e.target.value;$('#angleRow').style.display=o.gradientType==='radial'?'none':''}},true);
$('#bgOpacity').oninput=e=>{mutateSelected(o=>{if(isFillShape(o))o.bgOpacity=+e.target.value/100});$('#bgOpacityVal').textContent=e.target.value+'%'};
$('#angle').oninput=e=>{mutateSelected(o=>{if(isFillShape(o))o.angle=+e.target.value});$('#angleVal').textContent=e.target.value+'°'};
$('#addColor').onclick=()=>{mutateSelected(o=>{if(isFillShape(o))o.colors.push({c:'#ffffff',p:100})},true);commitHistory('添加对象渐变颜色')};
$('#borderSide').onchange=()=>{const o=selected();if(isFillShape(o))refreshBorderControls(o)};
$('#borderOn').oninput=e=>mutateSelected(o=>{if(isFillShape(o))o.borderOn=e.target.checked});
$('#borderSideOn').oninput=e=>mutateSelected(o=>{if(isFillShape(o)){const b=activeBorderSpec(o);if(b)b.on=e.target.checked}});
$('#borderWidth').oninput=e=>mutateSelected(o=>{if(isFillShape(o)){const b=activeBorderSpec(o);if(b)b.width=Math.max(0,+e.target.value||0);syncLegacyBorderFromTop(o)}});
$('#borderPaint').onchange=e=>{mutateSelected(o=>{if(isFillShape(o)){const b=activeBorderSpec(o);if(b)b.paint=e.target.value}},true);const o=selected();if(isFillShape(o))refreshBorderControls(o)};
$('#borderOpacity').oninput=e=>{mutateSelected(o=>{if(isFillShape(o)){const b=activeBorderSpec(o);if(b)b.opacity=+e.target.value/100;syncLegacyBorderFromTop(o)}});$('#borderOpacityVal').textContent=e.target.value+'%'};
$('#copyBorderToAll').onclick=()=>{mutateSelected(o=>{if(!isFillShape(o))return;const src=structuredClone(activeBorderSpec(o));const borders=ensureBorders(o);BORDER_SIDE_KEYS.forEach(k=>borders[k]=structuredClone(src));syncLegacyBorderFromTop(o)},true);commitHistory('复制边框到四边')};
$('#boxImageOpacity').oninput=e=>{mutateSelected(o=>{if(isFillShape(o))o.imageOpacity=+e.target.value/100});$('#boxImageOpacityVal').textContent=e.target.value+'%'};$('#boxImageFit').onchange=e=>mutateSelected(o=>{if(isFillShape(o))o.imageFit=e.target.value});
$('#lineWidth').oninput=e=>mutateSelected(o=>{if(isLine(o))o.lineWidth=clamp(+e.target.value||1,1,100)},true);
$('#lineOpacity').oninput=e=>{mutateSelected(o=>{if(isLine(o))o.lineOpacity=+e.target.value/100});$('#lineOpacityVal').textContent=e.target.value+'%'};
$('#shadowOn').oninput=e=>mutateSelected(o=>{if(o.type==='box')o.shadowOn=e.target.checked});
$('#shadowX').oninput=e=>mutateSelected(o=>{if(o.type==='box')o.shadowX=clamp(finiteNumber(e.target.value,0),-200,200)});
$('#shadowY').oninput=e=>mutateSelected(o=>{if(o.type==='box')o.shadowY=clamp(finiteNumber(e.target.value,0),-200,200)});
$('#shadowBlur').oninput=e=>mutateSelected(o=>{if(o.type==='box')o.shadowBlur=clamp(finiteNumber(e.target.value,0),0,200)});
$('#shadowSpread').oninput=e=>mutateSelected(o=>{if(o.type==='box')o.shadowSpread=clamp(finiteNumber(e.target.value,0),-100,200)});
$('#shadowOpacity').oninput=e=>{mutateSelected(o=>{if(o.type==='box')o.shadowOpacity=+e.target.value/100});$('#shadowOpacityVal').textContent=e.target.value+'%'};
$('#innerShadowOn').oninput=e=>mutateSelected(o=>{if(isFillShape(o))o.innerShadowOn=e.target.checked});
$('#innerShadowX').oninput=e=>mutateSelected(o=>{if(isFillShape(o))o.innerShadowX=clamp(finiteNumber(e.target.value,0),-200,200)});
$('#innerShadowY').oninput=e=>mutateSelected(o=>{if(isFillShape(o))o.innerShadowY=clamp(finiteNumber(e.target.value,0),-200,200)});
$('#innerShadowBlur').oninput=e=>mutateSelected(o=>{if(isFillShape(o))o.innerShadowBlur=clamp(finiteNumber(e.target.value,0),0,200)});
$('#innerShadowSpread').oninput=e=>mutateSelected(o=>{if(isFillShape(o))o.innerShadowSpread=clamp(finiteNumber(e.target.value,0),-100,200)});
$('#innerShadowOpacity').oninput=e=>{mutateSelected(o=>{if(isFillShape(o))o.innerShadowOpacity=+e.target.value/100});$('#innerShadowOpacityVal').textContent=e.target.value+'%'};
$('#textContent').oninput=e=>mutateSelected(o=>o.content=e.target.value);$('#fontSize').oninput=e=>mutateSelected(o=>o.fontSize=clamp(+e.target.value||6,6,400));$('#textOpacity').oninput=e=>{mutateSelected(o=>o.opacity=+e.target.value/100);$('#textOpacityVal').textContent=e.target.value+'%'};$('#fontWeight').oninput=e=>mutateSelected(o=>o.fontWeight=e.target.value);$('#fontFamily').oninput=e=>mutateSelected(o=>o.fontFamily=e.target.value);

function readFileAsDataURL(file){return new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(r.result);r.onerror=()=>reject(r.error||new Error('读取文件失败'));r.readAsDataURL(file)})}
$('#boxImageUpload').onclick=()=>{const o=selected();if(isFillShape(o)&&!o.locked&&!hasMultiBoxes())$('#boxImageFile').click()};
$('#boxImageFile').onchange=async e=>{const file=e.target.files?.[0],o=selected();if(file&&isFillShape(o)&&!o.locked&&!hasMultiBoxes()){const data=await readFileAsDataURL(file),ref=registerImageAsset(data);await ensureImagePreview(ref);o.imageRef=ref;renderObjects();commitHistory('设置图形背景图片')}e.target.value=''};
$('#boxImageRemove').onclick=()=>{mutateSelected(o=>{if(isFillShape(o))o.imageRef=null},true);commitHistory('移除图形背景图片')};
$('#canvasImageUpload').onclick=()=>$('#canvasImageFile').click();
$('#canvasImageFile').onchange=async e=>{const file=e.target.files?.[0];if(file){const data=await readFileAsDataURL(file),ref=registerImageAsset(data);await ensureImagePreview(ref);state.canvasImageRef=ref;renderObjects(false);commitHistory('设置画布背景图片')}e.target.value=''};
$('#canvasImageRemove').onclick=()=>{state.canvasImageRef=null;renderObjects(false);refreshCanvasControls();commitHistory('移除画布背景图片')};
$('#canvasImageOpacity').oninput=e=>{state.canvasImageOpacity=+e.target.value/100;$('#canvasImageOpacityVal').textContent=e.target.value+'%';renderObjects(false)};
$('#canvasImageFit').onchange=e=>{state.canvasImageFit=e.target.value;renderObjects(false)};

function addObject(o,label='添加对象'){state.objects.push(o);selectObject(o,false);renderObjects();commitHistory(label)}
$('#addBox').onclick=()=>addObject(defaultBox(),'添加方框');$('#addText').onclick=()=>addObject(defaultText(),'添加文字');$('#addCircle').onclick=()=>addObject(defaultCircle(),'添加圆形');$('#addLine').onclick=()=>addObject(defaultLine(),'添加直线');
function deleteSelected(){
  let removed=0;
  if(state.selectedBoxIds.length){
    const ids=new Set(state.selectedBoxIds),before=state.objects.length;
    state.objects=state.objects.filter(o=>!(ids.has(o.id)&&!o.locked));
    removed=before-state.objects.length;syncSelectionValidity();state.selectedId=state.selectedBoxIds.at(-1)||null
  }else if(state.selectedId!=null){
    const o=selected();if(o?.locked){setDataStatus('锁定对象不能删除','err');return}
    const before=state.objects.length;state.objects=state.objects.filter(x=>x.id!==state.selectedId);removed=before-state.objects.length;state.selectedId=null
  }
  if(!removed){setDataStatus('没有可删除的未锁定对象','err');renderObjects();return}
  renderObjects();commitHistory('删除对象')
}
$('#deleteObj').onclick=deleteSelected;
function duplicateSelection(){
  const items=selectedObjects();
  if(items.length){boxClipboard={boxes:items.map(o=>structuredClone(o))};pasteSelectedBoxes();return}
  const o=selected();if(!o)return;const n=structuredClone(o);n.id=uid();n.x+=24;n.y+=24;addObject(n,'复制对象')
}

function alignBoxes(kind){
  const items=editableSelectedObjects();if(items.length<2)return;
  const rects=items.map(o=>({o,b:getObjectBounds(o)}));
  if(kind==='left'){const v=Math.min(...rects.map(r=>r.b.x));rects.forEach(r=>r.o.x+=v-r.b.x)}
  if(kind==='right'){const v=Math.max(...rects.map(r=>r.b.x+r.b.w));rects.forEach(r=>r.o.x+=v-(r.b.x+r.b.w))}
  if(kind==='top'){const v=Math.min(...rects.map(r=>r.b.y));rects.forEach(r=>r.o.y+=v-r.b.y)}
  if(kind==='bottom'){const v=Math.max(...rects.map(r=>r.b.y+r.b.h));rects.forEach(r=>r.o.y+=v-(r.b.y+r.b.h))}
  if(kind==='centerX'){const left=Math.min(...rects.map(r=>r.b.x)),right=Math.max(...rects.map(r=>r.b.x+r.b.w)),center=(left+right)/2;rects.forEach(r=>r.o.x+=center-(r.b.x+r.b.w/2))}
  if(kind==='centerY'){const top=Math.min(...rects.map(r=>r.b.y)),bottom=Math.max(...rects.map(r=>r.b.y+r.b.h)),center=(top+bottom)/2;rects.forEach(r=>r.o.y+=center-(r.b.y+r.b.h/2))}
  renderObjects();commitHistory('多选对齐')
}
function distributeBoxes(axis){
  const items=editableSelectedObjects();if(items.length<3)return;
  const rects=items.map(o=>({o,b:getObjectBounds(o)}));
  if(axis==='h'){
    const a=[...rects].sort((x,y)=>x.b.x-y.b.x),start=a[0].b.x,end=a.at(-1).b.x+a.at(-1).b.w,total=a.reduce((s,r)=>s+r.b.w,0),gap=(end-start-total)/(a.length-1);let cur=start;a.forEach(r=>{r.o.x+=cur-r.b.x;cur+=r.b.w+gap})
  }else{
    const a=[...rects].sort((x,y)=>x.b.y-y.b.y),start=a[0].b.y,end=a.at(-1).b.y+a.at(-1).b.h,total=a.reduce((s,r)=>s+r.b.h,0),gap=(end-start-total)/(a.length-1);let cur=start;a.forEach(r=>{r.o.y+=cur-r.b.y;cur+=r.b.h+gap})
  }
  renderObjects();commitHistory(axis==='h'?'水平等间距':'垂直等间距')
}
$('#alignLeft').onclick=()=>alignBoxes('left');$('#alignCenterX').onclick=()=>alignBoxes('centerX');$('#alignRight').onclick=()=>alignBoxes('right');$('#alignTop').onclick=()=>alignBoxes('top');$('#alignCenterY').onclick=()=>alignBoxes('centerY');$('#alignBottom').onclick=()=>alignBoxes('bottom');$('#distributeH').onclick=()=>distributeBoxes('h');$('#distributeV').onclick=()=>distributeBoxes('v');
function openAlignMenu(){clearTimeout(alignCloseTimer);if(!$('#alignMenuButton').disabled)$('#alignPanel').classList.add('open')}
function scheduleAlignClose(){clearTimeout(alignCloseTimer);alignCloseTimer=setTimeout(()=>$('#alignPanel').classList.remove('open'),260)}
$('#alignMenuButton').onclick=e=>{e.stopPropagation();clearTimeout(alignCloseTimer);$('#alignPanel').classList.toggle('open')};
$('#alignPanel').addEventListener('pointerenter',openAlignMenu);
$('#alignPanel').addEventListener('pointerleave',scheduleAlignClose);
document.addEventListener('click',e=>{if(!$('#alignPanel').contains(e.target))$('#alignPanel').classList.remove('open')});

function copySelectedBoxes(){
  const items=selectedObjects();if(!items.length){setDataStatus('请先选择至少一个对象','err');return}
  const minX=Math.min(...items.map(o=>o.x)),minY=Math.min(...items.map(o=>o.y));
  boxClipboard={originX:minX,originY:minY,boxes:items.map(o=>structuredClone(o))};
  refreshRightbar();setDataStatus('已复制 '+items.length+' 个对象','ok')
}
function pasteSelectedBoxes(){
  if(!boxClipboard?.boxes?.length){setDataStatus('当前没有可粘贴的对象','err');return}
  const offset=24,created=boxClipboard.boxes.map(src=>{const o=structuredClone(src);o.id=uid();o.x=src.x+offset;o.y=src.y+offset;return o});
  state.objects.push(...created);state.selectedBoxIds=created.map(o=>o.id);state.selectedId=created.at(-1).id;
  boxClipboard={originX:boxClipboard.originX+offset,originY:boxClipboard.originY+offset,boxes:created.map(o=>structuredClone(o))};
  renderObjects();commitHistory('粘贴对象');setDataStatus('已粘贴 '+created.length+' 个对象','ok')
}
function selectedProjectSnapshot(){
  const items=selectedObjects();if(!items.length)return null;
  const rects=items.map(o=>({o,b:getObjectBounds(o)}));
  const pad=20,minX=Math.min(...rects.map(r=>r.b.x)),minY=Math.min(...rects.map(r=>r.b.y)),maxX=Math.max(...rects.map(r=>r.b.x+r.b.w)),maxY=Math.max(...rects.map(r=>r.b.y+r.b.h));
  const objects=items.map((src,i)=>{const o=structuredClone(src);o.id=i+1;o.x=src.x-minX+pad;o.y=src.y-minY+pad;return o});
  const refs=usedImageAssetRefs(objects,null);
  return{
    format:PROJECT_FORMAT,version:PROJECT_VERSION,savedAt:new Date().toISOString(),
    assets:{images:exportImageAssets(refs),fonts:structuredClone(state.customFonts)},
    canvas:{width:Math.ceil(maxX-minX+pad*2),height:Math.ceil(maxY-minY+pad*2),backgroundOpacity:0,gradientType:'linear',gradientAngle:135,colors:[{c:'#ffffff',p:0},{c:'#ffffff',p:100}],imageRef:null,imageOpacity:1,imageFit:'cover'},
    objects,
    assists:{snapEnabled:true,guidesVisible:true,guides:{vertical:[],horizontal:[]}},
    view:{zoom:1,panX:70,panY:70},
    selectedId:objects.at(-1)?.id||null,selectedBoxIds:objects.map(o=>o.id)
  }
}
$('#copySelected').onclick=copySelectedBoxes;
$('#pasteSelected').onclick=pasteSelectedBoxes;
$('#exportSelectedData').onclick=()=>{
  const data=selectedProjectSnapshot();if(!data){setDataStatus('请先选择至少一个对象','err');return}
  downloadText('canvas-selection-'+Date.now()+'.json',JSON.stringify(data,null,2));
  setDataStatus('已把 '+data.objects.length+' 个对象导出为独立数据','ok')
};

function setSelectedBoxesVisible(visible){
  const items=selectedObjects();if(!items.length)return;items.forEach(o=>o.visible=visible);renderObjects();commitHistory(visible?'显示所选对象':'隐藏所选对象')
}
function setSelectedBoxesLocked(locked){
  const items=selectedObjects();if(!items.length)return;items.forEach(o=>o.locked=locked);renderObjects();commitHistory(locked?'锁定所选对象':'解锁所选对象')
}
function moveObjectLayer(id,where){
  const i=state.objects.findIndex(o=>o.id===id);if(i<0)return;const o=state.objects[i];if(o.locked){setDataStatus('锁定对象不能调整图层顺序','err');return}
  state.objects.splice(i,1);if(where==='front')state.objects.push(o);else state.objects.unshift(o);renderObjects();commitHistory(where==='front'?'对象置顶':'对象置底')
}
function contextItem(label,action,{disabled=false,danger=false,shortcut=''}={}){
  const btn=document.createElement('button');btn.className='context-item'+(danger?' danger':'');btn.disabled=disabled;
  btn.innerHTML=`<span>${label}</span><span class="context-shortcut">${shortcut}</span>`;
  btn.onclick=()=>{hideContextMenu();if(!disabled)action()};return btn
}
function contextSep(){const d=document.createElement('div');d.className='context-sep';return d}
function hideContextMenu(){$('#contextMenu').classList.remove('open')}
function showContextMenu(clientX,clientY,target=null,deformPointId=null){
  const menu=$('#contextMenu');menu.innerHTML='';
  const items=selectedObjects(),multi=items.length>1&&target&&state.selectedBoxIds.includes(target.id);
  if(deformPointId&&isFillShape(target)&&target.deformEnabled){
    selectedDeformPointId=deformPointId;
    menu.append(
      contextItem('重置该形变点',()=>{const p=ensureDeformPoints(target).find(x=>x.id===deformPointId);if(p){p.dx=0;p.dy=0;renderObjects();commitHistory('重置形变点')}}),
      contextItem('删除形变点',deleteSelectedDeformPoint,{danger:true,shortcut:'Delete'})
    )
  }else if(multi){
    const editable=editableSelectedObjects();
    menu.append(
      contextItem('复制所选对象',copySelectedBoxes,{shortcut:'Ctrl+C'}),
      contextItem('导出所选为数据',()=>$('#exportSelectedData').click()),
      contextSep(),
      contextItem('左对齐',()=>alignBoxes('left'),{disabled:editable.length<2}),
      contextItem('水平居中',()=>alignBoxes('centerX'),{disabled:editable.length<2}),
      contextItem('右对齐',()=>alignBoxes('right'),{disabled:editable.length<2}),
      contextItem('上对齐',()=>alignBoxes('top'),{disabled:editable.length<2}),
      contextItem('垂直居中',()=>alignBoxes('centerY'),{disabled:editable.length<2}),
      contextItem('下对齐',()=>alignBoxes('bottom'),{disabled:editable.length<2}),
      contextItem('水平等间距',()=>distributeBoxes('h'),{disabled:editable.length<3}),
      contextItem('垂直等间距',()=>distributeBoxes('v'),{disabled:editable.length<3}),
      contextSep(),
      contextItem('显示所选',()=>setSelectedBoxesVisible(true)),
      contextItem('隐藏所选',()=>setSelectedBoxesVisible(false)),
      contextItem('锁定所选',()=>setSelectedBoxesLocked(true)),
      contextItem('解锁所选',()=>setSelectedBoxesLocked(false)),
      contextSep(),
      contextItem('删除未锁定对象',deleteSelected,{disabled:editable.length<1,danger:true,shortcut:'Delete'})
    )
  }else if(target?.type==='box'){
    const locked=!!target.locked,kind=objectKindName(target);
    menu.append(
      contextItem(target.visible===false?'显示'+kind:'隐藏'+kind,()=>{target.visible=target.visible===false;renderObjects();commitHistory((target.visible?'显示':'隐藏')+kind)}),
      contextItem(locked?'解锁'+kind:'锁定'+kind,()=>{target.locked=!target.locked;renderObjects();commitHistory((target.locked?'锁定':'解锁')+kind)}),
      contextSep(),
      contextItem('复制'+kind,copySelectedBoxes,{shortcut:'Ctrl+C'}),
      contextItem('粘贴对象',pasteSelectedBoxes,{disabled:!boxClipboard,shortcut:'Ctrl+V'}),
      contextItem('复制一份',duplicateSelection,{shortcut:'Ctrl+D'}),
      contextSep(),
      contextItem('置于最上层',()=>moveObjectLayer(target.id,'front'),{disabled:locked}),
      contextItem('置于最下层',()=>moveObjectLayer(target.id,'back'),{disabled:locked}),
      contextSep(),
      contextItem('删除',deleteSelected,{disabled:locked,danger:true,shortcut:'Delete'})
    )
  }else if(target?.type==='text'){
    const locked=!!target.locked;
    menu.append(
      contextItem(target.visible===false?'显示文字':'隐藏文字',()=>{target.visible=target.visible===false;renderObjects();commitHistory(target.visible?'显示文字':'隐藏文字')}),
      contextItem(locked?'解锁文字':'锁定文字',()=>{target.locked=!target.locked;renderObjects();commitHistory(target.locked?'锁定文字':'解锁文字')}),
      contextSep(),
      contextItem('复制一份',duplicateSelection,{shortcut:'Ctrl+D'}),
      contextItem('置于最上层',()=>moveObjectLayer(target.id,'front'),{disabled:locked}),
      contextItem('置于最下层',()=>moveObjectLayer(target.id,'back'),{disabled:locked}),
      contextSep(),
      contextItem('删除',deleteSelected,{disabled:locked,danger:true,shortcut:'Delete'})
    )
  }else{
    menu.append(
      contextItem('添加方框',()=>$('#addBox').click()),
      contextItem('添加圆形',()=>$('#addCircle').click()),
      contextItem('添加直线',()=>$('#addLine').click()),
      contextItem('添加文字',()=>$('#addText').click()),
      contextItem('粘贴对象',pasteSelectedBoxes,{disabled:!boxClipboard,shortcut:'Ctrl+V'}),
      contextSep(),
      contextItem('撤回',undoHistory,{disabled:$('#undoBtn').disabled,shortcut:'Ctrl+Z'}),
      contextItem('反撤回',redoHistory,{disabled:$('#redoBtn').disabled,shortcut:'Ctrl+Y'}),
      contextSep(),
      contextItem('打开画布属性',()=>setSettingsPane('canvas'))
    )
  }
  const wr=document.querySelector('.workspace').getBoundingClientRect();menu.classList.add('open');
  const mr=menu.getBoundingClientRect(),pad=8;
  menu.style.left=clamp(clientX-wr.left,pad,Math.max(pad,wr.width-mr.width-pad))+'px';
  menu.style.top=clamp(clientY-wr.top,pad,Math.max(pad,wr.height-mr.height-pad))+'px'
}
document.querySelector('.workspace').addEventListener('contextmenu',e=>{
  if(e.target.closest('.rightbar-shell,.topbar,.context-menu')){e.preventDefault();return}
  e.preventDefault();showContextMenu(e.clientX,e.clientY,null)
});
document.addEventListener('pointerdown',e=>{if(!$('#contextMenu').contains(e.target))hideContextMenu()});
window.addEventListener('blur',()=>{hideContextMenu();setSpacePanHeld(false);viewport.classList.remove('panning');if(gesture?.type==='pan')gesture=null});

document.addEventListener('keyup',e=>{if(e.code==='Space'){e.preventDefault();setSpacePanHeld(false)}});
document.addEventListener('keydown',e=>{
  const key=e.key.toLowerCase(),mod=e.ctrlKey||e.metaKey,editing=['INPUT','TEXTAREA','SELECT'].includes(document.activeElement.tagName)||document.activeElement?.isContentEditable;
  if(e.code==='Space'&&!editing){e.preventDefault();setSpacePanHeld(true);return}
  if(mod&&key==='z'&&!editing){e.preventDefault();e.shiftKey?redoHistory():undoHistory();return}
  if(mod&&key==='y'&&!editing){e.preventDefault();redoHistory();return}
  if(e.key==='?'&&!editing){e.preventDefault();$('#rightbarShell').classList.toggle('shortcuts-open');return}
  if(editing)return;
  if(mod&&key==='a'){e.preventDefault();state.selectedBoxIds=state.objects.filter(o=>o.visible!==false).map(o=>o.id);state.selectedId=state.selectedBoxIds.at(-1)||null;renderObjects();return}
  if(e.key==='Escape'){e.preventDefault();if(deformAddMode){deformAddMode=false;$('#addDeformPoint').classList.remove('active');setDataStatus('已退出增加形变点模式');return}if(selectedDeformPointId!=null){selectedDeformPointId=null;renderObjects();return}clearSelection();renderObjects();return}
  if(e.key==='Home'){e.preventDefault();const b=selectionBounds();if(b)focusBounds(b,false);else setDataStatus('请先选择对象','err');return}
  if(key==='f'&&!mod&&!e.altKey){e.preventDefault();const b=selectionBounds();if(b)focusBounds(b,true);else setDataStatus('请先选择对象','err');return}
  if((e.key==='Delete'||e.key==='Backspace')&&selectedDeformPointId!=null){e.preventDefault();if(deleteSelectedDeformPoint())return}
  if((e.key==='Delete'||e.key==='Backspace')&&(state.selectedId!=null||state.selectedBoxIds.length)){e.preventDefault();deleteSelected();return}
  if(mod&&key==='d'){e.preventDefault();duplicateSelection();return}
  if(mod&&key==='c'){e.preventDefault();copySelectedBoxes();return}
  if(mod&&key==='v'){e.preventDefault();pasteSelectedBoxes();return}
  if(['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key)){
    const ids=state.selectedBoxIds.length?new Set(state.selectedBoxIds):new Set(state.selectedId?[state.selectedId]:[]);if(!ids.size)return;e.preventDefault();const step=e.shiftKey?10:1;
    state.objects.filter(o=>ids.has(o.id)&&!o.locked).forEach(o=>{if(e.key==='ArrowLeft')o.x-=step;if(e.key==='ArrowRight')o.x+=step;if(e.key==='ArrowUp')o.y-=step;if(e.key==='ArrowDown')o.y+=step});renderObjects();commitHistory('键盘移动对象')
  }
});
document.querySelector('.sidebar').addEventListener('change',e=>{
  const t=e.target;if(historyState.restoring||!t.matches('input,select,textarea')||t.type==='file'||t.id==='exportScale')return;
  commitHistory(t.closest('#canvasSettingsPane')?'修改画布参数':'修改对象参数')
});

function refreshCanvasControls(){
  $('#canvasW').value=state.canvasW;$('#canvasH').value=state.canvasH;
  $('#canvasGradientType').value=state.canvasGradientType||'linear';$('#canvasAngleRow').style.display=(state.canvasGradientType||'linear')==='radial'?'none':'';
  $('#canvasBgOpacity').value=Math.round(state.canvasBgOpacity*100);$('#canvasBgOpacityVal').textContent=Math.round(state.canvasBgOpacity*100)+'%';
  $('#canvasAngle').value=state.canvasAngle;$('#canvasAngleVal').textContent=Math.round(state.canvasAngle)+'°';
  $('#canvasImageOpacity').value=Math.round(state.canvasImageOpacity*100);$('#canvasImageOpacityVal').textContent=Math.round(state.canvasImageOpacity*100)+'%';$('#canvasImageFit').value=state.canvasImageFit;$('#canvasImageRemove').disabled=!state.canvasImageRef;
  renderCanvasColorControls();refreshRightbar()
}
$('#canvasW').onchange=e=>{state.canvasW=clamp(+e.target.value||100,100,10000);updateWorldTransform();renderObjects(false);refreshCanvasControls()};
$('#canvasH').onchange=e=>{state.canvasH=clamp(+e.target.value||100,100,10000);updateWorldTransform();renderObjects(false);refreshCanvasControls()};
$('#canvasGradientType').onchange=e=>{state.canvasGradientType=e.target.value;$('#canvasAngleRow').style.display=state.canvasGradientType==='radial'?'none':'';renderObjects(false)};
$('#canvasBgOpacity').oninput=e=>{state.canvasBgOpacity=+e.target.value/100;$('#canvasBgOpacityVal').textContent=e.target.value+'%';renderObjects(false)};
$('#canvasAngle').oninput=e=>{state.canvasAngle=+e.target.value;$('#canvasAngleVal').textContent=e.target.value+'°';renderObjects(false)};
$('#canvasAddColor').onclick=()=>{state.canvasColors.push({c:'#ffffff',p:100});renderCanvasColorControls();renderObjects(false);commitHistory('添加画布渐变颜色')};
$('#snapEnabled').onclick=()=>{state.snapEnabled=!state.snapEnabled;refreshRightbar();commitHistory(state.snapEnabled?'开启自动吸附':'关闭自动吸附');setDataStatus(state.snapEnabled?'自动吸附已开启':'自动吸附已关闭','ok')};
$('#guidesToggle').onclick=()=>{state.guidesVisible=!state.guidesVisible;renderGuides();refreshRightbar();commitHistory(state.guidesVisible?'显示参考线':'隐藏参考线');setDataStatus(state.guidesVisible?'参考线已显示':'参考线已隐藏','ok')};
$('#clearGuides').onclick=()=>{state.guides={vertical:[],horizontal:[]};renderGuides();commitHistory('清空参考线');setDataStatus('参考线已清空','ok')};

function editableSnapshot(){
  return{
    canvas:{width:state.canvasW,height:state.canvasH,backgroundOpacity:state.canvasBgOpacity,gradientType:state.canvasGradientType,gradientAngle:state.canvasAngle,colors:structuredClone(state.canvasColors),imageRef:state.canvasImageRef,imageOpacity:state.canvasImageOpacity,imageFit:state.canvasImageFit},
    objects:structuredClone(state.objects),
    assists:{snapEnabled:state.snapEnabled,guidesVisible:state.guidesVisible,guides:structuredClone(state.guides)},
    selection:{selectedId:state.selectedId,selectedBoxIds:[...state.selectedBoxIds]}
  }
}
function applyEditableSnapshot(s){
  historyState.restoring=true;
  state.canvasW=s.canvas.width;state.canvasH=s.canvas.height;state.canvasBgOpacity=s.canvas.backgroundOpacity;state.canvasGradientType=s.canvas.gradientType||'linear';state.canvasAngle=s.canvas.gradientAngle;state.canvasColors=structuredClone(s.canvas.colors);state.canvasImageRef=s.canvas.imageRef||null;state.canvasImageOpacity=s.canvas.imageOpacity;state.canvasImageFit=s.canvas.imageFit||'cover';
  state.objects=structuredClone(s.objects);state.nextId=state.objects.reduce((m,o)=>Math.max(m,o.id||0),0)+1;
  state.snapEnabled=s.assists.snapEnabled!==false;state.guidesVisible=s.assists.guidesVisible!==false;state.guides=structuredClone(s.assists.guides||{vertical:[],horizontal:[]});
  state.selectedId=s.selection?.selectedId??null;state.selectedBoxIds=[...(s.selection?.selectedBoxIds||[])];syncSelectionValidity();
  [...usedImageAssetRefs()].forEach(ref=>ensureImagePreview(ref));
  refreshCanvasControls();updateWorldTransform();renderObjects();historyState.restoring=false
}
function historyEntry(id){return historyState.entries.find(e=>e.id===id)||null}
function renderHistory(){
  const list=$('#historyList');list.innerHTML='';
  [...historyState.entries].reverse().forEach((entry,rev)=>{
    const btn=document.createElement('button');btn.className='history-item'+(entry.id===historyState.currentId?' current':'');
    const seq=historyState.entries.length-rev;
    btn.innerHTML=`<span class="history-dot">${seq}</span><span class="history-label">${entry.label}</span><span class="history-time">${new Date(entry.time).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit',second:'2-digit'})}</span>`;
    btn.onclick=e=>{e.stopPropagation();jumpHistory(entry.id)};list.appendChild(btn)
  });
  $('#historyCount').textContent=historyState.entries.length+' / '+historyState.max;refreshRightbar()
}
function commitHistory(label,force=false){
  if(!historyState.ready||historyState.restoring)return;
  const snapshot=editableSnapshot(),serialized=JSON.stringify({canvas:snapshot.canvas,objects:snapshot.objects,assists:snapshot.assists}),current=historyEntry(historyState.currentId);
  if(!force&&current&&current.serialized===serialized)return;
  const entry={id:historyState.nextId++,label,time:Date.now(),snapshot,serialized,parentId:historyState.currentId};
  historyState.entries.push(entry);historyState.currentId=entry.id;historyState.redoStack=[];
  while(historyState.entries.length>historyState.max){
    const removed=historyState.entries.shift();
    historyState.entries.forEach(e=>{if(e.parentId===removed.id)e.parentId=null});
    historyState.redoStack=historyState.redoStack.filter(id=>id!==removed.id)
  }
  cleanupUnusedResources();renderHistory();scheduleDesktopWorkspaceSave()
}
function initHistory(){
  historyState.ready=true;historyState.entries=[];historyState.currentId=null;historyState.redoStack=[];historyState.nextId=1;commitHistory('初始状态',true)
}
function restoreHistory(id){
  const entry=historyEntry(id);if(!entry)return false;applyEditableSnapshot(entry.snapshot);historyState.currentId=id;renderHistory();return true
}
function undoHistory(){
  const current=historyEntry(historyState.currentId);if(!current||current.parentId==null)return;
  const parent=historyEntry(current.parentId);if(!parent)return;
  historyState.redoStack.push(current.id);restoreHistory(parent.id);setDataStatus('已撤回：'+current.label,'ok')
}
function redoHistory(){
  while(historyState.redoStack.length){
    const id=historyState.redoStack.pop();const entry=historyEntry(id);if(entry){restoreHistory(id);setDataStatus('已反撤回：'+entry.label,'ok');return}
  }
}
function jumpHistory(id){
  if(id!==historyState.currentId){historyState.redoStack=[];if(restoreHistory(id))setDataStatus('已跳转到历史记录','ok')}
  $('#rightbarShell').classList.add('history-open');$('.history-group').classList.add('open')
}

const PROJECT_FORMAT='transparent-canvas-editor',PROJECT_VERSION=11;
function projectSnapshot(){return{format:PROJECT_FORMAT,version:PROJECT_VERSION,savedAt:new Date().toISOString(),assets:{images:exportImageAssets(),fonts:structuredClone(state.customFonts)},canvas:{width:state.canvasW,height:state.canvasH,backgroundOpacity:state.canvasBgOpacity,gradientType:state.canvasGradientType,gradientAngle:state.canvasAngle,colors:structuredClone(state.canvasColors),imageRef:state.canvasImageRef,imageOpacity:state.canvasImageOpacity,imageFit:state.canvasImageFit},objects:structuredClone(state.objects),assists:{snapEnabled:state.snapEnabled,guidesVisible:state.guidesVisible,guides:structuredClone(state.guides)},view:{zoom:state.zoom,panX:state.panX,panY:state.panY},selectedId:state.selectedId,selectedBoxIds:[...state.selectedBoxIds]}}
function setDataStatus(msg,type='',duration=1800){
  const el=$('#dataStatus');clearTimeout(statusTimer);el.textContent=msg;el.className='right-status show'+(type?' '+type:'');
  statusTimer=setTimeout(()=>{el.className='right-status'},duration)
}
function downloadText(filename,text,mime='application/json'){const blob=new Blob([text],{type:mime}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=filename;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),500)}
function defaultProjectFilename(){
  const d=new Date(),p=n=>String(n).padStart(2,'0');
  return `canvas-project-${d.getFullYear()}${p(d.getMonth()+1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.json`
}
$('#exportData').onclick=async()=>{
  const data=projectSnapshot(),raw=JSON.stringify(data,null,2),api=desktopApp();
  if(api?.SaveProjectAs){
    try{
      const path=await api.SaveProjectAs(raw,defaultProjectFilename());
      if(!path){setDataStatus('已取消保存');return}
      setDataStatus('已保存：'+path,'ok',5000);return
    }catch(err){setDataStatus('保存失败：'+(err?.message||err),'err',5000);return}
  }
  downloadText(defaultProjectFilename(),raw);setDataStatus('已导出：'+data.objects.length+' 个图层','ok')
};
$('#workspaceLocation').onclick=async()=>{
  const api=desktopApp();if(!api?.WorkspacePath)return;
  try{
    desktopWorkspacePath=await api.WorkspacePath();
    setDataStatus('自动工作区：'+desktopWorkspacePath,'ok',6500);
    if(api.RevealWorkspace)await api.RevealWorkspace()
  }catch(err){setDataStatus('打开工作区位置失败：'+(err?.message||err),'err',5000)}
};
$('#importData').onclick=()=>$('#importDataFile').click();
function finiteNumber(v,f){v=Number(v);return Number.isFinite(v)?v:f}
function cleanColor(v,f='#ffffff'){return normalizeColorValue(v,f)}
function cleanStops(list,fallback){if(!Array.isArray(list)||!list.length)return structuredClone(fallback);return list.slice(0,32).map((s,i)=>({c:cleanColor(s?.c,i?'#dfe7f2':'#ffffff'),p:clamp(finiteNumber(s?.p,i?100:0),0,100)}))}
function cleanFit(v){return['cover','contain','stretch'].includes(v)?v:'cover'}
function cleanGradientType(v){return v==='radial'?'radial':'linear'}
function cleanShape(v){return['rect','ellipse','line'].includes(v)?v:'rect'}
function cleanBorderSpec(raw,fallbackColor,fallbackWidth,fallbackOpacity){
  raw=raw&&typeof raw==='object'?raw:{};
  const c1=cleanColor(raw.color1??raw.color,fallbackColor),c2=cleanColor(raw.color2,c1);
  return{on:raw.on!==false,width:Math.max(0,finiteNumber(raw.width,fallbackWidth)),opacity:clamp(finiteNumber(raw.opacity,fallbackOpacity),0,1),paint:['solid','linear','radial'].includes(raw.paint)?raw.paint:'solid',color1:c1,color2:c2}
}
function cleanBorders(rawBorders,color,width,opacity){
  const out={};BORDER_SIDE_KEYS.forEach(k=>out[k]=cleanBorderSpec(rawBorders?.[k],color,width,opacity));return out
}
function cleanDeformPointList(rawPoints,shape,legacy){
  let points=Array.isArray(rawPoints)?rawPoints.slice(0,128).map((p,i)=>({id:Math.max(1,Math.floor(finiteNumber(p?.id,i+1))),side:shape==='ellipse'?'ellipse':(BORDER_SIDE_KEYS.includes(p?.side)?p.side:'top'),t:clamp(finiteNumber(p?.t,.5),0,1),dx:clamp(finiteNumber(p?.dx,0),-20000,20000),dy:clamp(finiteNumber(p?.dy,0),-20000,20000)})):[];
  if(!Array.isArray(rawPoints)){
    points=defaultDeformPoints(shape).map(p=>({...p}));
    const d=legacy||{};
    if(shape==='ellipse'){const vals=[finiteNumber(d.top,0),finiteNumber(d.right,0),finiteNumber(d.bottom,0),finiteNumber(d.left,0)],vec=[[0,-1],[1,0],[0,1],[-1,0]];points.forEach((p,i)=>{p.dx=vec[i][0]*vals[i];p.dy=vec[i][1]*vals[i]})}
    else{const map={top:[0,-finiteNumber(d.top,0)],right:[finiteNumber(d.right,0),0],bottom:[0,finiteNumber(d.bottom,0)],left:[-finiteNumber(d.left,0),0]};points.forEach(p=>{[p.dx,p.dy]=map[p.side]})}
  }
  const used=new Set();let next=1;points.forEach(p=>{while(used.has(p.id))p.id=++next;used.add(p.id);next=Math.max(next,p.id)});return{points,nextId:next+1}
}
function normalizeObject(raw,idFallback,assetAliases=new Map()){
  if(!raw||!['box','text'].includes(raw.type))return null;const id=Math.max(1,Math.floor(finiteNumber(raw.id,idFallback)));
  if(raw.type==='box'){
    const shape=cleanShape(raw.shape),legacyRef=typeof raw.image==='string'?registerImageAsset(raw.image):null;
    const imageRef=shape==='line'?null:(assetAliases.get(raw.imageRef)||raw.imageRef||legacyRef||null),defaultName=shape==='ellipse'?'圆形':shape==='line'?'直线':'方框';
    const legacyInner=shape!=='line'&&raw.shadowType==='inner'&&raw.shadowOn===true;
    const outerDefaultY=shape==='line'?6:(shape==='ellipse'?12:16),outerDefaultBlur=shape==='line'?12:(shape==='ellipse'?28:34),outerDefaultColor=shape==='ellipse'?'#315887':shape==='line'?'#111827':'#232e3f';
    const innerDefaultColor=shape==='ellipse'?'#315887':'#000000';
    const legacyRadius=Math.max(0,finiteNumber(raw.radius,shape==='ellipse'?120:28)),cr=raw.cornerRadii&&typeof raw.cornerRadii==='object'?raw.cornerRadii:{};
    const cornerRadii={tl:Math.max(0,finiteNumber(cr.tl,legacyRadius)),tr:Math.max(0,finiteNumber(cr.tr,legacyRadius)),br:Math.max(0,finiteNumber(cr.br,legacyRadius)),bl:Math.max(0,finiteNumber(cr.bl,legacyRadius))};
    const legacyBorderColor=cleanColor(raw.borderColor,shape==='ellipse'?'#8fb6ff':'#ffffff'),legacyBorderWidth=Math.max(0,finiteNumber(raw.borderWidth,2)),legacyBorderOpacity=clamp(finiteNumber(raw.borderOpacity,.9),0,1),borders=cleanBorders(raw.borders,legacyBorderColor,legacyBorderWidth,legacyBorderOpacity);
    const cleanedDeform=shape==='line'?{points:[],nextId:1}:cleanDeformPointList(raw.deformPoints,shape,raw.deform);
    return{
      id,type:'box',shape,name:typeof raw.name==='string'?raw.name:defaultName,visible:raw.visible!==false,locked:raw.locked===true,rotation:finiteNumber(raw.rotation,0),lockAspect:shape!=='line'&&raw.lockAspect===true,
      x:finiteNumber(raw.x,180),y:finiteNumber(raw.y,150),w:Math.max(20,finiteNumber(raw.w,shape==='line'?300:420)),h:shape==='line'?20:Math.max(20,finiteNumber(raw.h,shape==='ellipse'?240:300)),
      radius:legacyRadius,cornerRadii,bgOpacity:clamp(finiteNumber(raw.bgOpacity,.88),0,1),gradientType:cleanGradientType(raw.gradientType),angle:finiteNumber(raw.angle,135),colors:cleanStops(raw.colors,[{c:'#f7f8fa',p:0},{c:'#d9dde2',p:55},{c:'#bfc5cb',p:100}]),
      imageRef,imageOpacity:clamp(finiteNumber(raw.imageOpacity,1),0,1),imageFit:cleanFit(raw.imageFit),borderOn:shape==='line'?false:raw.borderOn!==false,borderWidth:legacyBorderWidth,borderColor:legacyBorderColor,borderOpacity:legacyBorderOpacity,borders,
      shadowOn:legacyInner?false:(shape==='line'?raw.shadowOn===true:raw.shadowOn!==false),
      shadowX:legacyInner?0:clamp(finiteNumber(raw.shadowX,0),-200,200),
      shadowY:legacyInner?outerDefaultY:clamp(finiteNumber(raw.shadowY,outerDefaultY),-200,200),
      shadowBlur:legacyInner?outerDefaultBlur:clamp(finiteNumber(raw.shadowBlur,outerDefaultBlur),0,200),
      shadowSpread:legacyInner?0:clamp(finiteNumber(raw.shadowSpread,0),-100,200),
      shadowColor:legacyInner?outerDefaultColor:cleanColor(raw.shadowColor,outerDefaultColor),
      shadowOpacity:legacyInner?(shape==='line'?.3:.22):clamp(finiteNumber(raw.shadowOpacity,shape==='line'?.3:.22),0,1),
      innerShadowOn:shape!=='line'&&(raw.innerShadowOn===true||legacyInner),
      innerShadowX:clamp(finiteNumber(raw.innerShadowX,legacyInner?raw.shadowX:0),-200,200),
      innerShadowY:clamp(finiteNumber(raw.innerShadowY,legacyInner?raw.shadowY:4),-200,200),
      innerShadowBlur:clamp(finiteNumber(raw.innerShadowBlur,legacyInner?raw.shadowBlur:12),0,200),
      innerShadowSpread:clamp(finiteNumber(raw.innerShadowSpread,legacyInner?raw.shadowSpread:0),-100,200),
      innerShadowColor:cleanColor(raw.innerShadowColor,legacyInner?cleanColor(raw.shadowColor,innerDefaultColor):innerDefaultColor),
      innerShadowOpacity:clamp(finiteNumber(raw.innerShadowOpacity,legacyInner?raw.shadowOpacity:(shape==='ellipse'?.16:.18)),0,1),
      deformEnabled:shape!=='line'&&raw.deformEnabled===true,
      deformSmoothness:clamp(finiteNumber(raw.deformSmoothness,58),20,90),
      deform:shape==='line'?{top:0,right:0,bottom:0,left:0}:{top:clamp(finiteNumber(raw.deform?.top,0),-20000,20000),right:clamp(finiteNumber(raw.deform?.right,0),-20000,20000),bottom:clamp(finiteNumber(raw.deform?.bottom,0),-20000,20000),left:clamp(finiteNumber(raw.deform?.left,0),-20000,20000)},deformPoints:cleanedDeform.points,nextDeformPointId:cleanedDeform.nextId,
      lineColor:cleanColor(raw.lineColor,'#2563eb'),lineWidth:clamp(finiteNumber(raw.lineWidth,4),1,100),lineOpacity:clamp(finiteNumber(raw.lineOpacity,1),0,1)
    }
  }
  return{id,type:'text',name:typeof raw.name==='string'?raw.name:'文字',visible:raw.visible!==false,locked:raw.locked===true,rotation:finiteNumber(raw.rotation,0),x:finiteNumber(raw.x,260),y:finiteNumber(raw.y,230),content:typeof raw.content==='string'?raw.content:'文字',fontSize:clamp(finiteNumber(raw.fontSize,48),6,400),color:cleanColor(raw.color,'#111827'),opacity:clamp(finiteNumber(raw.opacity,1),0,1),fontWeight:['400','500','600','700'].includes(String(raw.fontWeight))?String(raw.fontWeight):'400',fontFamily:typeof raw.fontFamily==='string'?raw.fontFamily:'"Microsoft YaHei",sans-serif'}
}
async function loadProjectData(data){
  if(!data||typeof data!=='object')throw new Error('JSON 根节点不是对象');const canvas=data.canvas&&typeof data.canvas==='object'?data.canvas:data,rawObjects=Array.isArray(data.objects)?data.objects:[];
  const aliases=importImageAssets(data.assets?.images);
  const legacyCanvasRef=typeof canvas.image==='string'?registerImageAsset(canvas.image):null;
  state.canvasW=clamp(finiteNumber(canvas.width??data.canvasW,1600),100,10000);state.canvasH=clamp(finiteNumber(canvas.height??data.canvasH,1000),100,10000);state.canvasBgOpacity=clamp(finiteNumber(canvas.backgroundOpacity??data.canvasBgOpacity,0),0,1);state.canvasGradientType=cleanGradientType(canvas.gradientType??data.canvasGradientType);state.canvasAngle=finiteNumber(canvas.gradientAngle??data.canvasAngle,135);state.canvasColors=cleanStops(canvas.colors??data.canvasColors,[{c:'#ffffff',p:0},{c:'#dfe7f2',p:100}]);state.canvasImageRef=aliases.get(canvas.imageRef)||canvas.imageRef||legacyCanvasRef||null;state.canvasImageOpacity=clamp(finiteNumber(canvas.imageOpacity,1),0,1);state.canvasImageFit=cleanFit(canvas.imageFit);
  const used=new Set();let seed=1;state.objects=rawObjects.map(raw=>{let o=normalizeObject(raw,seed++,aliases);if(!o)return null;while(used.has(o.id))o.id=seed++;used.add(o.id);return o}).filter(Boolean);state.nextId=state.objects.reduce((m,o)=>Math.max(m,o.id),0)+1;
  state.customFonts=Array.isArray(data.assets?.fonts)?structuredClone(data.assets.fonts):[];await restoreCustomFonts();
  const assists=data.assists||{};state.snapEnabled=assists.snapEnabled!==false;state.guidesVisible=assists.guidesVisible!==false;const gs=assists.guides||{};state.guides={vertical:Array.isArray(gs.vertical)?gs.vertical.map(v=>finiteNumber(v,NaN)).filter(Number.isFinite):[],horizontal:Array.isArray(gs.horizontal)?gs.horizontal.map(v=>finiteNumber(v,NaN)).filter(Number.isFinite):[]};
  const view=data.view||data;state.zoom=clamp(finiteNumber(view.zoom,1),.1,5);state.panX=finiteNumber(view.panX,70);state.panY=finiteNumber(view.panY,70);
  state.selectedBoxIds=Array.isArray(data.selectedBoxIds)?data.selectedBoxIds.map(Number).filter(id=>state.objects.some(o=>o.id===id)):[];const wanted=finiteNumber(data.selectedId,NaN);state.selectedId=state.objects.some(o=>o.id===wanted)?wanted:(state.selectedBoxIds.at(-1)||state.objects[0]?.id||null);syncSelectionValidity();
  await Promise.all([...usedImageAssetRefs()].map(ref=>ensureImagePreview(ref)));refreshCanvasControls();updateWorldTransform();renderObjects()
}
$('#importDataFile').onchange=async e=>{const file=e.target.files?.[0];if(!file)return;try{await loadProjectData(JSON.parse(await file.text()));commitHistory('加载项目数据');setDataStatus('已导入：'+state.objects.length+' 个图层','ok')}catch(err){setDataStatus('导入失败：'+(err?.message||'JSON 无效'),'err')}finally{e.target.value=''}};

function textMetrics(ctx,o){ctx.save();ctx.font=`${o.fontWeight} ${o.fontSize}px ${o.fontFamily}`;let w=0;const lines=o.content.split('\n');lines.forEach(l=>w=Math.max(w,ctx.measureText(l||' ').width));ctx.restore();return{w,h:Math.max(o.fontSize*1.2,lines.length*o.fontSize*1.2)}}
function contentBounds(){const visible=state.objects.filter(o=>o.visible!==false);if(!visible.length)return{x:0,y:0,w:state.canvasW,h:state.canvasH};let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;visible.forEach(o=>{let b=getObjectBounds(o);if(isFillShape(o)&&o.borderOn){const m=maxBorderWidth(o)/2;b={x:b.x-m,y:b.y-m,w:b.w+m*2,h:b.h+m*2}}if(o.type==='box'&&o.shadowOn){const reach=Math.max(0,finiteNumber(o.shadowBlur,0)*2+finiteNumber(o.shadowSpread,0))+Math.hypot(finiteNumber(o.shadowX,0),finiteNumber(o.shadowY,0));b={x:b.x-reach,y:b.y-reach,w:b.w+reach*2,h:b.h+reach*2}}minX=Math.min(minX,b.x);minY=Math.min(minY,b.y);maxX=Math.max(maxX,b.x+b.w);maxY=Math.max(maxY,b.y+b.h)});const p=10;return{x:Math.floor(minX-p),y:Math.floor(minY-p),w:Math.ceil(maxX-minX+2*p),h:Math.ceil(maxY-minY+2*p)}}
function appendRoundedRectPath4(ctx,o,inset=0){
  const x=o.x+inset,y=o.y+inset,w=Math.max(.01,o.w-inset*2),h=Math.max(.01,o.h-inset*2),r=normalizedCornerRadii(o,inset);
  ctx.moveTo(x+r.tl,y);ctx.lineTo(x+w-r.tr,y);ctx.arcTo(x+w,y,x+w,y+r.tr,r.tr);ctx.lineTo(x+w,y+h-r.br);ctx.arcTo(x+w,y+h,x+w-r.br,y+h,r.br);ctx.lineTo(x+r.bl,y+h);ctx.arcTo(x,y+h,x,y+h-r.bl,r.bl);ctx.lineTo(x,y+r.tl);ctx.arcTo(x,y,x+r.tl,y,r.tl);ctx.closePath()
}
function deformRange(o){return .055+clamp(finiteNumber(o.deformSmoothness,58),20,90)/100*.38}
function smoothKernel(distance,range){if(distance>=range)return 0;const q=distance/range;return .5+.5*Math.cos(Math.PI*q)}
function rectDeformAt(o,side,t,excludeId=null){
  let dx=0,dy=0;const range=deformRange(o),edgeFade=Math.max(0,Math.min(1,t/.12,(1-t)/.12));
  ensureDeformPoints(o).forEach(p=>{if(p.side!==side||p.id===excludeId)return;const w=smoothKernel(Math.abs(t-p.t),range)*edgeFade;dx+=p.dx*w;dy+=p.dy*w});return{dx,dy}
}
function ellipseDeformAt(o,t,excludeId=null){
  let dx=0,dy=0;const range=deformRange(o);
  ensureDeformPoints(o).forEach(p=>{if(p.side!=='ellipse'||p.id===excludeId)return;const d=Math.abs(t-p.t),cd=Math.min(d,1-d),w=smoothKernel(cd,range);dx+=p.dx*w;dy+=p.dy*w});return{dx,dy}
}
function rectSideBase(o,side,t,inset=0){
  const x=o.x+inset,y=o.y+inset,w=Math.max(.01,o.w-inset*2),h=Math.max(.01,o.h-inset*2),r=normalizedCornerRadii(o,inset);
  if(side==='top')return{x:x+r.tl+t*Math.max(0,w-r.tl-r.tr),y};
  if(side==='right')return{x:x+w,y:y+r.tr+t*Math.max(0,h-r.tr-r.br)};
  if(side==='bottom')return{x:x+w-r.br-t*Math.max(0,w-r.br-r.bl),y:y+h};
  return{x,y:y+h-r.bl-t*Math.max(0,h-r.bl-r.tl)}
}
function appendDeformedRectPath(ctx,o,inset=0){
  const x=o.x+inset,y=o.y+inset,w=Math.max(.01,o.w-inset*2),h=Math.max(.01,o.h-inset*2),r=normalizedCornerRadii(o,inset),steps=32;
  const appendSide=side=>{for(let i=0;i<=steps;i++){const t=i/steps,b=rectSideBase(o,side,t,inset),d=rectDeformAt(o,side,t);if(i===0&&side==='top')ctx.moveTo(b.x+d.dx,b.y+d.dy);else if(i>0||side!=='top')ctx.lineTo(b.x+d.dx,b.y+d.dy)}};
  appendSide('top');ctx.arcTo(x+w,y,x+w,y+r.tr,r.tr);
  appendSide('right');ctx.arcTo(x+w,y+h,x+w-r.br,y+h,r.br);
  appendSide('bottom');ctx.arcTo(x,y+h,x,y+h-r.bl,r.bl);
  appendSide('left');ctx.arcTo(x,y,x+r.tl,y,r.tl);ctx.closePath()
}
function appendDeformedEllipsePath(ctx,o,inset=0){
  const x=o.x+inset,y=o.y+inset,w=Math.max(.01,o.w-inset*2),h=Math.max(.01,o.h-inset*2),cx=x+w/2,cy=y+h/2,steps=128;
  for(let i=0;i<steps;i++){const t=i/steps,a=-Math.PI/2+t*Math.PI*2,d=ellipseDeformAt(o,t),px=cx+Math.cos(a)*w/2+d.dx,py=cy+Math.sin(a)*h/2+d.dy;if(i===0)ctx.moveTo(px,py);else ctx.lineTo(px,py)}ctx.closePath()
}
function appendShapeSubpath(ctx,o,inset=0){
  const x=o.x+inset,y=o.y+inset,w=Math.max(.01,o.w-inset*2),h=Math.max(.01,o.h-inset*2);
  if(o.deformEnabled&&isFillShape(o)){if(isEllipse(o))appendDeformedEllipsePath(ctx,o,inset);else appendDeformedRectPath(ctx,o,inset);return}
  if(isEllipse(o)){ctx.moveTo(x+w,y+h/2);ctx.ellipse(x+w/2,y+h/2,w/2,h/2,0,0,Math.PI*2);ctx.closePath()}
  else appendRoundedRectPath4(ctx,o,inset)
}
function beginShapePath(ctx,o,inset=0){ctx.beginPath();appendShapeSubpath(ctx,o,inset)}
function rectSidePoint(o,side,t){
  const b=rectSideBase(o,side,t,0),d=o.deformEnabled?rectDeformAt(o,side,t):{dx:0,dy:0};return{x:b.x+d.dx,y:b.y+d.dy}
}
function ellipsePoint(o,t){
  t=((t%1)+1)%1;const a=-Math.PI/2+t*Math.PI*2,d=o.deformEnabled?ellipseDeformAt(o,t):{dx:0,dy:0};return{x:o.x+o.w/2+Math.cos(a)*o.w/2+d.dx,y:o.y+o.h/2+Math.sin(a)*o.h/2+d.dy}
}
function appendRectBorderSidePath(ctx,o,side){
  const x=o.x,y=o.y,w=o.w,h=o.h,r=normalizedCornerRadii(o),steps=28,arc=(cx,cy,rad,a0,a1)=>{if(rad>0)ctx.arc(cx,cy,rad,a0,a1);else ctx.lineTo(cx,cy)};
  if(side==='top'){
    const s=r.tl?{x:x+r.tl+Math.cos(Math.PI*1.25)*r.tl,y:y+r.tl+Math.sin(Math.PI*1.25)*r.tl}:{x,y};ctx.moveTo(s.x,s.y);arc(x+r.tl,y+r.tl,r.tl,Math.PI*1.25,Math.PI*1.5);
    for(let i=0;i<=steps;i++){const p=rectSidePoint(o,'top',i/steps);ctx.lineTo(p.x,p.y)}arc(x+w-r.tr,y+r.tr,r.tr,Math.PI*1.5,Math.PI*1.75)
  }else if(side==='right'){
    const s=r.tr?{x:x+w-r.tr+Math.cos(Math.PI*1.75)*r.tr,y:y+r.tr+Math.sin(Math.PI*1.75)*r.tr}:{x:x+w,y};ctx.moveTo(s.x,s.y);arc(x+w-r.tr,y+r.tr,r.tr,Math.PI*1.75,Math.PI*2);
    for(let i=0;i<=steps;i++){const p=rectSidePoint(o,'right',i/steps);ctx.lineTo(p.x,p.y)}arc(x+w-r.br,y+h-r.br,r.br,0,Math.PI*.25)
  }else if(side==='bottom'){
    const s=r.br?{x:x+w-r.br+Math.cos(Math.PI*.25)*r.br,y:y+h-r.br+Math.sin(Math.PI*.25)*r.br}:{x:x+w,y:y+h};ctx.moveTo(s.x,s.y);arc(x+w-r.br,y+h-r.br,r.br,Math.PI*.25,Math.PI*.5);
    for(let i=0;i<=steps;i++){const p=rectSidePoint(o,'bottom',i/steps);ctx.lineTo(p.x,p.y)}arc(x+r.bl,y+h-r.bl,r.bl,Math.PI*.5,Math.PI*.75)
  }else{
    const s=r.bl?{x:x+r.bl+Math.cos(Math.PI*.75)*r.bl,y:y+h-r.bl+Math.sin(Math.PI*.75)*r.bl}:{x,y:y+h};ctx.moveTo(s.x,s.y);arc(x+r.bl,y+h-r.bl,r.bl,Math.PI*.75,Math.PI);
    for(let i=0;i<=steps;i++){const p=rectSidePoint(o,'left',i/steps);ctx.lineTo(p.x,p.y)}arc(x+r.tl,y+r.tl,r.tl,Math.PI,Math.PI*1.25)
  }
}
function appendEllipseBorderSidePath(ctx,o,side){
  const ranges={top:[.875,1.125],right:[.125,.375],bottom:[.375,.625],left:[.625,.875]},[a,b]=ranges[side],steps=40;
  for(let i=0;i<=steps;i++){const p=ellipsePoint(o,a+(b-a)*i/steps);if(i===0)ctx.moveTo(p.x,p.y);else ctx.lineTo(p.x,p.y)}
}
function borderStrokeStyle(ctx,o,side,b){
  const c1=rgba(b.color1,b.opacity),c2=rgba(b.color2,b.opacity);if(b.paint==='solid')return c1;
  const cx=o.x+o.w/2,cy=o.y+o.h/2;let x1=cx,y1=cy,x2=cx,y2=cy,r=Math.max(1,(side==='top'||side==='bottom'?o.w:o.h)/2),g;
  if(side==='top'){x1=o.x;y1=o.y;x2=o.x+o.w;y2=o.y}
  else if(side==='right'){x1=o.x+o.w;y1=o.y;x2=o.x+o.w;y2=o.y+o.h}
  else if(side==='bottom'){x1=o.x+o.w;y1=o.y+o.h;x2=o.x;y2=o.y+o.h}
  else{x1=o.x;y1=o.y+o.h;x2=o.x;y2=o.y}
  if(b.paint==='radial'){const mx=(x1+x2)/2,my=(y1+y2)/2;g=ctx.createRadialGradient(mx,my,0,mx,my,r)}
  else g=ctx.createLinearGradient(x1,y1,x2,y2);
  g.addColorStop(0,c1);g.addColorStop(1,c2);return g
}
function drawBorders(ctx,o){
  if(!o.borderOn||!isFillShape(o))return;const borders=ensureBorders(o);
  for(const side of BORDER_SIDE_KEYS){const b=borders[side];if(!b.on||b.width<=0||b.opacity<=0)continue;ctx.save();ctx.beginPath();isEllipse(o)?appendEllipseBorderSidePath(ctx,o,side):appendRectBorderSidePath(ctx,o,side);ctx.strokeStyle=borderStrokeStyle(ctx,o,side,b);ctx.lineWidth=b.width;ctx.lineCap='round';ctx.lineJoin='round';ctx.stroke();ctx.restore()}
}
function drawObjectOuterShadow(ctx,o){
  if(!o.shadowOn)return;
  const spread=finiteNumber(o.shadowSpread,0),opacity=clamp(finiteNumber(o.shadowOpacity,.25),0,1);
  if(opacity<=0)return;
  ctx.save();ctx.shadowColor=rgba(o.shadowColor||'#000000',1);ctx.shadowBlur=Math.max(0,finiteNumber(o.shadowBlur,0));ctx.shadowOffsetX=finiteNumber(o.shadowX,0);ctx.shadowOffsetY=finiteNumber(o.shadowY,0);
  if(isLine(o)){
    ctx.strokeStyle=rgba(o.shadowColor||'#000000',opacity);ctx.lineWidth=Math.max(.1,o.lineWidth+spread*2);ctx.lineCap='round';ctx.beginPath();ctx.moveTo(o.x,o.y+o.h/2);ctx.lineTo(o.x+o.w,o.y+o.h/2);ctx.stroke()
  }else{
    ctx.fillStyle=rgba(o.shadowColor||'#000000',opacity);beginShapePath(ctx,o,-spread);ctx.fill()
  }
  ctx.restore()
}
function drawObjectInnerShadow(ctx,o){
  if(!o.innerShadowOn||isLine(o))return;
  const opacity=clamp(finiteNumber(o.innerShadowOpacity,.18),0,1);if(opacity<=0)return;
  const blur=Math.max(0,finiteNumber(o.innerShadowBlur,0)),spread=finiteNumber(o.innerShadowSpread,0),sx=finiteNumber(o.innerShadowX,0),sy=finiteNumber(o.innerShadowY,0),pad=Math.max(16,blur*3+Math.abs(sx)+Math.abs(sy)+Math.abs(spread)+8);
  ctx.save();beginShapePath(ctx,o,0);ctx.clip();ctx.shadowColor=rgba(o.innerShadowColor||'#000000',1);ctx.shadowBlur=blur;ctx.shadowOffsetX=sx;ctx.shadowOffsetY=sy;ctx.fillStyle=rgba(o.innerShadowColor||'#000000',opacity);
  ctx.beginPath();ctx.rect(o.x-pad,o.y-pad,o.w+pad*2,o.h+pad*2);appendShapeSubpath(ctx,o,spread);ctx.fill('evenodd');ctx.restore()
}
function createGradient(ctx,x,y,w,h,colors,angle,type='linear'){const ss=[...colors].sort((a,b)=>a.p-b.p);if(ss.length===1)return ss[0].c;const cx=x+w/2,cy=y+h/2;let g;if(type==='radial'){g=ctx.createRadialGradient(cx,cy,0,cx,cy,Math.max(1,Math.hypot(w,h)/2))}else{const rad=(angle-90)*Math.PI/180,len=Math.abs(w*Math.cos(rad))+Math.abs(h*Math.sin(rad));g=ctx.createLinearGradient(cx-Math.cos(rad)*len/2,cy-Math.sin(rad)*len/2,cx+Math.cos(rad)*len/2,cy+Math.sin(rad)*len/2)}ss.forEach(s=>g.addColorStop(clamp(s.p/100,0,1),s.c));return g}
function loadImage(src){if(!src)return Promise.resolve(null);if(imageCache.has(src))return imageCache.get(src);const p=new Promise((resolve,reject)=>{const im=new Image();im.onload=()=>resolve(im);im.onerror=()=>reject(new Error('图片加载失败'));im.src=src});imageCache.set(src,p);return p}
function drawImageFit(ctx,img,x,y,w,h,fit){
  if(fit==='stretch'){ctx.drawImage(img,x,y,w,h);return}
  const scale=fit==='contain'?Math.min(w/img.width,h/img.height):Math.max(w/img.width,h/img.height),dw=img.width*scale,dh=img.height*scale,dx=x+(w-dw)/2,dy=y+(h-dh)/2;ctx.drawImage(img,dx,dy,dw,dh)
}
async function drawCanvasBackground(ctx){
  ctx.save();ctx.beginPath();ctx.rect(0,0,state.canvasW,state.canvasH);ctx.clip();
  const canvasSrc=imageAssetValue(state.canvasImageRef);if(canvasSrc){const img=await loadImage(canvasSrc);ctx.save();ctx.globalAlpha=state.canvasImageOpacity;drawImageFit(ctx,img,0,0,state.canvasW,state.canvasH,state.canvasImageFit);ctx.restore()}
  if(state.canvasBgOpacity>0){ctx.save();ctx.globalAlpha=state.canvasBgOpacity;ctx.fillStyle=createGradient(ctx,0,0,state.canvasW,state.canvasH,state.canvasColors,state.canvasAngle,state.canvasGradientType);ctx.fillRect(0,0,state.canvasW,state.canvasH);ctx.restore()}
  ctx.restore()
}
async function drawBox(ctx,o){
  ctx.save();
  if(o.rotation){const cx=o.x+o.w/2,cy=o.y+o.h/2;ctx.translate(cx,cy);ctx.rotate((o.rotation||0)*Math.PI/180);ctx.translate(-cx,-cy)}
  drawObjectOuterShadow(ctx,o);
  if(isLine(o)){
    ctx.globalAlpha=o.lineOpacity;ctx.strokeStyle=o.lineColor;ctx.lineWidth=o.lineWidth;ctx.lineCap='round';ctx.beginPath();ctx.moveTo(o.x,o.y+o.h/2);ctx.lineTo(o.x+o.w,o.y+o.h/2);ctx.stroke();ctx.restore();return
  }
  ctx.save();beginShapePath(ctx,o,0);ctx.clip();
  const visual=getUnrotatedVisualRect(o),boxSrc=imageAssetValue(o.imageRef);if(boxSrc){const img=await loadImage(boxSrc);ctx.save();ctx.globalAlpha=o.imageOpacity;drawImageFit(ctx,img,visual.x,visual.y,visual.w,visual.h,o.imageFit);ctx.restore()}
  if(o.bgOpacity>0){ctx.save();ctx.globalAlpha=o.bgOpacity;ctx.fillStyle=createGradient(ctx,visual.x,visual.y,visual.w,visual.h,o.colors,o.angle,o.gradientType);ctx.fillRect(visual.x,visual.y,visual.w,visual.h);ctx.restore()}
  ctx.restore();
  drawObjectInnerShadow(ctx,o);
  drawBorders(ctx,o);
  ctx.restore()
}
function drawText(ctx,o){ctx.save();const s=getObjectSize(o);if(o.rotation){const cx=o.x+s.w/2,cy=o.y+s.h/2;ctx.translate(cx,cy);ctx.rotate((o.rotation||0)*Math.PI/180);ctx.translate(-cx,-cy)}ctx.globalAlpha=o.opacity;ctx.fillStyle=o.color;ctx.font=`${o.fontWeight} ${o.fontSize}px ${o.fontFamily}`;ctx.textBaseline='top';const lh=o.fontSize*1.2;o.content.split('\n').forEach((line,i)=>ctx.fillText(line,o.x,o.y+i*lh));ctx.restore()}
async function drawScene(ctx,originX,originY,scale){ctx.save();ctx.scale(scale,scale);ctx.translate(-originX,-originY);await drawCanvasBackground(ctx);for(const o of state.objects){if(o.visible===false)continue;if(o.type==='box')await drawBox(ctx,o);else drawText(ctx,o)}ctx.restore()}
async function exportPNG(crop){
  const scale=+$('#exportScale').value||1,b=crop?contentBounds():{x:0,y:0,w:state.canvasW,h:state.canvasH},c=document.createElement('canvas');c.width=Math.max(1,Math.round(b.w*scale));c.height=Math.max(1,Math.round(b.h*scale));const ctx=c.getContext('2d');ctx.clearRect(0,0,c.width,c.height);
  try{await drawScene(ctx,b.x,b.y,scale);const a=document.createElement('a');a.download=crop?'composition-crop.png':'composition-canvas.png';a.href=c.toDataURL('image/png');a.click()}catch(err){setDataStatus('导出失败：'+err.message,'err')}
}
$('#exportCrop').onclick=()=>exportPNG(true);$('#exportFull').onclick=()=>exportPNG(false);

async function bootstrapEditor(){
  const api=desktopApp(),workspaceBtn=$('#workspaceLocation');
  if(api?.WorkspacePath){
    try{
      desktopWorkspacePath=await api.WorkspacePath();
      workspaceBtn.hidden=false;
      workspaceBtn.title='自动工作区：'+desktopWorkspacePath+'\n点击打开所在位置'
    }catch(err){console.warn('workspace path unavailable',err)}
  }else workspaceBtn.hidden=true;
  let restored=false;
  try{restored=await restoreDesktopWorkspace()}catch(err){console.warn('desktop workspace restore failed',err);setDataStatus('桌面工作区恢复失败','err')}
  if(!restored){refreshCanvasControls();addObject(defaultBox());updateWorldTransform()}
  initHistory();renderHistory();
  window.addEventListener('resize',()=>{renderRulers();renderGuides()});
  if(!restored)setTimeout(()=>$('#fitView').click(),0)
}
bootstrapEditor();

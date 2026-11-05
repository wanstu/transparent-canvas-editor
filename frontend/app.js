const $=s=>document.querySelector(s);
const world=$('#world'),viewport=$('#viewport'),guideLayer=$('#guideLayer'),snapOverlay=$('#snapOverlay'),selectionMarquee=$('#selectionMarquee'),topRuler=$('#topRuler'),leftRuler=$('#leftRuler');
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const state={
  objects:[],selectedId:null,selectedBoxIds:[],nextId:1,
  zoom:1,panX:80,panY:70,
  canvasW:1600,canvasH:1000,
  canvasBgOpacity:0,canvasAngle:135,canvasColors:[{c:'#ffffff',p:0},{c:'#dfe7f2',p:100}],
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
const measureCtx=document.createElement('canvas').getContext('2d');
const uid=()=>state.nextId++;
const hexToRgb=h=>{h=(h||'#ffffff').replace('#','');return[parseInt(h.slice(0,2),16),parseInt(h.slice(2,4),16),parseInt(h.slice(4,6),16)]};
const rgba=(hex,a)=>{const[r,g,b]=hexToRgb(hex);return `rgba(${r},${g},${b},${a})`};
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

function defaultBox(){return{id:uid(),type:'box',name:'方框',visible:true,locked:false,rotation:0,lockAspect:false,x:180,y:150,w:420,h:300,radius:28,bgOpacity:.88,angle:135,colors:[{c:'#f7f8fa',p:0},{c:'#d9dde2',p:55},{c:'#bfc5cb',p:100}],imageRef:null,imageOpacity:1,imageFit:'cover',borderOn:true,borderWidth:2,borderColor:'#ffffff',borderOpacity:.9,shadowOn:true}}
function defaultText(){return{id:uid(),type:'text',name:'文字',visible:true,locked:false,rotation:0,x:260,y:230,content:'文字',fontSize:48,color:'#111827',opacity:1,fontWeight:'400',fontFamily:'"Microsoft YaHei",sans-serif'}}
function selected(){return state.objects.find(o=>o.id===state.selectedId)||null}
function selectedObjects(){const ids=new Set(state.selectedBoxIds);return state.objects.filter(o=>ids.has(o.id))}
function editableSelectedObjects(){return selectedObjects().filter(o=>!o.locked)}
function selectedBoxes(){return selectedObjects().filter(o=>o.type==='box')}
function editableSelectedBoxes(){return editableSelectedObjects().filter(o=>o.type==='box')}
function hasMultiBoxes(){return selectedObjects().length>1}
function gradientCSS(colors,angle){const ss=[...colors].sort((a,b)=>a.p-b.p);if(ss.length===1)return ss[0].c;return`linear-gradient(${angle}deg,${ss.map(s=>`${s.c} ${s.p}%`).join(',')})`}
function clearSelection(){state.selectedId=null;state.selectedBoxIds=[]}
function selectObject(o,additive=false){
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
  let done=false;const finish=save=>{if(done)return;done=true;const old=o.name||'';if(save)o.name=input.value;row.draggable=!o.locked;const span=document.createElement('span');span.className='layer-name';span.title='双击重命名';span.textContent=o.name||((o.type==='box'?'方框':'文字')+' '+o.id);input.replaceWith(span);renderLayers();if(save&&o.name!==old){$('#layerName').value=o.name;commitHistory('重命名图层')}};
  input.addEventListener('keydown',e=>{e.stopPropagation();if(e.key==='Enter'){e.preventDefault();finish(true)}else if(e.key==='Escape'){e.preventDefault();finish(false)}});
  input.addEventListener('blur',()=>finish(true))
}
function handleHTML(){return'<i class="handle nw" data-dir="nw"></i><i class="handle n" data-dir="n"></i><i class="handle ne" data-dir="ne"></i><i class="handle e" data-dir="e"></i><i class="handle se" data-dir="se"></i><i class="handle s" data-dir="s"></i><i class="handle sw" data-dir="sw"></i><i class="handle w" data-dir="w"></i><i class="rotate-handle" data-dir="rotate" title="拖动旋转；Shift 按 15° 吸附"></i>'}
function updateWorldDom(){
  const cimg=world.querySelector('.canvas-image-layer'),cbg=world.querySelector('.canvas-bg-layer');
  if(cimg){const p=previewImageUrl(state.canvasImageRef);cimg.style.backgroundImage=p?`url("${p}")`:'none';cimg.style.backgroundSize=fitCSS(state.canvasImageFit);cimg.style.opacity=state.canvasImageOpacity}
  if(cbg){cbg.style.background=gradientCSS(state.canvasColors,state.canvasAngle);cbg.style.opacity=state.canvasBgOpacity}
  state.objects.forEach((o,i)=>{
    const el=objectNodeCache.get(o.id);if(!el)return;
    el.style.left=o.x+'px';el.style.top=o.y+'px';el.style.zIndex=i+3;el.style.transform=`rotate(${o.rotation||0}deg)`;el.style.transformOrigin='50% 50%';
    if(o.type==='box'){
      el.style.width=o.w+'px';el.style.height=o.h+'px';el.style.borderRadius=o.radius+'px';
      el.style.border=o.borderOn?`${o.borderWidth}px solid ${rgba(o.borderColor,o.borderOpacity)}`:'none';el.style.boxShadow=o.shadowOn?'0 16px 34px rgba(35,46,63,.22)':'none';
      const img=el.querySelector('.box-image'),fill=el.querySelector('.box-fill'),p=previewImageUrl(o.imageRef);
      if(img){img.style.backgroundImage=p?`url("${p}")`:'none';img.style.backgroundSize=fitCSS(o.imageFit);img.style.opacity=o.imageOpacity}
      if(fill){fill.style.background=gradientCSS(o.colors,o.angle);fill.style.opacity=o.bgOpacity}
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
  const cbg=document.createElement('div');cbg.className='canvas-bg-layer';cbg.style.background=gradientCSS(state.canvasColors,state.canvasAngle);cbg.style.opacity=state.canvasBgOpacity;world.appendChild(cbg);

  const boxIds=new Set(state.selectedBoxIds),singleBox=state.selectedBoxIds.length===1;
  state.objects.forEach((o,i)=>{
    if(o.visible===false)return;
    const el=document.createElement('div');
    const primary=o.id===state.selectedId,multi=boxIds.has(o.id);
    el.className='object '+(o.type==='box'?'box-object':'text-object')+(o.locked?' locked':'')+(primary?' selected':'')+(multi?' multi-selected':'')+(primary&&singleBox&&!o.locked?' single-selection':'');
    el.dataset.id=o.id;el.style.left=o.x+'px';el.style.top=o.y+'px';el.style.zIndex=i+3;el.style.transform=`rotate(${o.rotation||0}deg)`;el.style.transformOrigin='50% 50%';
    if(o.type==='box'){
      el.style.width=o.w+'px';el.style.height=o.h+'px';el.style.borderRadius=o.radius+'px';
      el.style.border=o.borderOn?`${o.borderWidth}px solid ${rgba(o.borderColor,o.borderOpacity)}`:'none';
      el.style.boxShadow=o.shadowOn?'0 16px 34px rgba(35,46,63,.22)':'none';
      const img=document.createElement('div');img.className='box-image';
      const preview=previewImageUrl(o.imageRef);if(preview){img.style.backgroundImage=`url("${preview}")`;img.style.backgroundSize=fitCSS(o.imageFit);img.style.opacity=o.imageOpacity}
      el.appendChild(img);
      const fill=document.createElement('div');fill.className='box-fill';fill.style.background=gradientCSS(o.colors,o.angle);fill.style.opacity=o.bgOpacity;el.appendChild(fill);
      el.insertAdjacentHTML('beforeend',handleHTML());
    }else{
      const content=document.createElement('span');content.className='text-content';content.textContent=o.content;el.appendChild(content);el.style.fontSize=o.fontSize+'px';el.style.color=o.color;el.style.opacity=o.opacity;el.style.fontWeight=o.fontWeight;el.style.fontFamily=o.fontFamily;
      el.insertAdjacentHTML('beforeend','<i class="rotate-handle" data-dir="rotate" title="拖动旋转；Shift 按 15° 吸附"></i>');
    }
    bindObjectEvents(el,o);objectNodeCache.set(o.id,el);world.appendChild(el);
  });
  if(syncUI){renderLayers();refreshPanels();refreshAlignPanel();refreshRightbar();updateSmartHint()}
}
function createLayerNode(id){
  const d=document.createElement('div');d.className='layer';d.dataset.id=id;
  d.innerHTML='<button class="layer-control" data-layer-action="visibility"></button><button class="layer-control" data-layer-action="lock"></button><span class="layer-icon"></span><span class="layer-name" title="双击重命名"></span><span class="layer-z"></span>';
  d.addEventListener('click',e=>{
    const o=state.objects.find(x=>x.id===Number(d.dataset.id));if(!o)return;const action=e.target.closest('[data-layer-action]')?.dataset.layerAction;
    if(action){e.stopPropagation();if(action==='visibility'){o.visible=o.visible===false;renderObjects();commitHistory((o.visible?'显示':'隐藏')+(o.type==='box'?'方框':'文字'))}else{o.locked=!o.locked;renderObjects();commitHistory((o.locked?'锁定':'解锁')+(o.type==='box'?'方框':'文字'))}return}
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
    d.querySelector('.layer-icon').textContent=o.type==='box'?'□':'T';
    const name=d.querySelector('.layer-name');if(name)name.textContent=o.name||((o.type==='box'?'方框':'文字')+' '+o.id);
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
shortcutPanel.innerHTML='<div class="shortcut-head"><strong>完整快捷键 / 操作</strong><button id="shortcutClose">×</button></div><div class="shortcut-list"><div><span>撤回</span><span><kbd>Ctrl</kbd>+<kbd>Z</kbd></span></div><div><span>反撤回</span><span><kbd>Ctrl</kbd>+<kbd>Y</kbd> / <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Z</kbd></span></div><div><span>全选可见对象</span><span><kbd>Ctrl</kbd>+<kbd>A</kbd></span></div><div><span>清除选择</span><kbd>Esc</kbd></div><div><span>追加 / 取消多选</span><span><kbd>Shift</kbd>+点击</span></div><div><span>框选多个对象</span><span>空白处左键拖动</span></div><div><span>复制 / 粘贴</span><span><kbd>Ctrl</kbd>+<kbd>C</kbd> / <kbd>V</kbd></span></div><div><span>复制一份</span><span><kbd>Ctrl</kbd>+<kbd>D</kbd></span></div><div><span>删除</span><kbd>Delete</kbd></div><div><span>移动 1px / 10px</span><span><kbd>方向键</kbd> / <kbd>Shift</kbd>+<kbd>方向键</kbd></span></div><div><span>居中定位选中对象</span><kbd>Home</kbd></div><div><span>缩放到选中对象</span><kbd>F</kbd></div><div><span>移动画布</span><span>中键拖动 / <kbd>Space</kbd>+左键拖动</span></div><div><span>缩放画布</span><span>鼠标滚轮</span></div><div><span>临时锁定纵横比</span><span>缩放时按 <kbd>Shift</kbd></span></div><div><span>旋转 15° 吸附</span><span>旋转时按 <kbd>Shift</kbd></span></div><div><span>创建参考线</span><span>从水平 / 垂直刻度拖出</span></div><div><span>删除参考线</span><span>双击参考线</span></div><div><span>重命名图层</span><span>双击图层名称</span></div><div><span>显示 / 隐藏本面板</span><kbd>?</kbd></div></div>';
function updateSmartHint(){
  const el=$('#smartHint');if(!el)return;const n=selectedObjects().length;let msg='';
  if(spacePanHeld)msg='平移模式：按住 Space + 左键拖动 · 松开 Space 恢复编辑';
  else if(!n)msg='空白拖动框选 · Ctrl+A 全选 · Space / 中键平移 · 滚轮缩放 · ? 全部快捷键';
  else if(n===1){const o=selected();msg=o?.type==='box'?'方框已选中 · 上方圆点旋转 · Shift 缩放锁比例 · Home 居中 · F 缩放到选中 · ? 全部快捷键':'文字已选中 · 上方圆点旋转 · Shift+点击追加多选 · Home 居中 · F 缩放到选中 · ? 全部快捷键'}
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
  const o=selected(),has=!!o,multi=hasMultiBoxes(),locked=!!o?.locked;
  $('#commonPanel').style.opacity=has?(locked?'.58':'1'):'.45';
  $('#layerName').disabled=!has||multi||locked;
  ['objX','objY','objW','objH','objRotation'].forEach(id=>$('#'+id).disabled=!has||multi||locked);
  $('#lockAspect').disabled=!has||multi||locked||o?.type!=='box';
  $('#aspectLockRow').style.display=o?.type==='box'?'flex':'none';
  $('#boxPanel').hidden=o?.type!=='box';$('#textPanel').hidden=o?.type!=='text';
  $('#deleteObj').disabled=multi?editableSelectedObjects().length===0:(!has||locked);
  if(!o){$('#layerName').value='';return}
  $('#layerName').value=o.name||'';$('#objX').value=Math.round(o.x);$('#objY').value=Math.round(o.y);$('#objRotation').value=Math.round(o.rotation||0);$('#lockAspect').checked=!!o.lockAspect;
  if(o.type==='box'){
    $('#sizeFields').style.display='grid';$('#objW').value=Math.round(o.w);$('#objH').value=Math.round(o.h);
    $('#radius').value=o.radius;$('#radiusVal').textContent=Math.round(o.radius)+'px';
    $('#bgOpacity').value=Math.round(o.bgOpacity*100);$('#bgOpacityVal').textContent=Math.round(o.bgOpacity*100)+'%';
    $('#angle').value=o.angle;$('#angleVal').textContent=Math.round(o.angle)+'°';
    $('#boxImageOpacity').value=Math.round(o.imageOpacity*100);$('#boxImageOpacityVal').textContent=Math.round(o.imageOpacity*100)+'%';$('#boxImageFit').value=o.imageFit;
    $('#borderOn').checked=o.borderOn;$('#borderWidth').value=o.borderWidth;$('#borderColor').value=o.borderColor;
    $('#borderOpacity').value=Math.round(o.borderOpacity*100);$('#borderOpacityVal').textContent=Math.round(o.borderOpacity*100)+'%';$('#shadowOn').checked=o.shadowOn;
    renderColorControls(o);
    $('#boxPanel').querySelectorAll('input,select,button,textarea').forEach(el=>el.disabled=locked||multi);
    $('#boxImageRemove').disabled=locked||multi||!o.imageRef
  }else{
    $('#sizeFields').style.display='none';$('#textContent').value=o.content;$('#fontSize').value=o.fontSize;$('#textColor').value=o.color;
    $('#textOpacity').value=Math.round(o.opacity*100);$('#textOpacityVal').textContent=Math.round(o.opacity*100)+'%';$('#fontWeight').value=o.fontWeight;ensureFontOption(o.fontFamily,o.fontFamily);$('#fontFamily').value=o.fontFamily;
    $('#textPanel').querySelectorAll('input,select,button,textarea').forEach(el=>el.disabled=locked)
  }
}
function renderColorControls(o){
  const wrap=$('#colors');wrap.innerHTML='';
  o.colors.forEach((s,i)=>{
    const r=document.createElement('div');r.className='color-row';r.innerHTML=`<input type="color" value="${s.c}"><input type="range" min="0" max="100" value="${s.p}" title="位置 ${s.p}%"><button class="remove">×</button>`;
    const[c,p,rm]=r.children;c.oninput=e=>{s.c=e.target.value;renderObjects(false)};p.oninput=e=>{s.p=+e.target.value;p.title='位置 '+s.p+'%';renderObjects(false)};
    rm.onclick=()=>{if(o.colors.length>1){o.colors.splice(i,1);renderObjects(true);commitHistory('删除对象渐变颜色')}};wrap.appendChild(r)
  })
}
function renderCanvasColorControls(){
  const wrap=$('#canvasColors');wrap.innerHTML='';
  state.canvasColors.forEach((s,i)=>{
    const r=document.createElement('div');r.className='color-row';r.innerHTML=`<input type="color" value="${s.c}"><input type="range" min="0" max="100" value="${s.p}" title="位置 ${s.p}%"><button class="remove">×</button>`;
    const[c,p,rm]=r.children;c.oninput=e=>{s.c=e.target.value;renderObjects(false)};p.oninput=e=>{s.p=+e.target.value;p.title='位置 '+s.p+'%';renderObjects(false)};
    rm.onclick=()=>{if(state.canvasColors.length>1){state.canvasColors.splice(i,1);renderCanvasColorControls();renderObjects(false);commitHistory('删除画布渐变颜色')}};wrap.appendChild(r)
  })
}

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
    const dir=e.target.dataset.dir;
    if(e.shiftKey&&!dir){selectObject(o,true);renderObjects();return}
    if(!state.selectedBoxIds.includes(o.id)){selectObject(o,false);renderObjects()}
    if(o.locked){gesture=null;return}
    if(dir==='rotate'&&state.selectedBoxIds.length===1){
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
  el.addEventListener('contextmenu',e=>{
    e.preventDefault();e.stopPropagation();
    if(state.selectedBoxIds.includes(o.id)&&state.selectedBoxIds.length>1){state.selectedId=o.id}
    else if(state.selectedId!==o.id){selectObject(o,false);renderObjects()}
    showContextMenu(e.clientX,e.clientY,o)
  })
}
function getObjectSize(o){if(o.type==='box')return{w:o.w,h:o.h};const m=textMetrics(measureCtx,o);return{w:m.w,h:m.h}}
function getObjectBounds(o){
  const s=getObjectSize(o),angle=((o.rotation||0)%360)*Math.PI/180;
  if(Math.abs(angle)<1e-8)return{x:o.x,y:o.y,w:s.w,h:s.h};
  const c=Math.abs(Math.cos(angle)),sn=Math.abs(Math.sin(angle)),w=s.w*c+s.h*sn,h=s.w*sn+s.h*c,cx=o.x+s.w/2,cy=o.y+s.h/2;
  return{x:cx-w/2,y:cy-h/2,w,h}
}
function selectionBounds(items=selectedObjects()){
  if(!items.length)return null;const rects=items.map(getObjectBounds),x=Math.min(...rects.map(r=>r.x)),y=Math.min(...rects.map(r=>r.y)),right=Math.max(...rects.map(r=>r.x+r.w)),bottom=Math.max(...rects.map(r=>r.y+r.h));
  return{x,y,w:right-x,h:bottom-y}
}
function clientToWorld(clientX,clientY){const r=viewport.getBoundingClientRect();return{x:(clientX-r.left-state.panX)/state.zoom,y:(clientY-r.top-state.panY)/state.zoom}}
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
  if(!gesture||gesture.type==='guide')return;const g=gesture,type=g.type;gesture=null;viewport.classList.remove('panning');world.querySelectorAll('.rotating').forEach(el=>el.classList.remove('rotating'));
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
  if(type==='move'||type==='moveGroup')commitHistory('移动对象');else if(type==='resize')commitHistory('调整方框尺寸');else if(type==='rotate')commitHistory('旋转对象')
});
viewport.addEventListener('pointercancel',()=>{
  if(!gesture||gesture.type==='guide')return;const type=gesture.type;gesture=null;viewport.classList.remove('panning');selectionMarquee.classList.remove('show');world.querySelectorAll('.rotating').forEach(el=>el.classList.remove('rotating'));clearSnapFeedback();
  if(type==='move'||type==='moveGroup'||type==='resize'||type==='rotate')commitHistory(type==='resize'?'调整方框尺寸':type==='rotate'?'旋转对象':'移动对象')
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
$('#lockAspect').onchange=e=>mutateSelected(o=>{if(o.type==='box')o.lockAspect=e.target.checked});
$('#objW').oninput=e=>mutateSelected(o=>{if(o.type!=='box')return;const ratio=o.w/Math.max(1,o.h),w=Math.max(20,+e.target.value||20);o.w=w;if(o.lockAspect)o.h=Math.max(20,w/ratio)},true);
$('#objH').oninput=e=>mutateSelected(o=>{if(o.type!=='box')return;const ratio=o.w/Math.max(1,o.h),h=Math.max(20,+e.target.value||20);o.h=h;if(o.lockAspect)o.w=Math.max(20,h*ratio)},true);
$('#radius').oninput=e=>{mutateSelected(o=>o.radius=+e.target.value);$('#radiusVal').textContent=e.target.value+'px'};
$('#bgOpacity').oninput=e=>{mutateSelected(o=>o.bgOpacity=+e.target.value/100);$('#bgOpacityVal').textContent=e.target.value+'%'};
$('#angle').oninput=e=>{mutateSelected(o=>o.angle=+e.target.value);$('#angleVal').textContent=e.target.value+'°'};
$('#addColor').onclick=()=>{mutateSelected(o=>o.colors.push({c:'#ffffff',p:100}),true);commitHistory('添加对象渐变颜色')};
$('#borderOn').oninput=e=>mutateSelected(o=>o.borderOn=e.target.checked);$('#borderWidth').oninput=e=>mutateSelected(o=>o.borderWidth=Math.max(0,+e.target.value||0));
$('#borderColor').oninput=e=>mutateSelected(o=>o.borderColor=e.target.value);$('#borderOpacity').oninput=e=>{mutateSelected(o=>o.borderOpacity=+e.target.value/100);$('#borderOpacityVal').textContent=e.target.value+'%'};$('#shadowOn').oninput=e=>mutateSelected(o=>o.shadowOn=e.target.checked);
$('#boxImageOpacity').oninput=e=>{mutateSelected(o=>o.imageOpacity=+e.target.value/100);$('#boxImageOpacityVal').textContent=e.target.value+'%'};$('#boxImageFit').onchange=e=>mutateSelected(o=>o.imageFit=e.target.value);
$('#textContent').oninput=e=>mutateSelected(o=>o.content=e.target.value);$('#fontSize').oninput=e=>mutateSelected(o=>o.fontSize=clamp(+e.target.value||6,6,400));$('#textColor').oninput=e=>mutateSelected(o=>o.color=e.target.value);$('#textOpacity').oninput=e=>{mutateSelected(o=>o.opacity=+e.target.value/100);$('#textOpacityVal').textContent=e.target.value+'%'};$('#fontWeight').oninput=e=>mutateSelected(o=>o.fontWeight=e.target.value);$('#fontFamily').oninput=e=>mutateSelected(o=>o.fontFamily=e.target.value);

function readFileAsDataURL(file){return new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(r.result);r.onerror=()=>reject(r.error||new Error('读取文件失败'));r.readAsDataURL(file)})}
$('#boxImageUpload').onclick=()=>{const o=selected();if(o?.type==='box'&&!o.locked&&!hasMultiBoxes())$('#boxImageFile').click()};
$('#boxImageFile').onchange=async e=>{const file=e.target.files?.[0],o=selected();if(file&&o?.type==='box'&&!o.locked&&!hasMultiBoxes()){const data=await readFileAsDataURL(file),ref=registerImageAsset(data);await ensureImagePreview(ref);o.imageRef=ref;renderObjects();commitHistory('设置方框背景图片')}e.target.value=''};
$('#boxImageRemove').onclick=()=>{mutateSelected(o=>{if(o.type==='box')o.imageRef=null},true);commitHistory('移除方框背景图片')};
$('#canvasImageUpload').onclick=()=>$('#canvasImageFile').click();
$('#canvasImageFile').onchange=async e=>{const file=e.target.files?.[0];if(file){const data=await readFileAsDataURL(file),ref=registerImageAsset(data);await ensureImagePreview(ref);state.canvasImageRef=ref;renderObjects(false);commitHistory('设置画布背景图片')}e.target.value=''};
$('#canvasImageRemove').onclick=()=>{state.canvasImageRef=null;renderObjects(false);refreshCanvasControls();commitHistory('移除画布背景图片')};
$('#canvasImageOpacity').oninput=e=>{state.canvasImageOpacity=+e.target.value/100;$('#canvasImageOpacityVal').textContent=e.target.value+'%';renderObjects(false)};
$('#canvasImageFit').onchange=e=>{state.canvasImageFit=e.target.value;renderObjects(false)};

function addObject(o,label='添加对象'){state.objects.push(o);selectObject(o,false);renderObjects();commitHistory(label)}
$('#addBox').onclick=()=>addObject(defaultBox(),'添加方框');$('#addText').onclick=()=>addObject(defaultText(),'添加文字');
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
    canvas:{width:Math.ceil(maxX-minX+pad*2),height:Math.ceil(maxY-minY+pad*2),backgroundOpacity:0,gradientAngle:135,colors:[{c:'#ffffff',p:0},{c:'#ffffff',p:100}],imageRef:null,imageOpacity:1,imageFit:'cover'},
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
function showContextMenu(clientX,clientY,target=null){
  const menu=$('#contextMenu');menu.innerHTML='';
  const items=selectedObjects(),multi=items.length>1&&target&&state.selectedBoxIds.includes(target.id);
  if(multi){
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
    const locked=!!target.locked;
    menu.append(
      contextItem(target.visible===false?'显示方框':'隐藏方框',()=>{target.visible=target.visible===false;renderObjects();commitHistory(target.visible?'显示方框':'隐藏方框')}),
      contextItem(locked?'解锁方框':'锁定方框',()=>{target.locked=!target.locked;renderObjects();commitHistory(target.locked?'锁定方框':'解锁方框')}),
      contextSep(),
      contextItem('复制方框',copySelectedBoxes,{shortcut:'Ctrl+C'}),
      contextItem('粘贴方框',pasteSelectedBoxes,{disabled:!boxClipboard,shortcut:'Ctrl+V'}),
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
      contextItem('添加文字',()=>$('#addText').click()),
      contextItem('粘贴方框',pasteSelectedBoxes,{disabled:!boxClipboard,shortcut:'Ctrl+V'}),
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
  if(e.key==='Escape'){e.preventDefault();clearSelection();renderObjects();return}
  if(e.key==='Home'){e.preventDefault();const b=selectionBounds();if(b)focusBounds(b,false);else setDataStatus('请先选择对象','err');return}
  if(key==='f'&&!mod&&!e.altKey){e.preventDefault();const b=selectionBounds();if(b)focusBounds(b,true);else setDataStatus('请先选择对象','err');return}
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
  $('#canvasBgOpacity').value=Math.round(state.canvasBgOpacity*100);$('#canvasBgOpacityVal').textContent=Math.round(state.canvasBgOpacity*100)+'%';
  $('#canvasAngle').value=state.canvasAngle;$('#canvasAngleVal').textContent=Math.round(state.canvasAngle)+'°';
  $('#canvasImageOpacity').value=Math.round(state.canvasImageOpacity*100);$('#canvasImageOpacityVal').textContent=Math.round(state.canvasImageOpacity*100)+'%';$('#canvasImageFit').value=state.canvasImageFit;$('#canvasImageRemove').disabled=!state.canvasImageRef;
  renderCanvasColorControls();refreshRightbar()
}
$('#canvasW').onchange=e=>{state.canvasW=clamp(+e.target.value||100,100,10000);updateWorldTransform();renderObjects(false);refreshCanvasControls()};
$('#canvasH').onchange=e=>{state.canvasH=clamp(+e.target.value||100,100,10000);updateWorldTransform();renderObjects(false);refreshCanvasControls()};
$('#canvasBgOpacity').oninput=e=>{state.canvasBgOpacity=+e.target.value/100;$('#canvasBgOpacityVal').textContent=e.target.value+'%';renderObjects(false)};
$('#canvasAngle').oninput=e=>{state.canvasAngle=+e.target.value;$('#canvasAngleVal').textContent=e.target.value+'°';renderObjects(false)};
$('#canvasAddColor').onclick=()=>{state.canvasColors.push({c:'#ffffff',p:100});renderCanvasColorControls();renderObjects(false);commitHistory('添加画布渐变颜色')};
$('#snapEnabled').onclick=()=>{state.snapEnabled=!state.snapEnabled;refreshRightbar();commitHistory(state.snapEnabled?'开启自动吸附':'关闭自动吸附');setDataStatus(state.snapEnabled?'自动吸附已开启':'自动吸附已关闭','ok')};
$('#guidesToggle').onclick=()=>{state.guidesVisible=!state.guidesVisible;renderGuides();refreshRightbar();commitHistory(state.guidesVisible?'显示参考线':'隐藏参考线');setDataStatus(state.guidesVisible?'参考线已显示':'参考线已隐藏','ok')};
$('#clearGuides').onclick=()=>{state.guides={vertical:[],horizontal:[]};renderGuides();commitHistory('清空参考线');setDataStatus('参考线已清空','ok')};

function editableSnapshot(){
  return{
    canvas:{width:state.canvasW,height:state.canvasH,backgroundOpacity:state.canvasBgOpacity,gradientAngle:state.canvasAngle,colors:structuredClone(state.canvasColors),imageRef:state.canvasImageRef,imageOpacity:state.canvasImageOpacity,imageFit:state.canvasImageFit},
    objects:structuredClone(state.objects),
    assists:{snapEnabled:state.snapEnabled,guidesVisible:state.guidesVisible,guides:structuredClone(state.guides)},
    selection:{selectedId:state.selectedId,selectedBoxIds:[...state.selectedBoxIds]}
  }
}
function applyEditableSnapshot(s){
  historyState.restoring=true;
  state.canvasW=s.canvas.width;state.canvasH=s.canvas.height;state.canvasBgOpacity=s.canvas.backgroundOpacity;state.canvasAngle=s.canvas.gradientAngle;state.canvasColors=structuredClone(s.canvas.colors);state.canvasImageRef=s.canvas.imageRef||null;state.canvasImageOpacity=s.canvas.imageOpacity;state.canvasImageFit=s.canvas.imageFit||'cover';
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

const PROJECT_FORMAT='transparent-canvas-editor',PROJECT_VERSION=6;
function projectSnapshot(){return{format:PROJECT_FORMAT,version:PROJECT_VERSION,savedAt:new Date().toISOString(),assets:{images:exportImageAssets(),fonts:structuredClone(state.customFonts)},canvas:{width:state.canvasW,height:state.canvasH,backgroundOpacity:state.canvasBgOpacity,gradientAngle:state.canvasAngle,colors:structuredClone(state.canvasColors),imageRef:state.canvasImageRef,imageOpacity:state.canvasImageOpacity,imageFit:state.canvasImageFit},objects:structuredClone(state.objects),assists:{snapEnabled:state.snapEnabled,guidesVisible:state.guidesVisible,guides:structuredClone(state.guides)},view:{zoom:state.zoom,panX:state.panX,panY:state.panY},selectedId:state.selectedId,selectedBoxIds:[...state.selectedBoxIds]}}
function setDataStatus(msg,type=''){
  const el=$('#dataStatus');clearTimeout(statusTimer);el.textContent=msg;el.className='right-status show'+(type?' '+type:'');
  statusTimer=setTimeout(()=>{el.className='right-status'},1800)
}
function downloadText(filename,text,mime='application/json'){const blob=new Blob([text],{type:mime}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=filename;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),500)}
$('#exportData').onclick=()=>{const data=projectSnapshot();downloadText('canvas-project-'+Date.now()+'.json',JSON.stringify(data,null,2));setDataStatus('已导出：'+data.objects.length+' 个图层','ok')};
$('#importData').onclick=()=>$('#importDataFile').click();
function finiteNumber(v,f){v=Number(v);return Number.isFinite(v)?v:f}
function cleanColor(v,f='#ffffff'){return typeof v==='string'&&/^#[0-9a-fA-F]{6}$/.test(v)?v:f}
function cleanStops(list,fallback){if(!Array.isArray(list)||!list.length)return structuredClone(fallback);return list.slice(0,32).map((s,i)=>({c:cleanColor(s?.c,i?'#dfe7f2':'#ffffff'),p:clamp(finiteNumber(s?.p,i?100:0),0,100)}))}
function cleanFit(v){return['cover','contain','stretch'].includes(v)?v:'cover'}
function normalizeObject(raw,idFallback,assetAliases=new Map()){
  if(!raw||!['box','text'].includes(raw.type))return null;const id=Math.max(1,Math.floor(finiteNumber(raw.id,idFallback)));
  if(raw.type==='box'){
    const legacyRef=typeof raw.image==='string'?registerImageAsset(raw.image):null;
    const imageRef=assetAliases.get(raw.imageRef)||raw.imageRef||legacyRef||null;
    return{id,type:'box',name:typeof raw.name==='string'?raw.name:'方框',visible:raw.visible!==false,locked:raw.locked===true,rotation:finiteNumber(raw.rotation,0),lockAspect:raw.lockAspect===true,x:finiteNumber(raw.x,180),y:finiteNumber(raw.y,150),w:Math.max(20,finiteNumber(raw.w,420)),h:Math.max(20,finiteNumber(raw.h,300)),radius:Math.max(0,finiteNumber(raw.radius,28)),bgOpacity:clamp(finiteNumber(raw.bgOpacity,.88),0,1),angle:finiteNumber(raw.angle,135),colors:cleanStops(raw.colors,[{c:'#f7f8fa',p:0},{c:'#d9dde2',p:55},{c:'#bfc5cb',p:100}]),imageRef,imageOpacity:clamp(finiteNumber(raw.imageOpacity,1),0,1),imageFit:cleanFit(raw.imageFit),borderOn:raw.borderOn!==false,borderWidth:Math.max(0,finiteNumber(raw.borderWidth,2)),borderColor:cleanColor(raw.borderColor,'#ffffff'),borderOpacity:clamp(finiteNumber(raw.borderOpacity,.9),0,1),shadowOn:raw.shadowOn!==false}
  }
  return{id,type:'text',name:typeof raw.name==='string'?raw.name:'文字',visible:raw.visible!==false,locked:raw.locked===true,rotation:finiteNumber(raw.rotation,0),x:finiteNumber(raw.x,260),y:finiteNumber(raw.y,230),content:typeof raw.content==='string'?raw.content:'文字',fontSize:clamp(finiteNumber(raw.fontSize,48),6,400),color:cleanColor(raw.color,'#111827'),opacity:clamp(finiteNumber(raw.opacity,1),0,1),fontWeight:['400','500','600','700'].includes(String(raw.fontWeight))?String(raw.fontWeight):'400',fontFamily:typeof raw.fontFamily==='string'?raw.fontFamily:'"Microsoft YaHei",sans-serif'}
}
async function loadProjectData(data){
  if(!data||typeof data!=='object')throw new Error('JSON 根节点不是对象');const canvas=data.canvas&&typeof data.canvas==='object'?data.canvas:data,rawObjects=Array.isArray(data.objects)?data.objects:[];
  const aliases=importImageAssets(data.assets?.images);
  const legacyCanvasRef=typeof canvas.image==='string'?registerImageAsset(canvas.image):null;
  state.canvasW=clamp(finiteNumber(canvas.width??data.canvasW,1600),100,10000);state.canvasH=clamp(finiteNumber(canvas.height??data.canvasH,1000),100,10000);state.canvasBgOpacity=clamp(finiteNumber(canvas.backgroundOpacity??data.canvasBgOpacity,0),0,1);state.canvasAngle=finiteNumber(canvas.gradientAngle??data.canvasAngle,135);state.canvasColors=cleanStops(canvas.colors??data.canvasColors,[{c:'#ffffff',p:0},{c:'#dfe7f2',p:100}]);state.canvasImageRef=aliases.get(canvas.imageRef)||canvas.imageRef||legacyCanvasRef||null;state.canvasImageOpacity=clamp(finiteNumber(canvas.imageOpacity,1),0,1);state.canvasImageFit=cleanFit(canvas.imageFit);
  const used=new Set();let seed=1;state.objects=rawObjects.map(raw=>{let o=normalizeObject(raw,seed++,aliases);if(!o)return null;while(used.has(o.id))o.id=seed++;used.add(o.id);return o}).filter(Boolean);state.nextId=state.objects.reduce((m,o)=>Math.max(m,o.id),0)+1;
  state.customFonts=Array.isArray(data.assets?.fonts)?structuredClone(data.assets.fonts):[];await restoreCustomFonts();
  const assists=data.assists||{};state.snapEnabled=assists.snapEnabled!==false;state.guidesVisible=assists.guidesVisible!==false;const gs=assists.guides||{};state.guides={vertical:Array.isArray(gs.vertical)?gs.vertical.map(v=>finiteNumber(v,NaN)).filter(Number.isFinite):[],horizontal:Array.isArray(gs.horizontal)?gs.horizontal.map(v=>finiteNumber(v,NaN)).filter(Number.isFinite):[]};
  const view=data.view||data;state.zoom=clamp(finiteNumber(view.zoom,1),.1,5);state.panX=finiteNumber(view.panX,70);state.panY=finiteNumber(view.panY,70);
  state.selectedBoxIds=Array.isArray(data.selectedBoxIds)?data.selectedBoxIds.map(Number).filter(id=>state.objects.some(o=>o.id===id)):[];const wanted=finiteNumber(data.selectedId,NaN);state.selectedId=state.objects.some(o=>o.id===wanted)?wanted:(state.selectedBoxIds.at(-1)||state.objects[0]?.id||null);syncSelectionValidity();
  await Promise.all([...usedImageAssetRefs()].map(ref=>ensureImagePreview(ref)));refreshCanvasControls();updateWorldTransform();renderObjects()
}
$('#importDataFile').onchange=async e=>{const file=e.target.files?.[0];if(!file)return;try{await loadProjectData(JSON.parse(await file.text()));commitHistory('加载项目数据');setDataStatus('已导入：'+state.objects.length+' 个图层','ok')}catch(err){setDataStatus('导入失败：'+(err?.message||'JSON 无效'),'err')}finally{e.target.value=''}};

function textMetrics(ctx,o){ctx.save();ctx.font=`${o.fontWeight} ${o.fontSize}px ${o.fontFamily}`;let w=0;const lines=o.content.split('\n');lines.forEach(l=>w=Math.max(w,ctx.measureText(l||' ').width));ctx.restore();return{w,h:Math.max(o.fontSize*1.2,lines.length*o.fontSize*1.2)}}
function contentBounds(){const visible=state.objects.filter(o=>o.visible!==false);if(!visible.length)return{x:0,y:0,w:state.canvasW,h:state.canvasH};let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;visible.forEach(o=>{let b=getObjectBounds(o);if(o.type==='box'&&o.shadowOn){const m=40;b={x:b.x-m,y:b.y-m,w:b.w+2*m,h:b.h+2*m}}minX=Math.min(minX,b.x);minY=Math.min(minY,b.y);maxX=Math.max(maxX,b.x+b.w);maxY=Math.max(maxY,b.y+b.h)});const p=10;return{x:Math.floor(minX-p),y:Math.floor(minY-p),w:Math.ceil(maxX-minX+2*p),h:Math.ceil(maxY-minY+2*p)}}
function roundRect(ctx,x,y,w,h,r){r=Math.max(0,Math.min(r,w/2,h/2));ctx.beginPath();ctx.moveTo(x+r,y);ctx.arcTo(x+w,y,x+w,y+h,r);ctx.arcTo(x+w,y+h,x,y+h,r);ctx.arcTo(x,y+h,x,y,r);ctx.arcTo(x,y,x+w,y,r);ctx.closePath()}
function createGradient(ctx,x,y,w,h,colors,angle){const ss=[...colors].sort((a,b)=>a.p-b.p);if(ss.length===1)return ss[0].c;const rad=(angle-90)*Math.PI/180,cx=x+w/2,cy=y+h/2,len=Math.abs(w*Math.cos(rad))+Math.abs(h*Math.sin(rad)),g=ctx.createLinearGradient(cx-Math.cos(rad)*len/2,cy-Math.sin(rad)*len/2,cx+Math.cos(rad)*len/2,cy+Math.sin(rad)*len/2);ss.forEach(s=>g.addColorStop(clamp(s.p/100,0,1),s.c));return g}
function loadImage(src){if(!src)return Promise.resolve(null);if(imageCache.has(src))return imageCache.get(src);const p=new Promise((resolve,reject)=>{const im=new Image();im.onload=()=>resolve(im);im.onerror=()=>reject(new Error('图片加载失败'));im.src=src});imageCache.set(src,p);return p}
function drawImageFit(ctx,img,x,y,w,h,fit){
  if(fit==='stretch'){ctx.drawImage(img,x,y,w,h);return}
  const scale=fit==='contain'?Math.min(w/img.width,h/img.height):Math.max(w/img.width,h/img.height),dw=img.width*scale,dh=img.height*scale,dx=x+(w-dw)/2,dy=y+(h-dh)/2;ctx.drawImage(img,dx,dy,dw,dh)
}
async function drawCanvasBackground(ctx){
  ctx.save();ctx.beginPath();ctx.rect(0,0,state.canvasW,state.canvasH);ctx.clip();
  const canvasSrc=imageAssetValue(state.canvasImageRef);if(canvasSrc){const img=await loadImage(canvasSrc);ctx.save();ctx.globalAlpha=state.canvasImageOpacity;drawImageFit(ctx,img,0,0,state.canvasW,state.canvasH,state.canvasImageFit);ctx.restore()}
  if(state.canvasBgOpacity>0){ctx.save();ctx.globalAlpha=state.canvasBgOpacity;ctx.fillStyle=createGradient(ctx,0,0,state.canvasW,state.canvasH,state.canvasColors,state.canvasAngle);ctx.fillRect(0,0,state.canvasW,state.canvasH);ctx.restore()}
  ctx.restore()
}
async function drawBox(ctx,o){
  ctx.save();
  if(o.rotation){const cx=o.x+o.w/2,cy=o.y+o.h/2;ctx.translate(cx,cy);ctx.rotate((o.rotation||0)*Math.PI/180);ctx.translate(-cx,-cy)}
  if(o.shadowOn){ctx.shadowColor='rgba(35,46,63,.22)';ctx.shadowBlur=30;ctx.shadowOffsetY=16;ctx.fillStyle='rgba(255,255,255,.01)';roundRect(ctx,o.x,o.y,o.w,o.h,o.radius);ctx.fill();ctx.shadowColor='transparent'}
  ctx.save();roundRect(ctx,o.x,o.y,o.w,o.h,o.radius);ctx.clip();
  const boxSrc=imageAssetValue(o.imageRef);if(boxSrc){const img=await loadImage(boxSrc);ctx.save();ctx.globalAlpha=o.imageOpacity;drawImageFit(ctx,img,o.x,o.y,o.w,o.h,o.imageFit);ctx.restore()}
  if(o.bgOpacity>0){ctx.save();ctx.globalAlpha=o.bgOpacity;ctx.fillStyle=createGradient(ctx,o.x,o.y,o.w,o.h,o.colors,o.angle);ctx.fillRect(o.x,o.y,o.w,o.h);ctx.restore()}
  ctx.restore();
  if(o.borderOn&&o.borderWidth>0){ctx.strokeStyle=rgba(o.borderColor,o.borderOpacity);ctx.lineWidth=o.borderWidth;roundRect(ctx,o.x+o.borderWidth/2,o.y+o.borderWidth/2,o.w-o.borderWidth,o.h-o.borderWidth,Math.max(0,o.radius-o.borderWidth/2));ctx.stroke()}
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
  let restored=false;
  try{restored=await restoreDesktopWorkspace()}catch(err){console.warn('desktop workspace restore failed',err);setDataStatus('桌面工作区恢复失败','err')}
  if(!restored){refreshCanvasControls();addObject(defaultBox());updateWorldTransform()}
  initHistory();renderHistory();
  window.addEventListener('resize',()=>{renderRulers();renderGuides()});
  if(!restored)setTimeout(()=>$('#fitView').click(),0)
}
bootstrapEditor();

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Presentation, PresentationFile } from '@oai/artifact-tool';
import sharp from 'sharp';
import {execFileSync} from 'node:child_process';

const input = process.argv[2], flag = process.argv.indexOf('--output');
if (!input || flag < 0) throw new Error('Usage: build_deck.mjs catalog.enriched.json --output /task');
const ROOT = path.resolve(process.argv[flag + 1]);
const BUILD = path.join(ROOT, '.build');
await fs.mkdir(BUILD, {recursive:true}); await fs.mkdir(path.join(ROOT,'output'), {recursive:true});
const d = JSON.parse(await fs.readFile(input, 'utf8'));
const nodes = new Map(d.nodes.map(n => [n.id,n]));
const children = new Map();
for (const n of d.nodes) { const key = n.parent_id; if (!children.has(key)) children.set(key,[]); children.get(key).push(n); }
const roots = children.get(null) || [];
const displayRoots = roots.length===1 && roots[0].name.toLowerCase()===d.brand.toLowerCase() ? (children.get(roots[0].id)||roots) : roots;
const trail = n => {const out=[n.name]; while(n.parent_id){n=nodes.get(n.parent_id);out.unshift(n.name);} return out.join(' / ');};
const leafNodes = d.nodes.filter(n => !children.has(n.id));
const p = Presentation.create({slideSize:{width:1280,height:720}});
const FONT=process.env.BRAND_AGENT_FONT || 'PingFang SC', INK='#1D1D1F', MUTED='#6E6E73', ACCENT=/^#[0-9a-f]{6}$/i.test(d.visual_identity?.accent_color||'')?d.visual_identity.accent_color:'#6E6E73';
const requested=d.samples_per_category||6;
p.theme.defaultFont=FONT;
const pages=[];
function text(s,t,x,y,w,h,size=22,bold=false,color=INK,align='left') {
  const shape=s.shapes.add({geometry:'textbox', position:{left:x,top:y,width:w,height:h},fill:'none',line:{fill:'none',width:0}});
  shape.text=String(t);shape.text.style={typeface:FONT,fontSize:size,bold,color,alignment:align,verticalAlignment:'middle',insets:0,wrap:'square'};return shape;
}
const weight = v => [...String(v)].reduce((n,ch)=>n+(ch.charCodeAt(0)>255?1:.55),0);
function chunks(value,max=160){
  const result=[];let current='';
  for(const sentence of String(value).split(/(?<=[。；])/u)) {
    if(current && weight(current+sentence)>max){result.push(current);current='';}
    for(const ch of sentence){if(weight(current+ch)>max){result.push(current);current='';}current+=ch;}
  }
  if(current)result.push(current);return result;
}
function page(title,sub='') {
  const s=p.slides.add();s.background.fill='#FFFFFF';text(s,title,64,48,1152,66,40,true);
  if(sub) text(s,sub,64,122,1152,42,18,false,MUTED);
  pages.push({slide:s,title});return s;
}
function notes(s,lines){s.speakerNotes.text=[`品牌：${d.brand}`,`地区：${d.region}`,`核验日期：${d.as_of}`,...lines].join('\n');}
async function image(s,product,x,y,w,h){
  if(!product.asset_path){text(s,'官方图片暂缺',x,y,w,h,20,false,MUTED,'center');return;}
  const original=await fs.readFile(path.resolve(ROOT,product.asset_path));
  // Crop only outer whitespace in the placed copy; preserve the source asset in the image ZIP.
  let raw;try{raw=await sharp(original).trim({threshold:10}).png().toBuffer();}catch{raw=original;}
  s.images.add({blob:raw.buffer.slice(raw.byteOffset,raw.byteOffset+raw.byteLength),contentType:'image/png',alt:product.name,fit:'contain',position:{left:x,top:y,width:w,height:h}});
}
const cover=page(`${d.brand} 产品线图谱`);
text(cover,'官网产品架构与代表产品',64,220,1152,96,52,true);
text(cover,`按官网分类逐层展开，每类选取至多 ${requested} 个不同产品`,64,340,1152,60,25,false,MUTED);
text(cover,`${d.region}　${d.as_of}`,64,525,1152,34,22,false,MUTED);
text(cover,d.coverage.status==='complete'?'已核验官网分类范围':'部分范围，详见覆盖说明',64,572,1152,36,20,false,ACCENT);
notes(cover,[d.official_url,d.scope||'',...d.coverage.notes,`主题色：${ACCENT}`,d.visual_identity?.source_url||'主题色暂无官网依据，使用中性灰',d.visual_identity?.note||'']);

const directory=page('内容目录','先理解品牌与产品架构，再逐类查看实际产品');
for(const [i,item] of ['品牌与产品概况','产品架构总览与官网分类树','各大类的分类方式与产品图谱','研究范围与资料缺口'].entries()){
  text(directory,String(i+1).padStart(2,'0'),64,205+i*96,70,56,32,true,ACCENT);
  text(directory,item,170,205+i*96,1020,56,31,true);
}
notes(directory,[d.official_url]);
const brandPoints=d.brand_analysis?.length?d.brand_analysis:[
  {label:'品牌与官网',text:`${d.brand}\n${d.official_url}`,basis:'official',source_url:d.official_url},
  {label:'产品领域',text:displayRoots.map(n=>n.name).join('、'),basis:displayRoots.some(n=>n.basis==='inferred')?'inferred':'official',source_url:d.official_url},
  {label:'架构组织',text:'按官网产品线逐层展开。保留系列、软件、服务与配件的关系，分析整理的分类另行注明。',basis:'inferred',source_url:d.official_url}
];
for(let start=0;start<brandPoints.length;start+=3){
  const group=brandPoints.slice(start,start+3),s=page('品牌与产品概况','与产品线理解有关的品牌信息');
  group.forEach((a,i)=>{text(s,a.label+(a.basis==='inferred'?'（归纳）':''),64,205+i*140,330,110,26,true);text(s,a.text,420,205+i*140,790,110,23,false,INK);});
  notes(s,group.map(a=>a.source_url));
}

for(let start=0; start<displayRoots.length; start+=6){
  const s=page('产品线总览','官网导航与产品中心的主要分支，分析归纳另行标注');
  displayRoots.slice(start,start+6).forEach((n,i)=>{const y=195+i*72;text(s,n.name+(n.basis==='inferred'?'（归纳）':''),64,y,385,62,25,true);const labels=(children.get(n.id)||[]).map(c=>c.name);text(s,labels.length>5?`${labels.slice(0,5).join('、')} 等 ${labels.length} 个分类`:labels.join('、') || '独立产品类目',465,y,751,62,21,false,MUTED);});
  notes(s,[d.summary||'',...displayRoots.slice(start,start+6).flatMap(n=>[`${n.official_name}：${n.basis}`,n.source_url])]);
}
const flattened=[];
function visit(n,depth=0){flattened.push({n,depth});for(const c of children.get(n.id)||[])visit(c,depth+1);}
for(const n of roots)visit(n);
for(let start=0;start<flattened.length;start+=10){
  const first=flattened[start].n;const context=first.parent_id?`本页所属路径：${trail(nodes.get(first.parent_id))}`:'缩进表示父子关系，标为“归纳”的节点属于分析结构';
  const s=page(`官网分类层级 ${Math.floor(start/10)+1}`, context);
  const block=flattened.slice(start,start+10);
  block.forEach(({n,depth},i)=>{const y=190+i*45;const indent=Math.min(depth,6)*32;text(s,n.name+(n.basis==='inferred'?'（归纳）':''),64+indent,y,720-indent,40,depth===0?26:23,depth===0,depth===0?ACCENT:INK);text(s,n.official_name===n.name?'':n.official_name,805,y,410,40,18,false,MUTED);});
  notes(s,block.flatMap(({n})=>[trail(n),n.source_url]));
}

const imageNodes=d.nodes.filter(n=>n.selected_products?.length || !children.has(n.id));
function belongs(n,id){while(n){if(n.id===id)return true;n=n.parent_id?nodes.get(n.parent_id):null;}return false;}
async function productPages(n){
  const all=n.selected_products||[],parts=Math.max(1,Math.ceil(all.length/6));
  for(let part=0;part<parts;part++){
    const selected=all.slice(part*6,part*6+6),count=n.listed_count==null?'数量待核验':`官网列出 ${n.listed_count} 项`;
    const suffix=parts>1?`（${part+1}/${parts}）`:'';
    const s=page(n.name+suffix,`${trail(n)}　本类选取 ${all.length} / ${requested} 个产品　${count}`);
    if(!selected.length)text(s,n.gap||'官网产品清单暂不可读取，保留此分类',64,260,1152,180,28,false,MUTED);
    for(let i=0;i<selected.length;i++){
      const q=selected[i],small=selected.length<=3;
      const width=selected.length===1?620:selected.length===2?500:360;
      const x=selected.length===1?330:selected.length===2?100+i*575:64+(i%3)*389;
      const y=small?200:193+Math.floor(i/3)*225,ih=small?330:143;
      await image(s,q,x,y,width,ih);
      const code=q.name.match(/^(RG-[A-Za-z0-9()_.-]+)/)?.[1];
      const label=q.model||(code?code+(q.name.includes('系列')?' 系列':''):q.name);
      text(s,label,x,y+ih+5,width,50,label.length>40?19:23,true,INK,'center');
      const detail=q.feature||(q.image_kind==='official_scene'?'官方场景图':q.image_kind==='official_software'?'官方软件图':'');
      if(detail)text(s,detail,x,y+ih+59,width,small?62:29,17,false,MUTED,'center');
    }
    if(n.image_warning)text(s,n.image_warning,64,660,1152,24,15,false,MUTED);
    else if(all.length<requested)text(s,`此类按实际产品数量展示，共选取 ${all.length} 个。`,64,660,1152,24,15,false,MUTED);
    notes(s,[`分类：${trail(n)}（${n.basis}）`,n.source_url,`产品清单是否完整：${Boolean(n.inventory_complete)}`,n.selection_basis||'按官网顺序及系列差异选取代表产品',n.gap||'',...selected.flatMap(q=>[q.name,`产品页：${q.product_url}`,`图片：${q.image_url||'缺图'}`,`引用页：${q.image_evidence_url||n.source_url}`,q.image_error||''])]);
  }
}
for(const [index,root] of displayRoots.entries()){
  const category=page(`${String(index+1).padStart(2,'0')}　${root.name}`,'分类方式与下层产品');
  const sub=children.get(root.id)||[];
  if(sub.length)sub.slice(0,9).forEach((n,i)=>text(category,n.name+(n.basis==='inferred'?'（归纳）':''),64,205+i*46,1152,42,27,true));
  else text(category,root.official_name||root.name,64,235,1152,88,42,true);
  notes(category,[root.source_url,root.classification_logic||'']);
  const relevant=d.nodes.filter(n=>n.classification_logic && belongs(n,root.id));
  let s=null,y=0;
  for(const n of relevant){
    for(const [index,paragraph] of chunks(n.classification_logic).entries()){
      const height=Math.max(75,Math.ceil(weight(paragraph)/32)*28+24);
      if(!s||y+height>638){s=page(`${root.name} 的分类方式`,'官网分类及产品差异，分析整理的节点标为“归纳”');y=195;notes(s,[d.official_url]);}
      text(s,n.name+(index?'（续）':''),64,y,330,height-15,24,true);
      text(s,paragraph,420,y,795,height-15,22,false,INK);
      s.speakerNotes.text+='\n'+trail(n)+'\n'+n.source_url;y+=height;
    }
  }
  for(const n of imageNodes.filter(n=>belongs(n,root.id)))await productPages(n);
}
const gaps=d.delivery_gaps || d.coverage.notes;
const materialGaps=[...new Set(d.nodes.flatMap(n=>[...(n.gap?[`${trail(n)}：${n.gap}`]:[]),...(n.image_warning?[`${trail(n)}：${n.image_warning}`]:[]),...(n.selected_products||[]).filter(q=>q.image_error).map(q=>`${trail(n)} / ${q.name}：${q.image_error}`)]))];
const visibleGaps=materialGaps.flatMap(g=>chunks(g,180));
if(visibleGaps.length)for(let start=0;start<visibleGaps.length;start+=4){
  const s=page('研究范围与资料缺口','官网条目可能包含产品系列。选取数量不代表在售 SKU 总数');
  visibleGaps.slice(start,start+4).forEach((g,i)=>text(s,g,64,195+i*108,1152,98,21,false,MUTED));
  notes(s,d.sources.map(a=>a.url));
}
for(let i=0;i<pages.length;i++){text(pages[i].slide,`${d.brand}　${d.as_of}`,64,696,930,18,12,false,MUTED);text(pages[i].slide,`${i+1} / ${pages.length}`,1080,696,136,18,12,false,MUTED,'right');}
const candidate=path.join(BUILD,'candidate.pptx');
await(await PresentationFile.exportPptx(p)).save(candidate);
const renderDir=path.join(ROOT,'renders');await fs.mkdir(renderDir,{recursive:true});
for(let i=0;i<pages.length;i++){
  const png=await p.export({slide:pages[i].slide,format:'png',scale:1});
  await fs.writeFile(path.join(renderDir,`slide-${String(i+1).padStart(3,'0')}.png`),new Uint8Array(await png.arrayBuffer()));
  await fs.writeFile(path.join(ROOT,'progress.json'),JSON.stringify({stage:'ppt',message:`已排版并渲染 ${i+1}/${pages.length} 页`}));
}
const settings=await fs.readFile(path.join(path.dirname(fileURLToPath(import.meta.url)),'../runtime.local.json'),'utf8').then(JSON.parse).catch(()=>({}));
const runtime=process.env.BRAND_AGENT_RUNTIME || settings.runtime;
if(!runtime)throw new Error('请先按 SKILL.md 运行 configure_runtime.py，读取当前环境的工作区依赖');
process.env.RUNTIME_NODE_MODULES ||= path.join(runtime,'node/node_modules');
const skill=process.env.BRAND_AGENT_PRESENTATION_SKILL || settings.presentations;
if(!skill)throw new Error('未配置当前电脑的演示文稿导出组件');
const {finalizePresentation}=await import(pathToFileURL(path.join(skill,'container_tools/artifact_tool_utils.mjs')).href);
let stem='产品图谱.pptx',revision=2;
while(await fs.access(path.join(ROOT,'output',stem)).then(()=>true,()=>false))stem=`产品图谱_修订${revision++}.pptx`;
const output=path.join(ROOT,'output',stem);
const result=await finalizePresentation({workspaceDir:ROOT,candidatePath:candidate,finalPath:output,pythonExecutable:path.join(runtime,'python/bin/python3'),integrityValidatorPath:path.join(skill,'container_tools/inspect_presentation_package_integrity.py'),layoutValidatorPath:path.join(skill,'container_tools/inspect_presentation_layout_geometry.py'),layoutArgs:['--expected-slide-size-emu','12192000,6858000','--validate-heading-fit'],fontPolicy:{basis:'design',families:[FONT]},verifyArtifactToolImport:true,receiptPath:path.join(BUILD,`validation.${stem}.json`)});
const escape=v=>String(v||'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const sections=await Promise.all(imageNodes.map(async n=>`<section><h2>${escape(trail(n))}</h2><p>${escape(n.classification_logic||'')}</p><div class="products">${(await Promise.all((n.selected_products||[]).map(async q=>{const data=q.asset_path?`data:image/png;base64,${(await fs.readFile(path.resolve(ROOT,q.asset_path))).toString('base64')}`:'';return `<article>${data?`<img src="${data}" alt="${escape(q.name)}">`:'<div class="missing">官方图片暂缺</div>'}<h3>${escape(q.model||q.name)}</h3><p>${escape(q.feature)}</p><a href="${escape(q.product_url)}" target="_blank" rel="noreferrer">官网产品页</a>${q.asset_path&&q.image_evidence_url?` · <a href="${escape(q.image_evidence_url)}" target="_blank" rel="noreferrer">图片出处</a>`:''}</article>`;}))).join('')}</div></section>`));
const html=`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(d.brand)} 产品图谱</title><style>body{font-family:"PingFang SC",sans-serif;color:#182026;max-width:1200px;margin:48px auto;padding:0 24px}h1{font-size:40px}h2{font-size:25px}p{color:#607078}section{padding:24px 0;border-top:1px solid #dde3e6}.products{display:grid;grid-template-columns:repeat(3,1fr);gap:32px}img,.missing{width:100%;height:180px;object-fit:contain}a{color:${ACCENT}}article h3{font-size:19px}@media(max-width:700px){.products{grid-template-columns:repeat(2,1fr)}}@media(max-width:420px){.products{grid-template-columns:1fr}}</style><h1>${escape(d.brand)} 产品线图谱</h1><p>${escape(d.region)}　${escape(d.as_of)}　${d.coverage.status==='complete'?'已核验官网分类范围':'部分范围'}</p><p>${escape(d.summary)}</p><h2>品牌与产品概况</h2>${brandPoints.map(a=>`<h3>${escape(a.label)}</h3><p>${escape(a.text)}</p>`).join('')}<h2>官网分类结构</h2>${flattened.map(({n,depth})=>`<p style="margin-left:${depth*24}px">${escape(n.name)} ${n.basis==='inferred'?'（归纳）':''}</p>`).join('')}${sections.join('')}<section><h2>研究范围与资料缺口</h2>${gaps.map(g=>`<p>${escape(g)}</p>`).join('')}<h2>来源</h2>${d.sources.map(s=>`<p><a href="${escape(s.url)}">${escape(s.title)}</a></p>`).join('')}</section></html>`;
await fs.writeFile(path.join(ROOT,'output','产品图谱.html'),html);
execFileSync(path.join(runtime,'python/bin/python3'),[path.join(path.dirname(fileURLToPath(import.meta.url)),'export_pdf.py'),ROOT,'--pages',String(pages.length)],{stdio:'pipe'});
await fs.writeFile(path.join(ROOT,'result.json'),JSON.stringify({brand:d.brand,pages:pages.length,...d.stats,coverage:d.coverage.status,files:[`output/${stem}`,'output/产品图谱.html','output/产品图谱.pdf','官方产品图片与来源.zip','图片来源.csv','产品清单.csv'],gaps},null,2));
console.log(JSON.stringify({pages:pages.length,output,result}));

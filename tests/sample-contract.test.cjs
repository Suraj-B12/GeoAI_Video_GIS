'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {spawnSync}=require('node:child_process');
const test=require('node:test');
const D=require('../webgis/data.js');
function resolvePython({env=process.env,platform=process.platform,spawn=spawnSync}={}){
  const override=env.PYTHON?.trim();
  const candidates=override?[[override,[]]]:platform==='win32'?[['py',['-3']],['python',[]],['python3',[]]]:[['python3',[]],['python',[]]];
  const failures=[];
  for(const [command,args] of candidates){
    const probe=spawn(command,[...args,'-X','utf8','-c','import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)'],{encoding:'utf8',timeout:10000,windowsHide:true});
    if(probe.status===0)return {command,args};
    failures.push(`${command}: ${probe.error?.code||`exit ${probe.status}`}`);
  }
  throw new Error(`Python 3.9+ is required for the sample oracle. Set PYTHON to an executable name or full path (without command-line arguments). Tried ${failures.join('; ')}.`);
}
const sample=path.resolve(__dirname,'../gis_sample');
const read=p=>JSON.parse(fs.readFileSync(path.join(sample,p),'utf8'));
const meta=read('api/gis/meta.json');
const rows={video:read('api/gis/video/segments_point.geojson').features,citizen:read('api/gis/citizen/assessments.geojson').features};
const defaults={label:[],severity:[],review:'all',highConfidence:false,include_review:false,threshold:meta.confidence_threshold};
const filtered=(filters,layer='video')=>rows[layer].filter(f=>D.matches(f,{...defaults,...filters},meta,layer));

test('the Python oracle resolves platform launchers and explicit paths without silently ignoring a bad override',()=>{
  const calls=[];
  const success=command=>(name,args,options)=>{calls.push({name,args,options});return name===command?{status:0}:{status:null,error:{code:'ENOENT'}};};
  assert.deepEqual(resolvePython({env:{},platform:'win32',spawn:success('py')}),{command:'py',args:['-3']});
  assert.deepEqual(calls[0].args.slice(0,3),['-3','-X','utf8']);
  calls.length=0;
  assert.deepEqual(resolvePython({env:{},platform:'win32',spawn:success('python')}),{command:'python',args:[]});
  assert.deepEqual(calls.map(x=>x.name),['py','python']);
  calls.length=0;
  assert.deepEqual(resolvePython({env:{},platform:'linux',spawn:success('python')}),{command:'python',args:[]});
  assert.deepEqual(calls.map(x=>x.name),['python3','python']);
  const executable='C:\\Program Files\\Python\\python.exe';calls.length=0;
  assert.deepEqual(resolvePython({env:{PYTHON:executable},platform:'win32',spawn:success(executable)}),{command:executable,args:[]});
  assert.equal(calls[0].name,executable,'a path containing spaces is one executable, never a shell command');
  calls.length=0;
  assert.throws(()=>resolvePython({env:{PYTHON:'missing-python'},platform:'win32',spawn:success('python')}),/Python 3\.9\+.*PYTHON/);
  assert.deepEqual(calls.map(x=>x.name),['missing-python'],'an explicit unusable override must report failure');
  assert.throws(()=>resolvePython({env:{},platform:'linux',spawn:()=>({status:1})}),/Python 3\.9\+/,'interpreters failing the version probe are rejected');
});

test('real sample acceptance counts are reproduced by final-field client filters',()=>{
  assert.equal(filtered({}).length,813);
  assert.equal(filtered({label:['Potholes']}).length,131);
  assert.equal(filtered({severity:['Medium','High'],vlm_class:'distress'}).length,75);
  assert.equal(filtered({highConfidence:true,vlm_class:'distress'}).length,47);
  assert.equal(filtered({review:'needs'}).length,389);
  assert.equal(filtered({review:'reviewed'}).length,0);
  assert.equal(filtered({},'citizen').length,131);
  assert.equal(filtered({include_review:true},'citizen').length,344);
});

test('1,440 shared-filter combinations match the independently supplied Python API oracle',()=>{
  const cases=[];
  for(const layer of ['video','citizen'])for(const label of [[],...meta.labels.map(l=>[l.name])])for(const severity of [[],...meta.severities.map(s=>[s.name])])for(const review of ['all','needs','reviewed'])for(const highConfidence of [false,true]){
    const i=cases.length,day=layer==='video'?'2026-10-26':'2026-09-25';
    const filters={...defaults,label,severity,review,highConfidence,include_review:i%4!==0,date_from:i%5===0?day:'',date_to:i%5===0?day:'',vlm_class:i%7===0?'distress':''};
    cases.push({layer,filters,query:Object.fromEntries(D.params(filters,layer))});
  }
  assert.equal(cases.length,1440);
  const python=String.raw`
import json,sys,pathlib,datetime
sys.dont_write_bytecode=True
root=pathlib.Path(sys.argv[1]);sys.path.insert(0,str(root));import gis_core as core
cases=json.load(sys.stdin)
rows={l:json.loads((root/'api/gis'/l/('segments_point.geojson' if l=='video' else 'assessments.geojson')).read_text())['features'] for l in ['video','citizen']}
results=[]
for c in cases:
 f=c['filters'];q={}
 if c['layer']=='citizen':q['include_review']='true' if f['include_review'] else 'false'
 for k in ['label','severity']:
  if f[k]:q[k]=','.join(f[k])
 if f['vlm_class']:q['vlm_class']=f['vlm_class']
 if f['review']=='needs':q['needs_review']='true'
 if f['review']=='reviewed':q['reviewed']='true'
 if f['highConfidence']:q['min_confidence']=str(f['threshold'])
 if f['date_from']:q['date_from']=f['date_from']+'T00:00:00+05:30'
 if f['date_to']:q['date_to']=(datetime.date.fromisoformat(f['date_to'])+datetime.timedelta(days=1)).isoformat()+'T00:00:00+05:30'
 assert q==c['query'],(q,c['query'])
 selected=[x for x in rows[c['layer']] if core.matches(x['properties'],core.parse_filters(q,c['layer']))]
 results.append([str(x['id']) for x in selected])
json.dump(results,sys.stdout)
`;
  const interpreter=resolvePython();
  const result=spawnSync(interpreter.command,[...interpreter.args,'-X','utf8','-c',python,sample],{input:JSON.stringify(cases),encoding:'utf8',maxBuffer:12*1024*1024,timeout:60000,windowsHide:true});
  assert.equal(result.status,0,result.error?.message||result.stderr);
  const expected=JSON.parse(result.stdout);
  cases.forEach((c,i)=>assert.deepEqual(rows[c.layer].filter(f=>D.matches(f,c.filters,meta,c.layer)).map(f=>String(f.id)),expected[i],`case ${i}: ${JSON.stringify(c.filters)}`));
});

test('sample kilometre coverage partitions road length without adding overlapping labels',()=>{
  const sessions=read('api/gis/video/sessions.json').sessions;
  for(const session of sessions){
    const metres=session.per_km.reduce((sum,b)=>sum+D.perKmCoverage(b).reduce((n,c)=>n+c.metres,0),0);
    assert.ok(Math.abs(metres-session.surveyed_m-session.not_covered_m)<.02);
    for(const bin of session.per_km){const coverage=D.perKmCoverage(bin);assert.ok(coverage.every(c=>c.metres>=0));assert.ok(Math.abs(coverage.reduce((n,c)=>n+c.fraction,0)-1)<1e-9);}
  }
  const largest=sessions.find(s=>s.segments===528);
  assert.deepEqual(largest.per_km.map(b=>b.surveyed_m),[1000,1000,637.5]);
  const summary=read('api/gis/video/summary.json');
  const labelMetres=summary.labels.filter(l=>l.label!=='Normal').reduce((n,l)=>n+l.length_m,0);
  assert.ok(labelMetres>summary.distress_m,'labels overlap and must not be used as exclusive coverage');
  assert.equal(rows.video.filter(f=>f.properties.vlm_class==='distress'&&f.properties.final_severity==='None').length,7);
});

test('filters honor expert final fields, distinguish missing confidence from zero, and isolate layer-only scope',()=>{
  const base=structuredClone(rows.video[0]);
  base.properties={...base.properties,labels:['Potholes'],final_labels:['Normal'],marker_label:'Normal',final_primary_label:'Normal',final_severity:'None',severity:'High',vlm_class:'normal',confidence:0,expert_reviewed:true,needs_expert_review:false};
  assert.equal(D.matches(base,{...defaults,label:['Potholes']},meta,'video'),false);
  assert.equal(D.matches(base,{...defaults,label:['Normal'],review:'reviewed'},meta,'video'),true);
  const zeroMeta={...meta,confidence_threshold:0};
  assert.equal(D.matches(base,{...defaults,threshold:0,highConfidence:true},zeroMeta,'video'),true);
  base.properties.confidence=null;
  assert.equal(D.matches(base,{...defaults,threshold:0,highConfidence:true},zeroMeta,'video'),false);
  const citizen=structuredClone(rows.citizen[0]);citizen.properties.assessment_status='classified';
  assert.equal(D.matches(citizen,{...defaults,session:'not-the-citizen-layer',status:'not_covered'},meta,'citizen'),true);
});

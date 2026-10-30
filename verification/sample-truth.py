import collections, hashlib, importlib.util, json, pathlib, sys
sys.dont_write_bytecode=True
root=pathlib.Path(__file__).resolve().parents[1]/'gis_sample'
spec=importlib.util.spec_from_file_location('qa_gis_core',root/'gis_core.py');core=importlib.util.module_from_spec(spec);sys.modules[spec.name]=core;spec.loader.exec_module(core)
read=lambda path:json.loads((root/path).read_text())
v=read('api/gis/video/segments.geojson')['features']; c=read('api/gis/citizen/assessments.geojson')['features'];summary=read('api/gis/video/summary.json');sessions=read('api/gis/video/sessions.json')['sessions'];meta=read('api/gis/meta.json');manifest=read('manifest.json')
checks=[]
def check(name,actual,expected):
    passed=abs(actual-expected)<0.011 if isinstance(actual,(float,int)) and isinstance(expected,(float,int)) else actual==expected
    checks.append(dict(name=name,actual=actual,expected=expected,passed=passed))
def count(q,layer='video'):
    return core.apply(v if layer=='video' else c,core.parse_filters(q,layer))[1]
check('video_total',len(v),813);check('citizen_default',count({},'citizen'),131);check('citizen_include_review',count({'include_review':'true'},'citizen'),344)
for name,q,n in [('potholes',{'label':'Potholes'},131),('medium_high_distress',{'severity':'Medium,High','vlm_class':'distress'},75),('high_confidence_distress',{'min_confidence':'0.8','vlm_class':'distress'},47),('needs_review',{'needs_review':'true'},389),('reviewed',{'reviewed':'true'},0)]:check(name,count(q),n)
computed=core.aggregate([f['properties'] for f in v])
for k in computed:check('summary:'+k,computed[k],summary[k])
check('video_id_uniqueness',len({f['id'] for f in v}),len(v))
check('all_segments_send',all(f['properties']['status']=='send' for f in v),True)
check('all_segments_answered',all(f['properties']['answered'] for f in v),True)
check('all_segments_preview_urls',all(f['properties'].get('thumb_url') and '?w=480' in f['properties']['thumb_url'] and '?w=1280' in f['properties'].get('preview_url','') for f in v),True)
check('preview_w480_files',len(list((root/'images/w480').glob('*.jpg'))),813)
check('preview_w1280_files',len(list((root/'images/w1280').glob('*.jpg'))),813)
for s in sessions:
    check('session_segments:'+s['session_id'],len([f for f in v if f['properties']['session_id']==s['session_id']]),s['segments'])
    for key in ['surveyed_m','not_covered_m','classified_m','distress_m','normal_m']:
        check('per_km_sum:'+s['session_id']+':'+key,round(sum(b[key] for b in s['per_km']),2),s[key])
    p=[f['properties'] for f in v if f['properties']['session_id']==s['session_id']]
    check('per_km_recomputed:'+s['session_id'],core.per_km(p),s['per_km'])
manifest_bad=[]
for item in manifest['files']:
    blob=(root/item['path']).read_bytes()
    if len(blob)!=item['bytes'] or hashlib.sha256(blob).hexdigest()!=item['sha256']:manifest_bad.append(item['path'])
check('manifest_integrity_failures',manifest_bad,[])
result=dict(checks=checks,passed=sum(t['passed'] for t in checks),total=len(checks),manifest_files_verified=len(manifest['files']),summary=computed,sessions=[{k:s.get(k) for k in ['session_id','road_name','road_id','local_date','state','segments','route_m','surveyed_m','classified_m','distress_m','not_covered_m','pct_distress_of_surveyed','per_km']} for s in sessions],diagnostics=dict(gate_counterfactual=dict(collections.Counter(f['properties'].get('gate_decision_if_gated') for f in v)),distress_with_none_severity=sum(f['properties']['vlm_class']=='distress' and f['properties']['final_severity']=='None' for f in v),multi_label_distress=sum(f['properties']['vlm_class']=='distress' and len(f['properties']['final_labels'])>1 for f in v),sum_distress_label_metres=round(sum(l['length_m'] for l in computed['labels'] if l['label']!='Normal'),2)))
pathlib.Path(__file__).with_name('sample-truth.json').write_text(json.dumps(result,indent=2))
print(json.dumps({k:result[k] for k in ['passed','total','manifest_files_verified','diagnostics']},indent=2))
assert result['passed']==result['total']

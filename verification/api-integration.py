import hashlib,json,pathlib,sys,urllib.request,urllib.error,urllib.parse
base=(sys.argv[1] if len(sys.argv)>1 else 'http://127.0.0.1:8876').rstrip('/')
checks=[]
def get(path):
 with urllib.request.urlopen(base+path,timeout=15) as r:return r.status,r.headers,r.read()
def check(name,ok,detail=None):checks.append({'name':name,'passed':bool(ok),'detail':detail})
def data(path):return json.loads(get(path)[2])
m=data('/gis/meta');check('metadata_schema',m['schema']=='geoai.gis.v1')
for query,expected in [('',813),('label=Potholes',131),('severity=Medium,High&vlm_class=distress',75),('min_confidence=0.8&vlm_class=distress',47),('needs_review=true',389)]:
 p=data('/gis/video/segments.geojson?geom=point&limit=20000&'+query);s=data('/gis/video/summary?'+query)
 check('query '+query,p['numberMatched']==expected and len(p['features'])==expected and s['segments']==expected,{'expected':expected,'matched':p['numberMatched'],'summary':s['segments']})
sessions=data('/gis/video/sessions?track=true&per_km=true')['sessions'];check('three_drives',len(sessions)==3)
for s in sessions:check('per_km '+s['session_id'],abs(sum(b['surveyed_m'] for b in s['per_km'])-s['surveyed_m'])<.02)
p=data('/gis/video/segments.geojson?geom=point&limit=3&label=Potholes')['features'][0]['properties']
for key,width in [('thumb_url',480),('preview_url',1280)]:
 status,headers,blob=get(p[key]);check(key,status==200 and headers.get_content_type()=='image/jpeg' and blob[:2]==b'\xff\xd8',{'bytes':len(blob)})
_,_,csv=get('/gis/video/segments.csv?label=Potholes&limit=20000');check('csv_bom_unicode',csv.startswith(b'\xef\xbb\xbf') and '§' in csv.decode('utf-8-sig'))
try:get('/gis/video/segments.geojson?label=Pothole');check('invalid_label_400',False)
except urllib.error.HTTPError as e:check('invalid_label_400',e.code==400 and 'detail' in json.loads(e.read()))
_,_,html=get('/gis/app/');check('static_mount',b'<html' in html.lower())
check('video_survey_navigation',b'id="videoNav"' in html and b'id="surveyNav"' in html and b'id="mapNav"' not in html)
check('no_citizen_interface',b'citizen' not in html.lower())
_,_,app=get('/gis/app/app.js');check('no_citizen_endpoint',b'/gis/citizen/' not in app)
_,_,config=get('/gis/app/config.js');check('same_origin_default',b'apiBase: ""' in config or b"apiBase: ''" in config)
result={'base':base,'passed':sum(x['passed'] for x in checks),'total':len(checks),'checks':checks};pathlib.Path(__file__).with_name('api-integration-results.json').write_text(json.dumps(result,indent=2));print(json.dumps(result,indent=2));assert result['passed']==result['total']

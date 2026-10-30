"""Exact-image app rollouts; SMTP retains its paired read-only origin checks."""
import copy
import hashlib
import json
import shlex
import subprocess
import time
import urllib.error
import urllib.request

CLOUD='do-nyc1-k8s-1-33-1-do-1-nyc1-1752275240114'
TARGETS={'stripe':('saleor-stripe-app-prod','saleor-stripe-app-prod'),
         'fief':('saleor-app-fief','saleor-app-fief'),'smtp':('saleor-app-smtp','saleor-app-smtp')}


def kube(site,namespace,*args,body=None):
    if site=='cloud':command=['kubectl','--context',CLOUD,'-n',namespace,*args]
    else:
        remote=['/srv/ai/opensensor-hosting/home/bin/kubectl','--kubeconfig',
                '/srv/ai/opensensor-hosting/config/kubeconfig','-n',namespace,*args]
        command=['ssh','-o','BatchMode=yes','-o','ConnectTimeout=8','opensensor-hosting@192.168.53.187',shlex.join(remote)]
    result=subprocess.run(command,input=body,text=True,capture_output=True,timeout=650)
    if result.returncode:raise RuntimeError('Cluster operation failed: '+result.stderr[:300])
    return result.stdout


def get(site,namespace,kind,name):return json.loads(kube(site,namespace,'get',kind,name,'-o','json'))


def patch(site,namespace,kind,obj,changes):
    operations=[{'op':'test','path':'/metadata/resourceVersion','value':obj['metadata']['resourceVersion']},*changes]
    kube(site,namespace,'patch',kind,obj['metadata']['name'],'--type=json','--patch-file=/dev/stdin',body=json.dumps(operations))


def wait(label,probe,seconds=600):
    deadline=time.monotonic()+seconds
    while time.monotonic()<deadline:
        try:
            if probe():return
        except (urllib.error.URLError,TimeoutError):pass
        time.sleep(3)
    raise RuntimeError('Timed out: '+label)


def verified(deployment,pods,container,target):
    spec,status=deployment['spec'],deployment.get('status',{});count=spec.get('replicas',0)
    if count<1 or status.get('observedGeneration',0)<deployment['metadata']['generation']:return False
    if any(status.get(k,0)!=count for k in ('replicas','updatedReplicas','readyReplicas')):return False
    if len(pods)!=count:return False
    for pod in pods:
        if pod['metadata'].get('deletionTimestamp'):return False
        if pod['metadata'].get('annotations',{}).get('opensensor.io/source-revision')!=target['commit']:return False
        c=next((c for c in pod['spec']['containers'] if c['name']==container),{})
        s=next((s for s in pod.get('status',{}).get('containerStatuses',[]) if s['name']==container),{})
        if c.get('image')!=target['image'] or not s.get('ready') or not s.get('imageID','').endswith(target['image'].split('@')[1]):return False
    return True


def verify(site,namespace,name,container,target):
    d=get(site,namespace,'deploy',name)
    labels=','.join(k+'='+v for k,v in d['spec']['selector']['matchLabels'].items())
    pods=json.loads(kube(site,namespace,'get','pods','-l',labels,'-o','json'))['items']
    return verified(d,pods,container,target)


def roll(site,namespace,name,container,target,environment=None):
    d=get(site,namespace,'deploy',name);template=copy.deepcopy(d['spec']['template'])
    annotations=template.setdefault('metadata',{}).setdefault('annotations',{})
    if int(annotations.get('opensensor.io/build-run','0'))>target['run_id']:raise RuntimeError('A newer app build is already deployed')
    annotations.update({'opensensor.io/source-revision':target['commit'],'opensensor.io/build-run':str(target['run_id'])})
    matches=[c for c in template['spec']['containers'] if c['name']==container]
    if len(matches)!=1:raise RuntimeError('Application container identity changed')
    c=matches[0];c['image']=target['image']
    values={'SENTRY_RELEASE':'saleor-'+target['app']+'@'+target['commit'],**(environment or {})}
    c['env']=[e for e in c.get('env',[]) if e['name'] not in values]+[{'name':k,'value':v} for k,v in values.items()]
    if template!=d['spec']['template']:patch(site,namespace,'deploy',d,[{'op':'replace','path':'/spec/template','value':template}])
    kube(site,namespace,'rollout','status','deploy/'+name,'--timeout=600s')
    wait(name+' actual image',lambda:verify(site,namespace,name,container,target),180)


def placement():return get('cloud','whitewhale','cm','smtp-hosting-placement')


def public():
    with urllib.request.urlopen('https://smtp.mattscoinage.com/api/manifest',timeout=20) as r:
        if r.status!=200 or json.load(r).get('id')!='saleor.app.smtp':raise RuntimeError('SMTP manifest invalid')
        return r.headers.get('X-OpenSensor-Location')


def smtp(target,directory):
    revision=f'ci-app-{target["run_id"]}-{target["run_attempt"]}'
    path=directory/'progress.json'
    if path.exists():state=json.loads(path.read_text())
    else:
        data=placement()['data']
        if data.get('desired')!='local' or any(data.get(k) for k in ('hold','release_hold','maintenance_hold')):
            raise RuntimeError('Existing SMTP maintenance or release must finish')
        code=get('local','mattscoinage-hosting','cm','mattscoinage-local-smtp')['data']['hosting-runtime.cjs']
        state={'target':target,'phase':0,'initial_revision':data.get('revision',''),
               'code_sha256':hashlib.sha256(code.encode()).hexdigest(),
               'release':hashlib.sha256(target['image'].encode()+code.encode()).hexdigest()}
        save_progress(path,state)
    if state['target']!=target:raise RuntimeError('SMTP handoff belongs to another build')
    def intent(values):
        current=placement();data=current['data']
        if (data.get('revision','') not in (state['initial_revision'],revision)
                or data.get('release_hold') not in ('',None,revision)
                or any(data.get(k) for k in ('hold','maintenance_hold'))):
            raise RuntimeError('Another operator owns SMTP placement')
        patch('cloud','whitewhale','cm',current,[{'op':'add','path':'/data/'+k,'value':str(v)}
              for k,v in values.items()])
    def owned():
        data=placement()['data']
        if data.get('revision')!=revision or data.get('release_hold')!=revision or data.get('desired')!='cloud':
            raise RuntimeError('SMTP release hold changed')
    def stage(number,action):
        if state['phase']<number:
            action();state['phase']=number;save_progress(path,state)
    def warm():
        intent({'recovery_test_until':time.time()+1800})
        wait('SMTP cloud ready',lambda:get('cloud','whitewhale','deploy','saleor-app-smtp').get('status',{}).get('readyReplicas')==1)
    def hold():
        intent({'revision':revision,'release_hold':revision,'desired':'cloud'})
        wait('SMTP public cloud',lambda:public()=='cloud')
        # Existing in-flight webhooks finish before changing the local origin.
        end=time.monotonic()+120
        while time.monotonic()<end:owned();time.sleep(3)
    def cloud():
        owned();roll('cloud','whitewhale','saleor-app-smtp','saleor-app-smtp',target)
    def local():
        owned()
        code=get('local','mattscoinage-hosting','cm','mattscoinage-local-smtp')['data']['hosting-runtime.cjs']
        if hashlib.sha256(code.encode()).hexdigest()!=state['code_sha256']:raise RuntimeError('SMTP origin guard changed during release')
        roll('local','mattscoinage-hosting','mattscoinage-local-smtp','app',target,{'HOSTING_RELEASE':state['release']})
    def gateway():
        owned();d=get('cloud','whitewhale','deploy','smtp-hosting-gateway');template=copy.deepcopy(d['spec']['template'])
        c=next(c for c in template['spec']['containers'] if c['name']=='controller')
        values={'EXPECTED_IMAGE':target['image'],'EXPECTED_RELEASE':state['release']}
        c['env']=[e for e in c.get('env',[]) if e['name'] not in values]+[{'name':k,'value':v} for k,v in values.items()]
        if template!=d['spec']['template']:patch('cloud','whitewhale','deploy',d,[{'op':'replace','path':'/spec/template','value':template}])
        kube('cloud','whitewhale','rollout','status','deploy/smtp-hosting-gateway','--timeout=600s')
    def return_local():
        # Controller probes authenticated local dependencies and the exact release.
        code="import json,urllib.request; print(urllib.request.urlopen('http://127.0.0.1:9901/state',timeout=10).read().decode())"
        def healthy():
            data=json.loads(kube('cloud','whitewhale','exec','deploy/smtp-hosting-gateway','-c','controller','--','python','-c',code))
            return (data.get('api_ok') and data.get('local_healthy') and data.get('cloud_ready') and data.get('release_matches'))
        data=placement()['data']
        if data.get('release_hold')==revision:
            owned()
            wait('SMTP origin dependencies and release',healthy)
            intent({'desired':'local','release_hold':'','recovery_test_until':'0'})
        elif data.get('revision')!=revision or data.get('desired')!='local' or any(data.get(k) for k in ('hold','release_hold','maintenance_hold')):
            raise RuntimeError('SMTP return was superseded')
        wait('SMTP local serving and cloud drained',lambda:public()=='local' and get('cloud','whitewhale','deploy','saleor-app-smtp')['spec']['replicas']==0)
    stage(1,warm);stage(2,hold);stage(3,cloud);stage(4,local);stage(5,gateway);stage(6,return_local)
    if public()!='local' or not verify('local','mattscoinage-hosting','mattscoinage-local-smtp','app',target):raise RuntimeError('SMTP final image verification failed')
    cloud=get('cloud','whitewhale','deploy','saleor-app-smtp')
    if cloud['spec']['replicas']!=0 or cloud['spec']['template']['spec']['containers'][0]['image']!=target['image']:raise RuntimeError('SMTP recovery image differs')
    return {'local_ready':True,'cloud_recovery_verified':True}


def deploy(target,directory):
    if target['app']=='smtp':return smtp(target,directory)
    name,container=TARGETS[target['app']]
    roll('cloud','whitewhale',name,container,target)
    return {'production_ready':True}


def save_progress(path,state):
    temp=path.with_suffix('.tmp');temp.write_text(json.dumps(state));temp.replace(path)

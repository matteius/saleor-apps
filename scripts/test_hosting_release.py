import copy
import importlib
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

with patch.dict(os.environ,{'RELEASE_APP':'smtp'}):
    import hosting_release as agent
import hosting_runtime as runtime
from hosting_release_manifest import platform_digest

IMAGE='ghcr.io/matteius/saleor-smtp@sha256:'+'a'*64
COMMIT='b'*40
TARGET=dict(format='saleor-app-release-v1',repository=agent.REPO,commit=COMMIT,
            run_id=100,run_attempt=1,image=IMAGE,app='smtp')
WORKFLOW=dict(event='push',head_branch='main',path=agent.WORKFLOW,
              repository={'full_name':agent.REPO},head_sha=COMMIT,id=100,run_attempt=1)

class ReleaseTests(unittest.TestCase):
    def test_app_and_image_must_match_exact_main_artifact(self):
        self.assertEqual(agent.validate(TARGET,WORKFLOW),TARGET)
        for key,value in [('run_id',99),('app','stripe'),('image',IMAGE.replace('smtp','stripe')),
                          ('image','ghcr.io/matteius/saleor-smtp:latest')]:
            with self.subTest(key=key),self.assertRaises(ValueError):agent.validate({**TARGET,key:value},WORKFLOW)
        with self.assertRaises(ValueError):agent.validate(TARGET,{**WORKFLOW,'event':'pull_request'})
    def test_active_handoff_finishes_before_newer_build(self):
        newer={**TARGET,'run_id':101}
        self.assertEqual(agent.choose(TARGET,newer,{}),TARGET)
        with self.assertRaises(RuntimeError):agent.choose({},TARGET,{**newer,'state':'success'})
    def test_image_verification_checks_app_container_and_terminating_pods(self):
        d={'metadata':{'generation':1},'spec':{'replicas':1},
           'status':{'observedGeneration':1,'replicas':1,'updatedReplicas':1,'readyReplicas':1}}
        pod={'metadata':{'annotations':{'opensensor.io/source-revision':COMMIT}},
             'spec':{'containers':[{'name':'app','image':IMAGE},{'name':'guard','image':'guard'}]},
             'status':{'containerStatuses':[{'name':'app','imageID':IMAGE,'ready':True}]}}
        self.assertTrue(runtime.verified(d,[pod],'app',TARGET))
        old=copy.deepcopy(pod);old['status']['containerStatuses'][0]['imageID']='old'
        self.assertFalse(runtime.verified(d,[old],'app',TARGET))
        old=copy.deepcopy(pod);old['metadata']['deletionTimestamp']='fixture'
        self.assertFalse(runtime.verified(d,[pod,old],'app',TARGET))
    def test_smtp_resume_preserves_another_operator_hold(self):
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)
            runtime.save_progress(path/'progress.json',{'target':TARGET,'phase':0,'initial_revision':'old'})
            with patch.object(runtime,'placement',return_value={'data':{'revision':'another','release_hold':'another'}}),patch.object(runtime,'kube') as mutate:
                with self.assertRaisesRegex(RuntimeError,'Another operator'):runtime.smtp(TARGET,path)
                mutate.assert_not_called()
    def test_platform_manifest_excludes_provenance(self):
        document={'manifests':[{'platform':{'os':'unknown','architecture':'unknown'},'digest':'attestation'},
                              {'platform':{'os':'linux','architecture':'amd64'},'digest':'runtime'}]}
        self.assertEqual(platform_digest(document,'index'),'runtime')

if __name__=='__main__':unittest.main()

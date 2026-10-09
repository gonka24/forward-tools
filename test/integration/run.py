"""Run tools on the pinned disposable Gonka cluster inside the existing private runner.
Requires the reviewed E2E build volume; never mounts the host Docker socket.
"""
import os
from pathlib import Path
import subprocess
import sys
import time
sys.path.insert(0,'/app')
from forward_e2e.suite.supervisor import DinDSupervisor
root=Path('/workspace/e2e-usdt-exact-r2-20261009')
out=Path('/tools/.forward/local-live');out.mkdir(parents=True,exist_ok=True)
supervisor=DinDSupervisor(Path('/workspace'))
supervisor.start_dockerd()
proxy=subprocess.Popen(['/opt/node/bin/node','/tools/test/integration/proxy.mjs'])
os.environ.update(E2E_SETTLEMENT_TOKEN='mainnet-usdt',E2E_EXPECTED_GONKA_SHA='136041c81ea8ff38e7620d76af66a7c7fe7eec50',E2E_EXPECTED_PROTO_SHA='379bebced638aeb5e6077bfd51c986f898443832',E2E_EVIDENCE_MODEL='a8.evidence/e2e-immutable-source/2')
try:
    stamp=str(time.time_ns());run_ids=[]
    for scenario in ['terminal-release-repeat','claim-expiry-positive']:
        cmd=['python3','-B','/tools/test/integration/harness.py','run-live','--marketplace-dir',str(root/'src/contracts'),'--gonka-dir',str(root/'src/gonka'),'--manifest',str(root/'run/build/a9-release/build-manifest.json'),'--scenario',scenario,'--run-id','tools-'+scenario,'--work-root','/workspace/tools-live-'+scenario,'--evidence-dir',str(out/'evidence'),'--gradle-user-home',str(root/'run/build/gradle-home'),'--timeout-minutes','50','--expected-marketplace-sha','4092b665c97b87f937d4c4c230870cebb038a4d8']
        run_id='tools-'+scenario+'-'+stamp;run_ids.append(run_id)
        cmd[cmd.index('--run-id')+1]=run_id;cmd[cmd.index('--work-root')+1]+='-'+stamp
        cmd += ['--expected-gonka-sha','136041c81ea8ff38e7620d76af66a7c7fe7eec50','--expected-proto-sha','379bebced638aeb5e6077bfd51c986f898443832','--evidence-model','a8.evidence/e2e-immutable-source/2']
        subprocess.run(cmd,check=True)
finally:
    proxy.terminate();proxy.wait(timeout=10)
    # Teardown only E2E-owned resources on this private daemon.
    ids=[]
    for run_id in run_ids:
        ids += subprocess.run(['docker','ps','-aq','--filter','label=io.gonka.a8.run-id='+run_id],capture_output=True,text=True).stdout.split()
    if ids:subprocess.run(['docker','rm','-f',*ids],check=True)
    supervisor.stop_dockerd()

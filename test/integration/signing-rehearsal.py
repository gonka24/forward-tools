"""Interactive signing adapter test using only a disposable encrypted fixture keyring."""
import errno,json,os,pty,select,subprocess,sys,time
master,slave=pty.openpty()
cmd=['/tools/.forward/node24/bin/node','/tools/test/integration/signing-rehearsal.mjs',sys.argv[1]]
p=subprocess.Popen(cmd,stdin=slave,stdout=slave,stderr=slave,cwd='/tools');os.close(slave)
buf=b'';pending=b'';deadline=time.monotonic()+120
while time.monotonic()<deadline:
    if select.select([master],[],[],1)[0]:
        try:data=os.read(master,65536)
        except OSError as e:
            if e.errno==errno.EIO:break
            raise
        if not data:break
        buf+=data;pending+=data
        # The password belongs only to this synthetic fixture; never read any user's password.
        if b'passphrase' in pending.lower() and pending.rstrip().endswith(b':'):
            os.write(master,b'synthetic-tools-only\n');pending=b''
    if p.poll() is not None:break
if p.poll() is None:p.kill()
p.wait();os.close(master)
if p.returncode!=0:
    print(buf.decode(errors='replace')[-2000:],file=sys.stderr);raise SystemExit(1)
lines=buf.decode(errors='replace').splitlines();results=[json.loads(x) for x in lines if x.startswith('{')]
assert results and results[-1]['status']=='PASSED'
print(json.dumps(results[-1]))

"""Index the prefixed UnityFS bundles in data-inspect (strip the 2-byte prefix, load with UnityPy, record
container names, CAB names, dependencies and object types). One JSON object per line.

Usage: uv run scripts/build_bundle_index.py .inspect-tmp/ios_index.jsonl data-inspect/ios-full/ios
"""
import sys, json, collections, os
from concurrent.futures import ProcessPoolExecutor
import UnityPy

def index_one(path):
    try:
        data = open(path, 'rb').read()
        if data[2:9] == b'UnityFS':
            data = data[2:]
        env = UnityPy.load(data)
        types = collections.Counter(o.type.name for o in env.objects)
        cabs, ext = [], set()
        for bf in env.files.values():
            for k, v in getattr(bf, 'files', {}).items():
                cabs.append(k)
                for e in getattr(v, 'externals', []):
                    ext.add(e.path.split('/')[-1])
        return {'file': path, 'cabs': cabs, 'deps': sorted(ext - set(cabs)),
                'containers': sorted(env.container.keys()), 'types': dict(types)}
    except Exception as ex:
        return {'file': path, 'error': f'{type(ex).__name__}: {ex}'[:200]}

if __name__ == '__main__':
    out, files = sys.argv[1], sys.argv[2:]
    if len(files) == 1 and os.path.isdir(files[0]):
        files = [os.path.join(r, f) for r, _, fs in os.walk(files[0]) for f in fs]
    with ProcessPoolExecutor() as ex, open(out, 'w') as fh:
        for i, rec in enumerate(ex.map(index_one, files, chunksize=64)):
            fh.write(json.dumps(rec) + '\n')
            if i % 5000 == 0: print(f'{i}/{len(files)}', flush=True)
    print('done', len(files))

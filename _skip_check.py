import os, sys
sys.path.insert(0, r'C:\Users\soura\Downloads\atlas-ielts-academy\atlas-ielts-academy\backend')
os.environ.setdefault('JWT_SECRET', 'verify' * 8)
import importlib
os.chdir(r'C:\Users\soura\Downloads\atlas-ielts-academy\atlas-ielts-academy\backend')
ds = importlib.import_module('app.services.day_service')
src = open(r'C:\Users\soura\Downloads\atlas-ielts-academy\atlas-ielts-academy\backend\app\services\day_service.py', encoding='utf-8').read()
print('skip branch present:', 'module_data.get("skipped")' in src)
print('empty-bands guard present:', 'Every module was skipped today' in src)
bands = [6.0, 6.5, 7.0]
print('overall from 3 bands (6.0,6.5,7.0):', ds.round_band(sum(bands) / len(bands)), '(expect 6.5)')

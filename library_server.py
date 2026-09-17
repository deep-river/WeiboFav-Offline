#!/usr/bin/env python3
"""A local-only SQLite server for the offline Weibo library."""
from __future__ import annotations

import argparse, hashlib, json, mimetypes, os, shutil, sqlite3
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse

ROOT = Path(__file__).resolve().parent
DATA = Path(os.environ.get('WEIBOFAV_DATA_DIR', ROOT / 'data')).expanduser().resolve()
MEDIA, DB, BUILD = DATA / 'media', DATA / 'library.sqlite3', ROOT / 'dist' / 'client'
SCHEMA = '''CREATE TABLE IF NOT EXISTS posts (id TEXT PRIMARY KEY, author TEXT NOT NULL, published_at TEXT NOT NULL, source_url TEXT NOT NULL, source TEXT NOT NULL, text TEXT NOT NULL, repost_text TEXT, repost_author TEXT, captured_at TEXT NOT NULL, tags_json TEXT NOT NULL); CREATE TABLE IF NOT EXISTS media (id TEXT PRIMARY KEY, post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE, kind TEXT NOT NULL CHECK(kind IN ('image','video-thumbnail')), relative_path TEXT NOT NULL, original_url TEXT NOT NULL, bytes INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS sync_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP); CREATE TABLE IF NOT EXISTS capture_jobs (source_url TEXT PRIMARY KEY, favorite_page INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','captured','skipped_deleted','failed')), attempts INTEGER NOT NULL DEFAULT 0, discovered_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP); CREATE TABLE IF NOT EXISTS local_tombstones (source_url TEXT PRIMARY KEY, post_id TEXT NOT NULL, deleted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, reason TEXT NOT NULL DEFAULT 'local_delete'); CREATE TABLE IF NOT EXISTS favorite_observations (source_url TEXT PRIMARY KEY, first_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, last_favorite_page INTEGER NOT NULL, sightings INTEGER NOT NULL DEFAULT 1); CREATE INDEX IF NOT EXISTS idx_posts_published_at ON posts(published_at DESC); CREATE INDEX IF NOT EXISTS idx_media_post_id ON media(post_id); CREATE INDEX IF NOT EXISTS idx_capture_jobs_state ON capture_jobs(state, favorite_page); CREATE INDEX IF NOT EXISTS idx_favorite_observations_page ON favorite_observations(last_favorite_page);'''

def connect():
  conn = sqlite3.connect(DB); conn.row_factory = sqlite3.Row; conn.execute('PRAGMA foreign_keys = ON'); return conn
def local_path(value):
  path = (DATA / value).resolve()
  if MEDIA not in path.parents: raise ValueError('invalid media path')
  return path
def initialize():
  DATA.mkdir(parents=True, exist_ok=True); MEDIA.mkdir(parents=True, exist_ok=True)
  with connect() as conn:
    conn.executescript(SCHEMA)
    columns = {row['name'] for row in conn.execute('PRAGMA table_info(posts)')}
    if 'is_favorited' not in columns: conn.execute('ALTER TABLE posts ADD COLUMN is_favorited INTEGER NOT NULL DEFAULT 1')
    if 'last_seen_at' not in columns: conn.execute('ALTER TABLE posts ADD COLUMN last_seen_at TEXT')
    if 'original_url' not in columns: conn.execute('ALTER TABLE posts ADD COLUMN original_url TEXT')
    if 'expected_media_count' not in columns: conn.execute('ALTER TABLE posts ADD COLUMN expected_media_count INTEGER NOT NULL DEFAULT 0')
    media_columns = {row['name'] for row in conn.execute('PRAGMA table_info(media)')}
    if 'sha256' not in media_columns: conn.execute('ALTER TABLE media ADD COLUMN sha256 TEXT')
    if 'downloaded_at' not in media_columns: conn.execute('ALTER TABLE media ADD COLUMN downloaded_at TEXT')
    job_columns = {row['name'] for row in conn.execute('PRAGMA table_info(capture_jobs)')}
    if 'last_error' not in job_columns: conn.execute('ALTER TABLE capture_jobs ADD COLUMN last_error TEXT')
    if conn.execute('SELECT COUNT(*) FROM posts').fetchone()[0]: return
    sample = DATA / 'sample.json'
    if not sample.is_file(): return
    for post in json.loads(sample.read_text(encoding='utf-8')):
      conn.execute('INSERT INTO posts (id,author,published_at,source_url,source,text,repost_text,repost_author,captured_at,tags_json,is_favorited,last_seen_at,original_url,expected_media_count) VALUES (?,?,?,?,?,?,?,?,?,?,1,CURRENT_TIMESTAMP,?,?)', (post['id'], post['author'], post['publishedAt'], post['sourceUrl'], post['source'], post['text'], post.get('repostText'), post.get('repostAuthor'), post['capturedAt'], json.dumps(post.get('tags', []), ensure_ascii=False), post.get('originalUrl'), len(post['media'])))
      for media in post['media']:
        path = local_path(media['path'])
        conn.execute('INSERT INTO media (id,post_id,kind,relative_path,original_url,bytes,sha256,downloaded_at) VALUES (?,?,?,?,?,?,?,CURRENT_TIMESTAMP)', (media['id'], post['id'], media['kind'], media['path'], media['originalUrl'], path.stat().st_size, hashlib.sha256(path.read_bytes()).hexdigest()))
    conn.execute('PRAGMA optimize')
def library(page=1, page_size=20, query='', media_kind='all'):
  page = max(1, int(page)); page_size = min(50, max(10, int(page_size)))
  filters, values = [], []
  if query:
    filters.append('(author LIKE ? OR text LIKE ? OR repost_text LIKE ? OR tags_json LIKE ?)')
    needle = f'%{query}%'; values.extend([needle, needle, needle, needle])
  if media_kind == 'image': filters.append("EXISTS (SELECT 1 FROM media WHERE media.post_id = posts.id AND media.kind = 'image')")
  if media_kind == 'video': filters.append("EXISTS (SELECT 1 FROM media WHERE media.post_id = posts.id AND media.kind = 'video-thumbnail')")
  where = f" WHERE {' AND '.join(filters)}" if filters else ''
  with connect() as conn:
    posts = []
    total = conn.execute(f'SELECT COUNT(*) FROM posts{where}', values).fetchone()[0]
    offset = (page - 1) * page_size
    for row in conn.execute(f'SELECT * FROM posts{where} ORDER BY published_at DESC LIMIT ? OFFSET ?', [*values, page_size, offset]):
      media = [dict(id=item['id'], kind=item['kind'], localUrl='/media/' + item['relative_path'].removeprefix('media/'), originalUrl=item['original_url'], bytes=item['bytes'], sha256=item['sha256']) for item in conn.execute('SELECT * FROM media WHERE post_id = ?', (row['id'],))]
      posts.append(dict(id=row['id'], author=row['author'], publishedAt=row['published_at'], sourceUrl=row['source_url'], originalUrl=row['original_url'], source=row['source'], text=row['text'], repostText=row['repost_text'], repostAuthor=row['repost_author'], capturedAt=row['captured_at'], tags=json.loads(row['tags_json']), expectedMediaCount=row['expected_media_count'], media=media))
    used = conn.execute('SELECT COALESCE(SUM(bytes), 0) FROM media').fetchone()[0]
  return {'posts': posts, 'page': page, 'pageSize': page_size, 'total': total, 'stats': {'mediaBytes': used, 'freeBytes': shutil.disk_usage(DATA).free}}

class Handler(SimpleHTTPRequestHandler):
  def send_json(self, status, payload):
    data = json.dumps(payload, ensure_ascii=False).encode('utf-8'); self.send_response(status); self.send_header('Content-Type', 'application/json; charset=utf-8'); self.send_header('Content-Length', str(len(data))); self.end_headers(); self.wfile.write(data)
  def do_GET(self):
    path = unquote(urlparse(self.path).path)
    if path == '/api/posts':
      query = urlparse(self.path).query
      values = dict(item.split('=', 1) for item in query.split('&') if '=' in item)
      self.send_json(HTTPStatus.OK, library(values.get('page', 1), values.get('pageSize', 20), unquote(values.get('q', '')), values.get('media', 'all'))); return
    if path == '/api/jobs':
      query = urlparse(self.path).query
      values = dict(item.split('=', 1) for item in query.split('&') if '=' in item)
      state = values.get('state', 'queued')
      if state not in ('queued', 'captured', 'skipped_deleted', 'failed'): self.send_json(HTTPStatus.BAD_REQUEST, {'error': 'Invalid job state'}); return
      limit = min(100, max(1, int(values.get('limit', 20))))
      with connect() as conn:
        jobs = [dict(sourceUrl=row['source_url'], favoritePage=row['favorite_page'], state=row['state'], attempts=row['attempts'], lastError=row['last_error']) for row in conn.execute('SELECT * FROM capture_jobs WHERE state=? ORDER BY favorite_page, discovered_at LIMIT ?', (state, limit))]
      self.send_json(HTTPStatus.OK, {'jobs': jobs}); return
    if path.startswith('/media/'):
      try: file = local_path('media/' + path.removeprefix('/media/'))
      except ValueError: self.send_error(HTTPStatus.NOT_FOUND); return
      if not file.is_file(): self.send_error(HTTPStatus.NOT_FOUND); return
      data = file.read_bytes(); self.send_response(HTTPStatus.OK); self.send_header('Content-Type', mimetypes.guess_type(file.name)[0] or 'application/octet-stream'); self.send_header('Content-Length', str(len(data))); self.end_headers(); self.wfile.write(data); return
    target = BUILD / (path.lstrip('/') or 'index.html')
    if not target.is_file(): target = BUILD / 'index.html'
    if not target.is_file(): self.send_error(HTTPStatus.SERVICE_UNAVAILABLE, 'Run the site build first.'); return
    self.path = '/' + str(target.relative_to(BUILD)); return super().do_GET()
  def do_POST(self):
    if urlparse(self.path).path == '/api/captured':
      try:
        body = json.loads(self.rfile.read(int(self.headers.get('Content-Length', '0')))); post = body['post']
        required = ('id', 'author', 'publishedAt', 'sourceUrl', 'source', 'text', 'capturedAt')
        if not all(isinstance(post.get(key), str) and post[key] for key in required): raise ValueError
        expected = post['expectedMediaCount']
        if isinstance(expected, bool) or not isinstance(expected, int) or expected < 0: raise ValueError
        media_items = post.get('media', [])
        if not isinstance(media_items, list) or len(media_items) != expected: raise ValueError('Incomplete media manifest')
        if len({item.get('id') for item in media_items}) != len(media_items): raise ValueError('Duplicate media id')
      except (KeyError, ValueError, json.JSONDecodeError): self.send_json(HTTPStatus.BAD_REQUEST, {'error': 'Invalid captured post'}); return
      stale_paths = []
      with connect() as conn:
        tombstone = conn.execute('SELECT 1 FROM local_tombstones WHERE source_url=?', (post['sourceUrl'],)).fetchone()
        existing = conn.execute('SELECT 1 FROM posts WHERE id=? OR source_url=?', (post['id'], post['sourceUrl'])).fetchone()
        if tombstone or existing:
          self.send_json(HTTPStatus.OK, {'skipped': post['sourceUrl'], 'reason': 'locally_deleted' if tombstone else 'already_archived'}); return
        conn.execute('INSERT INTO posts (id,author,published_at,source_url,source,text,repost_text,repost_author,captured_at,tags_json,is_favorited,last_seen_at,original_url,expected_media_count) VALUES (?,?,?,?,?,?,?,?,?,?,1,CURRENT_TIMESTAMP,?,?)', (post['id'], post['author'], post['publishedAt'], post['sourceUrl'], post['source'], post['text'], post.get('repostText'), post.get('repostAuthor'), post['capturedAt'], json.dumps(post.get('tags', []), ensure_ascii=False), post.get('originalUrl'), expected))
        for media in media_items:
          if media.get('kind') not in ('image', 'video-thumbnail'): raise ValueError('Invalid media kind')
          path = local_path(media['path'])
          if not path.is_file(): raise ValueError('Missing downloaded media')
          checksum = hashlib.sha256(path.read_bytes()).hexdigest()
          conn.execute('INSERT INTO media (id,post_id,kind,relative_path,original_url,bytes,sha256,downloaded_at) VALUES (?,?,?,?,?,?,?,CURRENT_TIMESTAMP) ON CONFLICT(id) DO UPDATE SET post_id=excluded.post_id,kind=excluded.kind,relative_path=excluded.relative_path,original_url=excluded.original_url,bytes=excluded.bytes,sha256=excluded.sha256,downloaded_at=CURRENT_TIMESTAMP', (media['id'], post['id'], media['kind'], media['path'], media['originalUrl'], path.stat().st_size, checksum))
        manifest = {item['id'] for item in media_items}
        placeholders = ','.join('?' * len(manifest))
        query = f'SELECT id,relative_path FROM media WHERE post_id=? AND id NOT IN ({placeholders})' if manifest else 'SELECT id,relative_path FROM media WHERE post_id=?'
        stale = conn.execute(query, [post['id'], *manifest]).fetchall()
        stale_paths = [item['relative_path'] for item in stale]
        if stale: conn.executemany('DELETE FROM media WHERE id=?', [(item['id'],) for item in stale])
        conn.execute("UPDATE capture_jobs SET state='captured', attempts=attempts+1, updated_at=CURRENT_TIMESTAMP WHERE source_url=?", (post['sourceUrl'],))
      # A post is immutable once archived. This cleanup only protects against
      # malformed duplicate media entries within a single initial import.
      for value in stale_paths:
        with connect() as conn:
          still_used = conn.execute('SELECT 1 FROM media WHERE relative_path=?', (value,)).fetchone()
        if not still_used:
          try: local_path(value).unlink(missing_ok=True)
          except ValueError: pass
      self.send_json(HTTPStatus.OK, {'captured': post['id']}); return
    if urlparse(self.path).path == '/api/queue':
      try:
        body = json.loads(self.rfile.read(int(self.headers.get('Content-Length', '0')))); page = int(body.get('favoritePage', 1)); urls = list(dict.fromkeys(url for url in body.get('urls', []) if isinstance(url, str) and url.startswith('https://weibo.com/')))
        if not urls: raise ValueError
      except (ValueError, json.JSONDecodeError): self.send_json(HTTPStatus.BAD_REQUEST, {'error': 'Invalid queue request'}); return
      with connect() as conn:
        capture_urls, new_count = [], 0
        for url in urls:
          conn.execute('''INSERT INTO favorite_observations (source_url,last_favorite_page) VALUES (?,?) ON CONFLICT(source_url) DO UPDATE SET last_seen_at=CURRENT_TIMESTAMP,last_favorite_page=excluded.last_favorite_page,sightings=sightings+1''', (url, page))
          tombstone = conn.execute('SELECT 1 FROM local_tombstones WHERE source_url=?', (url,)).fetchone()
          if tombstone: continue
          row = conn.execute('SELECT state FROM capture_jobs WHERE source_url=?', (url,)).fetchone()
          if row is None:
            conn.execute('INSERT INTO capture_jobs (source_url, favorite_page) VALUES (?, ?)', (url, page))
            capture_urls.append(url); new_count += 1
          else:
            conn.execute('UPDATE capture_jobs SET favorite_page=?, updated_at=CURRENT_TIMESTAMP WHERE source_url=?', (page, url))
            if row['state'] == 'queued': capture_urls.append(url)
        pending = conn.execute("SELECT COUNT(*) FROM capture_jobs WHERE state='queued'").fetchone()[0]
      self.send_json(HTTPStatus.OK, {'queued': len(capture_urls), 'newCount': new_count, 'pending': pending, 'captureUrls': capture_urls}); return
    if urlparse(self.path).path == '/api/job':
      try:
        body = json.loads(self.rfile.read(int(self.headers.get('Content-Length', '0')))); url = body['sourceUrl']; state = body['state']; detail = body.get('detail')
        if not isinstance(url, str) or not url.startswith('https://weibo.com/') or state not in ('queued', 'skipped_deleted', 'failed') or (detail is not None and not isinstance(detail, str)): raise ValueError
      except (KeyError, ValueError, json.JSONDecodeError): self.send_json(HTTPStatus.BAD_REQUEST, {'error': 'Invalid job update'}); return
      with connect() as conn:
        conn.execute('UPDATE capture_jobs SET state=?, attempts=attempts+1, last_error=?, updated_at=CURRENT_TIMESTAMP WHERE source_url=?', (state, detail, url))
      self.send_json(HTTPStatus.OK, {'updated': url, 'state': state}); return
    if urlparse(self.path).path != '/api/delete': self.send_error(HTTPStatus.NOT_FOUND); return
    try:
      body = json.loads(self.rfile.read(int(self.headers.get('Content-Length', '0')))); ids = list(dict.fromkeys(item for item in body.get('ids', []) if isinstance(item, str)))
      if not ids: raise ValueError
    except (ValueError, json.JSONDecodeError): self.send_json(HTTPStatus.BAD_REQUEST, {'error': 'Invalid delete request'}); return
    marks = ','.join('?' * len(ids))
    with connect() as conn:
      deleted_posts = conn.execute(f'SELECT id,source_url FROM posts WHERE id IN ({marks})', ids).fetchall()
      paths = [row['relative_path'] for row in conn.execute(f'SELECT relative_path FROM media WHERE post_id IN ({marks})', ids)]
      conn.executemany('''INSERT INTO local_tombstones (source_url,post_id) VALUES (?,?) ON CONFLICT(source_url) DO UPDATE SET post_id=excluded.post_id,deleted_at=CURRENT_TIMESTAMP,reason='local_delete' ''', [(row['source_url'], row['id']) for row in deleted_posts])
      conn.execute(f'DELETE FROM posts WHERE id IN ({marks})', ids)
      for value in paths:
        try: local_path(value).unlink(missing_ok=True)
        except ValueError: pass
    self.send_json(HTTPStatus.OK, {'deleted': len(ids)})

def main():
  parser = argparse.ArgumentParser(); parser.add_argument('--port', type=int, default=4319); args = parser.parse_args(); initialize(); print(f'Offline library: http://127.0.0.1:{args.port}'); ThreadingHTTPServer(('127.0.0.1', args.port), Handler).serve_forever()
if __name__ == '__main__': main()

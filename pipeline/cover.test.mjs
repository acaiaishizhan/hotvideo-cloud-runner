import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureCoverFile, uploadRequestedCover } from './cover.mjs';
import { isAttachmentUploadAccepted } from './publish.mjs';

const config = { feishuCoverField: '封面', videoInfraCmd: 'python', videoInfraArgs: ['-m', 'video_infra'] };

test('首选封面明确 404 后使用同作品已解析封面，网络故障不盲目切换', t => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cover-fallback-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const meta={scraped:{thumbnailUrl:'https://cdn.example/uhd.jpg'},thumbnailUrl:'https://cdn.example/max.jpg'};
  const calls=[];
  const file=path.join(dir,'cover.jpg');
  ensureCoverFile(meta,config,dir,(_cmd,args)=>{
    calls.push(args[3]);
    if(calls.length===1)throw Error('404 Client Error');
    fs.writeFileSync(file,Buffer.alloc(200));
    return JSON.stringify({ok:true,files:{thumbnailPath:file}});
  });
  assert.deepEqual(calls,['https://cdn.example/uhd.jpg','https://cdn.example/max.jpg']);
  let attempts=0;
  assert.throws(()=>ensureCoverFile({scraped:{thumbnailUrl:'https://cdn.example/uhd.jpg'},thumbnailUrl:'https://cdn.example/max.jpg'},config,dir,()=>{attempts++;throw Error('HTTP 503');}),/503/);
  assert.equal(attempts,1);
});
test('saved cover is reused without accessing an expired URL', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hotvideo-cover-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'cover.jpg');
  fs.writeFileSync(file, Buffer.alloc(200));
  assert.equal(ensureCoverFile({ files: { thumbnailPath: file } }, config, dir,
    () => { throw Error('must not call downloader'); }), file);
});
test('download uses fresh scraped cover and preserves the video file', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hotvideo-cover-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'cover.jpg');
  const meta = { thumbnailUrl: 'old', scraped: { thumbnailUrl: 'https://example.com/fresh' }, files: { videoPath: 'video.mp4' } };
  ensureCoverFile(meta, config, dir, (cmd, args) => {
    assert.equal(cmd, 'python');
    assert.deepEqual(args.slice(0, 4), ['-m', 'video_infra', 'thumbnail', 'https://example.com/fresh']);
    fs.writeFileSync(file, Buffer.alloc(200));
    return JSON.stringify({ ok: true, files: { thumbnailPath: file } });
  });
  assert.equal(meta.files.videoPath, 'video.mp4');
  assert.equal(meta.files.thumbnailPath, file);
});
test('existing remote cover prevents duplicate upload even after local receipt is lost', () => {
  const meta = { cover_requested: true };
  uploadRequestedCover(meta, { config, recordId: 'rec',
    readAttachment: () => ({ attachmentKnown: true, hasAttachment: true }),
    download: () => { throw Error('must not download'); },
    uploadAttachment: () => { throw Error('must not upload'); },
  });
  assert.equal(meta.cover_uploaded, true);
});
test('nested CLI attachment receipt is accepted without depending on immediate list visibility', () => {
  const meta = { cover_requested: true };
  uploadRequestedCover(meta, { config, recordId: 'rec',
    readAttachment: () => ({ attachmentKnown: true, hasAttachment: false }),
    download: () => 'cover.jpg',
    uploadAttachment: () => ({ ok: true, data: { attachments: { rec: { field: [{ file_token: 'file' }] } } } }),
    accepted: isAttachmentUploadAccepted,
  });
  assert.equal(meta.cover_uploaded, true);
});
test('unknown remote state stops writes and records a recoverable failure', () => {
  const meta = { cover_requested: true };
  assert.throws(() => uploadRequestedCover(meta, { config,
    readAttachment: () => ({ attachmentKnown: false }),
    uploadAttachment: () => { throw Error('must not upload'); },
  }), /状态未知/);
  assert.equal(meta.cover_uploaded, false);
  assert.match(meta.cover_error, /状态未知/);
});
test('legacy metadata does not trigger an implicit historical backfill', () => {
  assert.equal(uploadRequestedCover({}, { config, readAttachment: () => { throw Error('must not read'); } }), false);
});
